import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { DeliveryWorker, inventory, requestPrompt } from '../src/delivery.js'
import { Store } from '../src/store.js'
import type { Agent } from '../src/model.js'

const workers: DeliveryWorker[] = []
const stores: Store[] = []
const directories: string[] = []
const envKeys = ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID'] as const
let savedEnv: (string | undefined)[]
let errors: ReturnType<typeof spyOn>

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  process.env.HERDR_ENV = '1'
  process.env.HERDR_SOCKET_PATH = '/tmp/delivery-test.sock'
  process.env.HERDR_PANE_ID = 'pane'
  errors = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
  mock.restore()
})

function open(path: string) {
  const store = new Store(path)
  stores.push(store)
  return store
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-delivery-'))
  directories.push(directory)
  const path = join(directory, 'coordination.sqlite')
  const store = open(path)
  const agent = store.observeAgent({ sessionId: 'recipient', socket: '/tmp/delivery-test.sock', paneId: 'pane',
    terminalId: 'terminal', workspaceId: 'workspace', directory: '/project', label: 'Not a persona',
    state: 'idle', lastSeen: Date.now() })
  const runtime: Record<string, unknown> = { id: agent.sessionId, directory: agent.directory,
    agent: 'reviewer', model: { providerID: 'provider', id: 'current-model', variant: 'high' } }
  const messages: { info: Record<string, unknown>; parts: unknown[] }[] = []
  const receipts = new Map<string, unknown>()
  const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) })
  const session = {
    get: mock(async () => ok(runtime)),
    status: mock(async () => ok({ recipient: { type: 'idle' } })),
    messages: mock(async () => ok(messages)),
    message: mock(async ({ path }: { path: { id: string; messageID: string } }) => receipts.has(path.messageID)
      ? ok(receipts.get(path.messageID)) : { error: { name: 'NotFoundError' }, response: new Response(null, { status: 404 }) }),
    promptAsync: mock(async (input: { path: { id: string }; body: { messageID: string; parts: unknown[] } }) => {
      receipts.set(input.body.messageID, { info: { role: 'user', id: input.body.messageID, sessionID: input.path.id }, parts: input.body.parts })
      return ok(undefined)
    }),
  }
  const config = { get: mock(async () => ok({ model: 'configured/vendor/model' })) }
  const client = { session, config } as unknown as PluginInput['client']
  const discover = mock(async (): Promise<Agent[]> => [agent])
  const publish = mock(async () => true)
  const worker = (connection = store) => {
    const result = new DeliveryWorker(connection, client, '/project', discover, publish)
    workers.push(result)
    return result
  }
  const enqueue = () => store.enqueue({ originSessionId: 'origin', originDirectory: '/origin', recipientId: agent.id,
    kind: 'task', text: 'Private task content', idempotencyKey: crypto.randomUUID() })
  const notice = (text = 'Result ready', directory = '/project') => store.scheduleNotice(crypto.randomUUID(), 'result', agent.sessionId, directory, text)
  return { store, path, agent, runtime, messages, receipts, session, config, discover, publish, worker, enqueue, notice, ok }
}

function pane(agent: Agent) {
  return { agent: 'opencode', agent_session: { agent: 'opencode', kind: 'id', value: agent.sessionId },
    pane_id: agent.paneId, terminal_id: agent.terminalId, workspace_id: agent.workspaceId,
    cwd: agent.directory, name: agent.label, agent_status: agent.state }
}

test('inventory preserves two unaffected agents around a changed stored binding', async () => {
  const f = fixture()
  const first = f.store.observeAgent({ ...f.agent, sessionId: 'first', paneId: 'first-pane', terminalId: 'first-terminal' })
  const last = f.store.observeAgent({ ...f.agent, sessionId: 'last', paneId: 'last-pane', terminalId: 'last-terminal' })
  const env = { HERDR_ENV: '1', HERDR_SOCKET_PATH: f.agent.socket }
  const runner = mock(async () => ({ stdout: JSON.stringify({ result: { agents: [
    pane({ ...first, state: 'working' }), pane({ ...f.agent, paneId: 'changed-pane' }), pane({ ...last, state: 'done' }),
  ] } }), stderr: '' }))
  const agents = await inventory(f.store, env, runner)
  expect(agents.map(a => [a.id, a.state])).toEqual([[first.id, 'working'], [last.id, 'done']])
  expect(f.store.agent(f.agent.id)).toEqual(f.agent)
  expect(f.store.agent(first.id).state).toBe('working')
  expect(f.store.agent(last.id).state).toBe('done')
  expect(runner).toHaveBeenCalledTimes(1)
  expect(runner).toHaveBeenCalledWith('herdr', ['agent', 'list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env })
})

test.each([false, true])('inventory excludes both conflicting same-session candidates, changed first: %j', async changedFirst => {
  const f = fixture()
  const candidates = [pane(f.agent), pane({ ...f.agent, terminalId: 'changed-terminal' })]
  if (changedFirst) candidates.reverse()
  const runner = mock(async () => ({ stdout: JSON.stringify({ result: { agents: candidates } }), stderr: '' }))
  expect(await inventory(f.store, process.env, runner)).toEqual([])
  expect(f.store.agent(f.agent.id)).toEqual({ ...f.agent, lastSeen: expect.any(Number) })
  expect(runner).toHaveBeenCalledTimes(1)
})

test('inventory excludes conflicting candidates even for a newly observed session', async () => {
  const f = fixture()
  const fresh = { ...f.agent, sessionId: 'new-session' }
  const runner = mock(async () => ({ stdout: JSON.stringify({ result: { agents: [
    pane(fresh), pane({ ...fresh, paneId: 'other-pane' }),
  ] } }), stderr: '' }))
  expect(await inventory(f.store, process.env, runner)).toEqual([])
})

test('inventory propagates Store corruption instead of treating it as a binding conflict', async () => {
  const f = fixture()
  const db = new Database(f.path)
  try { db.query('UPDATE agents SET state=? WHERE id=?').run('', f.agent.id) }
  finally { db.close() }
  const runner = mock(async () => ({ stdout: JSON.stringify({ result: { agents: [pane(f.agent)] } }), stderr: '' }))
  await expect(inventory(f.store, process.env, runner)).rejects.toThrow('Invalid agent state: expected nonblank text')
  expect(() => f.store.agent(f.agent.id)).toThrow('Invalid agent state: expected nonblank text')
  expect(runner).toHaveBeenCalledTimes(1)
})

test('two workers on separate real SQLite connections claim exactly one dispatch', async () => {
  const f = fixture()
  const request = f.enqueue()
  const next = f.enqueue()
  await Promise.all([f.worker().tick(), f.worker(open(f.path)).tick()])
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(f.store.request(request.id).state).toBe('submitted')
  expect(f.store.request(next.id).state).toBe('queued')
  expect(f.store.history(request.id, 'origin').audit.filter(e => e.transition === 'attempt:1')).toHaveLength(1)
})

test('current runtime settings override history and preserve model variant', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.messages.push({ info: { role: 'user', agent: 'old', model: { providerID: 'old', modelID: 'old' } }, parts: [] })
  await f.worker().tick()
  const input = f.session.promptAsync.mock.calls[0][0]
  expect(input).toMatchObject({ path: { id: 'recipient' }, query: { directory: '/project' },
    body: { agent: 'reviewer', model: { providerID: 'provider', modelID: 'current-model' }, variant: 'high',
      parts: [{ type: 'text', text: requestPrompt(request) }] } })
  expect(input.body).not.toHaveProperty('noReply')
  expect(f.session.messages).not.toHaveBeenCalled()
  expect(f.config.get).not.toHaveBeenCalled()
})

test.each(['top-level', 'model'])('legacy history fallback uses newest user, including %s variant', async placement => {
  const f = fixture()
  delete f.runtime.agent
  delete f.runtime.model
  f.messages.push({ info: { role: 'user', agent: 'old', model: { providerID: 'old', modelID: 'old' } }, parts: [] })
  f.messages.push({ info: { role: 'user', agent: 'latest', model: { providerID: 'new', modelID: 'selected',
    ...(placement === 'model' ? { variant: 'max' } : {}) }, ...(placement === 'top-level' ? { variant: 'max' } : {}) }, parts: [] })
  for (let i = 0; i < 30; i++) f.messages.push({ info: { role: 'assistant' }, parts: [] })
  f.enqueue()
  await f.worker().tick()
  expect(f.session.promptAsync.mock.calls[0][0].body).toMatchObject({ agent: 'latest', model: { providerID: 'new', modelID: 'selected' }, variant: 'max' })
  expect(f.session.messages.mock.calls[0][0]).not.toHaveProperty('query.limit')
})

test('partial current settings never get replaced by history', async () => {
  const f = fixture()
  delete f.runtime.agent
  f.messages.push({ info: { role: 'user', agent: 'history-agent', model: { providerID: 'old', modelID: 'old' }, variant: 'old' }, parts: [] })
  f.enqueue()
  await f.worker().tick()
  expect(f.session.promptAsync.mock.calls[0][0].body).toMatchObject({ agent: 'history-agent', model: { providerID: 'provider', modelID: 'current-model' }, variant: 'high' })
})

test('empty session uses its explicit agent and configured default model', async () => {
  const f = fixture()
  delete f.runtime.model
  f.enqueue()
  await f.worker().tick()
  expect(f.session.promptAsync.mock.calls[0][0].body).toMatchObject({ agent: 'reviewer', model: { providerID: 'configured', modelID: 'vendor/model' } })
  expect(f.config.get.mock.calls[0][0]).toMatchObject({ query: { directory: '/project' } })
})

test('empty session without an explicit agent remains queued, never using the pane label', async () => {
  const f = fixture()
  delete f.runtime.agent
  delete f.runtime.model
  const request = f.enqueue()
  await f.worker().tick()
  expect(f.store.request(request.id).state).toBe('queued')
  expect(f.session.promptAsync).not.toHaveBeenCalled()
  expect(f.config.get).not.toHaveBeenCalled()
})

test.each(['', 'model-without-provider', 'provider/'])('empty session refuses unusable configured model %j', async model => {
  const f = fixture()
  delete f.runtime.model
  f.config.get.mockImplementation(async () => f.ok({ model }))
  const request = f.enqueue()
  await f.worker().tick()
  expect(f.store.request(request.id).state).toBe('queued')
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('invalid current settings fail closed rather than silently reverting to history', async () => {
  const f = fixture()
  f.runtime.model = { providerID: 'provider', modelID: 'wrong-runtime-schema' }
  f.messages.push({ info: { role: 'user', agent: 'old', model: { providerID: 'old', modelID: 'old' } }, parts: [] })
  const request = f.enqueue()
  await f.worker().tick()
  expect(f.store.request(request.id).state).toBe('queued')
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test.each(['working', 'blocked', 'unknown'])('Herdr %s state refuses prompts and notices', async state => {
  const f = fixture()
  f.agent.state = state
  f.enqueue()
  f.notice()
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test.each(['busy', 'retry'])('SDK %s state refuses prompts and notices', async type => {
  const f = fixture()
  f.session.status.mockImplementation(async () => f.ok({ recipient: { type } }))
  f.enqueue()
  f.notice()
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('status is reread after settings immediately before dispatch', async () => {
  const f = fixture()
  f.session.status.mockImplementationOnce(async () => f.ok({}))
    .mockImplementation(async () => f.ok({ recipient: { type: 'busy' } }))
  const request = f.enqueue()
  await f.worker().tick()
  expect(f.session.status).toHaveBeenCalledTimes(2)
  expect(f.store.request(request.id).state).toBe('queued')
})

test('missing status response is not evidence of idleness', async () => {
  const f = fixture()
  f.session.status.mockImplementation(async () => f.ok(undefined))
  f.enqueue()
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('cancellation during preflight prevents the claim and leaves notices pending', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.notice()
  f.session.status.mockImplementationOnce(async () => {
    f.store.cancel(request.id, 'origin')
    return f.ok({})
  })
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
  expect(f.store.notices()[0].state).toBe('pending')
})

test.each(['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID'])('requires the current process %s binding', async key => {
  const f = fixture()
  f.enqueue()
  process.env[key] = 'different'
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
  expect(f.publish).not.toHaveBeenCalled()
})

test.each(['id', 'machineId', 'sessionId', 'socket', 'paneId', 'terminalId', 'workspaceId', 'directory'])('refuses mismatched live %s', async key => {
  const f = fixture()
  f.enqueue()
  f.discover.mockImplementation(async () => [{ ...f.agent, [key]: '/different' }])
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('refuses ambiguous inventory and a changed live recipient during settings lookup', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.discover.mockImplementationOnce(async () => [f.agent, { ...f.agent }])
  const worker = f.worker()
  await worker.tick()
  f.discover.mockImplementationOnce(async () => [f.agent])
    .mockImplementation(async () => [{ ...f.agent, sessionId: 'replacement' }])
  await worker.tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
  expect(f.store.request(request.id).state).toBe('queued')
})

test.each(['id', 'directory'])('refuses mismatched session %s', async key => {
  const f = fixture()
  f.runtime[key] = 'different'
  f.enqueue()
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('prompt timeout is never resent, including after restart, and exact receipt recovers it', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.session.promptAsync.mockImplementation(async () => { throw new DOMException('Private task content', 'TimeoutError') })
  const first = f.worker()
  await first.tick()
  const attempted = f.store.request(request.id)
  expect(attempted.state).toBe('unknown')
  await first.dispose()
  const restarted = f.worker(open(f.path))
  await restarted.tick()
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  f.receipts.set(attempted.messageId!, { info: { role: 'user', id: attempted.messageId, sessionID: 'recipient' },
    parts: [{ type: 'text', text: requestPrompt(request) }] })
  await restarted.tick()
  expect(f.store.request(request.id).state).toBe('submitted')
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(errors.mock.calls)).not.toContain('Private task content')
})

test('successful prompt with unavailable readback remains unknown until receipt recovery', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.session.message.mockImplementationOnce(async () => { throw new Error('readback offline') })
  const worker = f.worker()
  await worker.tick()
  expect(f.store.request(request.id).state).toBe('unknown')
  await worker.tick()
  expect(f.store.request(request.id).state).toBe('submitted')
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
})

test('receipt requires exact message, session, user role and text; transport failure is not absence', async () => {
  const f = fixture()
  const worker = f.worker()
  expect(await worker.receipt('recipient', 'msg', 'expected')).toBe(false)
  const info = { id: 'msg', sessionID: 'recipient', role: 'user' }
  for (const changed of [{ id: 'other' }, { sessionID: 'other' }, { role: 'assistant' }]) {
    f.receipts.set('msg', { info: { ...info, ...changed }, parts: [{ type: 'text', text: 'expected' }] })
    expect(await worker.receipt('recipient', 'msg', 'expected')).toBe(false)
  }
  f.receipts.set('msg', { info, parts: [{ type: 'text', text: 'other' }] })
  expect(await worker.receipt('recipient', 'msg', 'expected')).toBe(false)
  f.session.message.mockImplementation(async () => ({ error: {}, response: new Response(null, { status: 503 }) }))
  await expect(worker.receipt('recipient', 'msg', 'expected')).rejects.toThrow('unavailable')
})

test('failed sidebar publication does not prevent dispatch', async () => {
  const f = fixture()
  const request = f.enqueue()
  f.publish.mockImplementation(async () => { throw new Error('metadata unavailable') })
  await f.worker().tick()
  expect(f.store.request(request.id).state).toBe('submitted')
})

test('queued prompt and notice cannot dispatch in the same scan', async () => {
  const f = fixture()
  f.enqueue()
  f.notice()
  const worker = f.worker()
  await worker.tick()
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(f.store.notices()[0].state).toBe('pending')
  f.session.status.mockImplementation(async () => f.ok({ recipient: { type: 'busy' } }))
  await worker.tick()
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
})

test('notice outbox retries preflight failure, claims once, and recovers unknown without replay', async () => {
  const f = fixture()
  const notice = f.notice()
  const next = f.notice('Next notice')
  const worker = f.worker()
  f.session.get.mockImplementationOnce(async () => { throw new Error('offline') })
  await worker.tick()
  expect(f.store.notices()[0].state).toBe('pending')
  f.session.promptAsync.mockImplementation(async () => { throw new DOMException('lost response', 'TimeoutError') })
  await Promise.all([worker.tick(), f.worker(open(f.path)).tick()])
  await worker.tick()
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  const attempted = f.store.notices().find(n => n.id === notice.id)!
  expect(attempted.state).toBe('unknown')
  f.receipts.set(attempted.messageId!, { info: { role: 'user', id: attempted.messageId, sessionID: 'recipient' },
    parts: [{ type: 'text', text: notice.text }] })
  await worker.tick()
  expect(f.store.notices().find(n => n.id === notice.id)?.state).toBe('delivered')
  expect(f.store.notices().find(n => n.id === next.id)?.state).toBe('pending')
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
})

test('notice directory must match the live conversation', async () => {
  const f = fixture()
  f.notice('Wrong target', '/other')
  await f.worker().tick()
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('notices use regular idle-only prompts, one per scan with fresh status checks', async () => {
  const f = fixture()
  f.notice()
  f.notice('Second result')
  const worker = f.worker()
  await worker.tick()
  expect(f.store.notices().map(n => n.state)).toEqual(['delivered', 'pending'])
  expect(f.session.status).toHaveBeenCalledTimes(2)
  expect(f.session.promptAsync.mock.calls[0][0].body).not.toHaveProperty('noReply')
  f.session.status.mockImplementationOnce(async () => f.ok({}))
    .mockImplementationOnce(async () => f.ok({ recipient: { type: 'busy' } }))
  await worker.tick()
  expect(f.session.promptAsync).toHaveBeenCalledTimes(1)
  await worker.tick()
  expect(f.store.notices().map(n => n.state)).toEqual(['delivered', 'delivered'])
  expect(f.session.promptAsync).toHaveBeenCalledTimes(2)
})

test('tick coalesces, start is idempotent, dispose waits and prevents delayed dispatch', async () => {
  const f = fixture()
  f.enqueue()
  let release!: (agents: Agent[]) => void
  f.discover.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const interval = spyOn(globalThis, 'setInterval')
  const clear = spyOn(globalThis, 'clearInterval')
  const worker = f.worker()
  worker.start()
  worker.start()
  expect(interval).toHaveBeenCalledTimes(1)
  expect(worker.tick()).toBe(worker.tick())
  let disposed = false
  const disposal = worker.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release([f.agent])
  await disposal
  expect(clear).toHaveBeenCalledTimes(1)
  await worker.tick()
  worker.start()
  expect(interval).toHaveBeenCalledTimes(1)
  expect(f.discover).toHaveBeenCalledTimes(1)
  expect(f.session.promptAsync).not.toHaveBeenCalled()
})

test('repeated errors are throttled and do not retain a rejected active tick', async () => {
  const f = fixture()
  f.discover.mockImplementation(async () => { throw new Error('sensitive payload') })
  const worker = f.worker()
  await worker.tick()
  await worker.tick()
  expect(f.discover).toHaveBeenCalledTimes(2)
  expect(errors).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(errors.mock.calls)).not.toContain('sensitive payload')
})
