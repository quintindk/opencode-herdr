import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import type { Agent, Operation } from '../src/model.js'
import { Store } from '../src/store.js'
import { Provisioner, type OpenInput, type ProvisionRunner } from '../src/provision.js'

const directories: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Model the required atomic Store API. Real cross-connection CAS/dispatch tests belong
// to Store's owner; no production fallback simulates atomicity with read/update pairs.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'herdr-provision-'))
  directories.push(root)
  const folder = join(root, 'project')
  mkdirSync(folder)
  const operations: Operation[] = []
  const agents: Agent[] = []
  const keys = new Map<string, string>()
  let pending = false
  const store = {
    machineId: 'machine',
    beginOperation(kind: string, originSessionId: string, key: string, payload: Record<string, unknown>) {
      const scoped = JSON.stringify([kind, originSessionId, key])
      const existing = operations.find(op => op.id === keys.get(scoped))
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error('payload conflict')
        return structuredClone(existing)
      }
      const op = { id: `operation-${operations.length + 1}`, kind, originSessionId, state: 'requested', payload, createdAt: 1, updatedAt: 1 }
      operations.push(op)
      keys.set(scoped, op.id)
      return structuredClone(op)
    },
    updateOperation(id: string, state: string, result: Record<string, unknown>) {
      const op = operations.find(op => op.id === id)!
      if (op.kind === 'open_agent' && op.result?.sessionId !== undefined &&
          (state !== 'ready' || ['sessionId', 'identity', 'paneId', 'terminalId', 'workspaceId', 'destination', 'launchAttempted'].some(key => result[key] !== op.result![key]))) throw new Error('Verified provision binding is immutable')
      Object.assign(op, { state, result: structuredClone(result) })
      return structuredClone(op)
    },
    operations(origin: string) { return structuredClone(operations.filter(op => op.originSessionId === origin)) },
    claimOperation(id: string, expected: string, next: string) {
      const op = operations.find(op => op.id === id)!
      if (op.state !== expected) return false
      if (op.kind === 'close_agent' && (pending || store.closingAgent(op.payload.identity as string))) return false
      op.state = next
      return true
    },
    closingAgent(identity: string) {
      return operations.some(op => op.kind === 'close_agent' && op.payload.identity === identity && ['authorising', 'uncertain'].includes(op.state))
    },
    observeAgent(input: Omit<Agent, 'id' | 'machineId'>) {
      const previous = agents.find(agent => agent.sessionId === input.sessionId)
      const agent = { ...input, id: previous?.id ?? `identity-${agents.length + 1}`, machineId: 'machine' }
      if (previous) Object.assign(previous, agent)
      else agents.push(agent)
      return agent
    },
    bindProvision(id: string, input: Parameters<Store['bindProvision']>[1]) {
      const op = operations.find(op => op.id === id)!
      const saved = op.result!
      if (op.kind !== 'open_agent' || saved.launchAttempted !== true) throw new Error('Binding requires persisted launch intent')
      if (saved.expectedSessionId !== input.sessionId) throw new Error('Provision session differs from created session')
      if (input.socket !== op.payload.socket || input.paneId !== saved.paneId || input.terminalId !== saved.terminalId ||
          input.workspaceId !== saved.workspaceId || input.directory !== saved.destination) throw new Error('Provision binding differs from saved launch target')
      const management = op.payload.management as Agent['management']
      const manager = management === 'managed' ? op.originSessionId : undefined
      if ((input.management !== undefined && input.management !== management) ||
          (input.managerSessionId !== undefined && input.managerSessionId !== manager)) throw new Error('Provision management differs from saved intent')
      if (saved.sessionId !== undefined || saved.identity !== undefined) {
        if (op.state !== 'ready' || saved.sessionId !== input.sessionId) throw new Error('Provision operation is already bound to another conversation')
        return store.agent(saved.identity as string)
      }
      if (op.state !== 'launching' && !(op.state === 'uncertain' && saved.effect === 'launch')) throw new Error('Provision is not awaiting launch verification')
      const previous = agents.find(agent => agent.sessionId === input.sessionId)
      if (previous && operations.some(other => other.id !== id && other.kind === 'open_agent' && other.result?.identity === previous.id)) throw new Error('Agent is already bound to another provision operation')
      if (previous?.management === 'managed' && previous.managerSessionId !== manager) throw new Error('Observation cannot change agent management')
      const agent = store.observeAgent({ ...input, management, ...(manager ? { managerSessionId: manager } : {}) })
      store.updateOperation(id, 'ready', { ...saved, identity: agent.id, sessionId: agent.sessionId, effect: null, error: null })
      return agent
    },
    agent(id: string) { const agent = agents.find(agent => agent.id === id); if (!agent) throw new Error('missing agent'); return agent },
    pending() { return pending ? { id: 'request' } : undefined },
    list() { return { inbox: [], outbox: [] } },
  }
  const env = { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/herdr.sock', HERDR_PANE_ID: 'parent:p1', HOME: root }
  const calls: { file: string; args: string[]; state?: string; options: unknown }[] = []
  const live = { agent: 'opencode', pane_id: 'child:p1', terminal_id: 'terminal', workspace_id: 'child', cwd: folder, agent_status: 'idle', agent_session: { agent: 'opencode', kind: 'id', value: 'child-session' } }
  let visible = true
  let failure = ''
  let hook: ((file: string, args: string[]) => Promise<void>) | undefined
  const run: ProvisionRunner = async (file, args, options) => {
    calls.push({ file, args, state: operations.at(-1)?.state, options })
    await hook?.(file, args)
    if (failure && args.join(' ').startsWith(failure)) throw new Error('secret-bearing stderr')
    let output: unknown
    if (file === 'opencode') return { stdout: 'build (primary)\nreview (subagent)\n', stderr: '' }
    if (file === 'git') {
      if (args.includes('--show-toplevel')) return { stdout: folder, stderr: '' }
      if (args.includes('check-ref-format')) return { stdout: args.at(-1)!, stderr: '' }
      if (args.includes('--verify')) return { stdout: 'a'.repeat(40), stderr: '' }
      if (args.includes('worktree')) { live.cwd = args.at(-2)!; mkdirSync(live.cwd, { recursive: true }) }
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'agent') output = { agents: visible ? [live] : [] }
    else if (args[0] === 'pane' && args[1] === 'list') output = { panes: visible ? [live] : [] }
    else if (args[0] === 'workspace' || args[0] === 'worktree') {
      const pathIndex = args.indexOf('--path')
      if (pathIndex !== -1) { live.cwd = args[pathIndex + 1]; mkdirSync(live.cwd, { recursive: true }) }
      output = { workspace: { workspace_id: 'child' }, root_pane: { ...live, agent_session: null }, worktree: { path: live.cwd } }
    } else if (args[1] === 'split' || args[1] === 'get') output = { pane: { ...live, agent_session: null } }
    else if (args[1] === 'close') { visible = false; output = {} }
    else output = {}
    return { stdout: JSON.stringify({ result: output }), stderr: '' }
  }
  const creates: { options: unknown; operation?: Operation }[] = []
  let createReply: unknown = { data: { id: 'child-session' } }
  const client = { session: { async create(options: unknown) {
    creates.push({ options, operation: structuredClone(operations.at(-1)) })
    if (failure === 'session_create') throw new Error('secret-bearing create response lost')
    return createReply
  } } } as unknown as PluginInput['client']
  const service = new Provisioner(store as unknown as Store, run, env, client)
  const asks: Parameters<ToolContext['ask']>[0][] = []
  const ctx: ToolContext = { sessionID: 'origin', messageID: 'message', agent: 'build', directory: folder, worktree: folder,
    abort: new AbortController().signal, metadata() {}, async ask(input) { asks.push(input) } }
  const input: OpenInput = { persona: 'build', folder, placement: 'pane', management: 'managed', idempotencyKey: 'open' }
  return { root, folder, input, store, service, operations, agents, calls, ctx, asks, live, env, run, client, creates,
    createReply(value: unknown) { createReply = value },
    fail(value: string) { failure = value }, visible(value: boolean) { visible = value }, pending(value: boolean) { pending = value },
    hook(value: typeof hook) { hook = value },
  }
}

test('requires atomic Store API rather than a check/update imitation', () => {
  expect(() => new Provisioner({} as Store)).toThrow('atomic Store.claimOperation')
})

test('missing session client refuses construction before any effects', () => {
  const f = fixture()
  expect(() => new Provisioner(f.store as unknown as Store, f.run, f.env)).toThrow('requires an OpenCode client')
  expect(f.operations).toEqual([])
  expect(f.calls).toEqual([])
  expect(f.creates).toEqual([])
})

test('persists intent and uncertainty before every creation/launch, then binds exact observed agent', async () => {
  const f = fixture()
  const op = await f.service.open(f.input, f.ctx)
  expect(op.state).toBe('ready')
  expect(op.payload.folder).toBe(f.folder)
  expect(op.result?.sessionId).toBe('child-session')
  expect(op.result?.expectedSessionId).toBe('child-session')
  expect(f.creates).toHaveLength(1)
  expect(f.creates[0].options).toEqual({ query: { directory: f.folder }, body: { title: op.result!.label }, throwOnError: true, signal: f.ctx.abort })
  expect(f.creates[0].operation?.state).toBe('uncertain')
  expect(f.creates[0].operation?.result?.effect).toBe('session_create')
  expect(f.creates[0].operation?.result?.workspaceId).toBe('child')
  expect(f.creates[0].operation?.result?.launchAttempted).toBeUndefined()
  expect(f.agents[0].management).toBe('managed')
  expect(f.agents[0].managerSessionId).toBe('origin')
  const effects = f.calls.filter(call => ['split', 'run'].includes(call.args[1]))
  expect(effects.map(call => call.state)).toEqual(['uncertain', 'uncertain'])
  const command = effects[1].args[3]
  expect(command).toContain('OPENCODE_CONFIG_CONTENT=')
  expect(command).toContain('/dist/index.js')
  expect(command).toContain("opencode --session 'child-session' --agent 'build' --prompt 'Initialise this conversation for Herdr coordination. No task has been assigned.")
  expect(command).toEndWith("Call list_requests to check your inbox, then wait for work. Do not edit files, commit, or close resources.'")
  expect(command).not.toMatch(/--auto|direnv|\.envrc/)
  expect(op.result?.identity).toBe(f.agents[0].id)
  expect(op.result?.effect).toBeNull()
  expect(f.store.operations('origin')[0]).toEqual(op)
  expect(f.calls.some(call => call.file === 'git')).toBe(false)
  expect(f.asks).toEqual([])
})

test('same key returns existing ready or uncertain operation without replaying effects', async () => {
  const f = fixture()
  f.fail('pane run')
  const first = await f.service.open(f.input, f.ctx)
  expect(first.state).toBe('uncertain')
  expect(first.result?.effect).toBe('launch')
  const count = f.calls.length
  const restarted = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
  expect((await restarted.open(f.input, f.ctx)).id).toBe(first.id)
  expect(f.calls.length).toBe(count)
  expect(JSON.stringify(first)).not.toContain('secret-bearing')
  await expect(restarted.open({ ...f.input, persona: 'review' }, f.ctx)).rejects.toThrow('payload conflict')
})

test('concurrent same-key opens use one claim and launch once', async () => {
  const f = fixture()
  const other = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
  await Promise.all([f.service.open(f.input, f.ctx), other.open(f.input, f.ctx)])
  expect(f.calls.filter(call => call.args[1] === 'split')).toHaveLength(1)
  expect(f.calls.filter(call => call.args[1] === 'run')).toHaveLength(1)
  expect(f.creates).toHaveLength(1)
})

test('failed placement retains uncertainty and never launches or cleans up', async () => {
  const f = fixture()
  f.fail('pane split')
  const first = await f.service.open(f.input, f.ctx)
  expect(first.state).toBe('uncertain')
  expect(first.result?.effect).toBe('placement')
  await f.service.open(f.input, f.ctx)
  await f.service.reconcile()
  expect(f.calls.filter(call => call.args[1] === 'split')).toHaveLength(1)
  expect(f.calls.some(call => ['run', 'close', 'remove'].includes(call.args[1]))).toBe(false)
})

test('launching binds only after exact terminal and directory observation, including restart reconciliation', async () => {
  const f = fixture()
  f.visible(false)
  expect((await f.service.open(f.input, f.ctx)).state).toBe('launching')
  const restarted = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
  f.visible(true)
  f.live.terminal_id = 'different'
  await restarted.reconcile('origin')
  expect(f.agents).toHaveLength(0)
  f.live.terminal_id = 'terminal'
  f.live.cwd = f.root
  await restarted.reconcile('origin')
  expect(f.agents).toHaveLength(0)
  f.live.cwd = f.folder
  await restarted.reconcile('origin')
  expect(f.operations[0].state).toBe('ready')
  expect(f.agents).toHaveLength(1)
  expect(f.calls.filter(call => call.args[1] === 'run')).toHaveLength(1)
})

test('workspace uses existing directory, no Git, and independent management', async () => {
  const f = fixture()
  const op = await f.service.open({ ...f.input, placement: 'workspace', management: 'independent' }, f.ctx)
  expect(op.state).toBe('ready')
  expect(f.calls.find(call => call.args[0] === 'workspace')?.args).toEqual(['workspace', 'create', '--cwd', f.folder, '--label', `build-${op.id}`, '--no-focus'])
  expect(f.agents[0].management).toBe('independent')
  expect(f.agents[0].managerSessionId).toBeUndefined()
  expect(f.calls.some(call => call.file === 'git')).toBe(false)
})

for (const placement of ['pane', 'subworkspace'] as const) {
  test(`isolated ${placement} uses fresh branch, pinned base and external worktree`, async () => {
    const f = fixture()
    const op = await f.service.open({ ...f.input, placement, isolation: { branch: 'fresh', baseCommit: 'HEAD' } }, f.ctx)
    expect(op.state).toBe('ready')
    expect(op.result?.destination).toBe(join(f.root, '.config/opencode/opencode-herdr/worktrees', op.id))
    expect(op.result?.baseCommit).toBe('a'.repeat(40))
    expect(f.creates[0].options).toEqual({ query: { directory: op.result!.destination }, body: { title: op.result!.label }, throwOnError: true, signal: f.ctx.abort })
    if (placement === 'pane') {
      expect(f.calls.find(call => call.file === 'git' && call.args.includes('add'))?.state).toBe('uncertain')
    } else {
      expect(f.calls.find(call => call.args[0] === 'worktree')?.args).toEqual(['worktree', 'create', '--cwd', f.folder, '--branch', 'fresh', '--base', 'a'.repeat(40), '--path', op.result!.destination as string, '--label', `build-${op.id}`, '--no-focus'])
    }
    expect(f.calls.filter(call => call.file === 'opencode')).toHaveLength(2)
    expect(f.calls.some(call => call.file === 'direnv' || call.args.includes('--force'))).toBe(false)
  })
}

test('validation refuses missing persona, symlink folders, tasks and missing context', async () => {
  const f = fixture()
  expect((await f.service.open({ ...f.input, persona: 'missing' }, f.ctx)).state).toBe('failed')
  expect(f.calls.some(call => call.file === 'herdr')).toBe(false)
  const link = join(f.root, 'link')
  symlinkSync(f.folder, link)
  expect((await f.service.open({ ...f.input, folder: link, idempotencyKey: 'symlink' }, f.ctx)).state).toBe('failed')
  await expect(f.service.open({ ...f.input, task: 'do stuff' } as OpenInput, f.ctx)).rejects.toThrow('tasks')
  await expect(f.service.open({ ...f.input, folder: 'relative' }, f.ctx)).rejects.toThrow('absolute')
  delete (f.env as Record<string, string>).HERDR_ENV
  await expect(f.service.open(f.input, f.ctx)).rejects.toThrow('local herdr')
})

test('close always asks exact identity permission, rechecks and closes only the pane', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  const identity = opened.result!.identity as string
  const closed = await f.service.close({ identity, idempotencyKey: 'close' }, f.ctx)
  expect(closed.state).toBe('closed')
  expect(f.asks).toHaveLength(1)
  expect(f.asks[0].permission).toBe('opencode_herdr.close_agent')
  expect(f.asks[0].patterns).toEqual([identity])
  expect(f.asks[0].always).toEqual([])
  expect(f.asks[0].metadata.terminalId).toBe('terminal')
  expect(f.calls.find(call => call.args[1] === 'close')?.args).toEqual(['pane', 'close', 'child:p1'])
  expect(f.calls.find(call => call.args[1] === 'close')?.state).toBe('uncertain')
  await f.service.close({ identity, idempotencyKey: 'close' }, f.ctx)
  expect(f.asks).toHaveLength(1)
  expect(f.calls.filter(call => call.args[1] === 'close')).toHaveLength(1)
})

test('close refuses busy or changed binding after permission', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  f.ctx.ask = async () => { f.live.agent_status = 'working' }
  expect((await f.service.close({ identity: opened.result!.identity as string, idempotencyKey: 'close' }, f.ctx)).state).toBe('failed')
  expect(f.calls.some(call => call.args[1] === 'close')).toBe(false)
})

test('permission denial never closes, and queued/active requests prevent claiming', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  const identity = opened.result!.identity as string
  f.pending(true)
  expect((await f.service.close({ identity, idempotencyKey: 'pending' }, f.ctx)).state).toBe('requested')
  expect(f.asks).toHaveLength(0)
  f.pending(false)
  f.ctx.ask = async () => { throw new Error('denied') }
  expect((await f.service.close({ identity, idempotencyKey: 'denied' }, f.ctx)).state).toBe('failed')
  expect(f.calls.some(call => call.args[1] === 'close')).toBe(false)
})

test('concurrent different-key closes reserve one agent and uncertain close never replays', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  const identity = opened.result!.identity as string
  f.fail('pane close')
  await Promise.all(['one', 'two'].map(idempotencyKey => f.service.close({ identity, idempotencyKey }, f.ctx)))
  expect(f.calls.filter(call => call.args[1] === 'close')).toHaveLength(1)
  expect(f.asks).toHaveLength(1)
  await f.service.close({ identity, idempotencyKey: 'one' }, f.ctx)
  await f.service.reconcile()
  expect(f.operations.find(op => op.kind === 'close_agent' && op.state === 'uncertain')).toBeDefined()
  f.visible(false)
  await f.service.reconcile()
  expect(f.operations.find(op => op.kind === 'close_agent' && op.state === 'closed')).toBeDefined()
  expect(f.calls.filter(call => call.args[1] === 'close')).toHaveLength(1)
})

test('replacement terminal or conversation prevents closure confirmation', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  f.fail('pane close')
  await f.service.close({ identity: opened.result!.identity as string, idempotencyKey: 'close' }, f.ctx)
  f.live.terminal_id = 'replacement'
  f.live.agent_session.value = 'replacement-session'
  await f.service.reconcile()
  expect(f.operations.at(-1)?.state).toBe('uncertain')
})

test('minimal creation receipts are verified by pane get rather than invented fields', async () => {
  const f = fixture()
  const run: ProvisionRunner = async (file, args, options) => {
    if (args[1] === 'split') return { stdout: JSON.stringify({ result: { pane: { pane_id: 'child:p1', terminal_id: 'terminal' } } }), stderr: '' }
    return f.run(file, args, options)
  }
  const service = new Provisioner(f.store as unknown as Store, run, f.env, f.client)
  expect((await service.open(f.input, f.ctx)).state).toBe('ready')
  expect(f.calls.some(call => call.args[1] === 'get')).toBe(true)
})

test('partial receipts retain known pane IDs without launching', async () => {
  const f = fixture()
  const run: ProvisionRunner = async (file, args, options) => {
    if (args[1] === 'split') return { stdout: JSON.stringify({ result: { pane: { pane_id: 'child:p1' } } }), stderr: '' }
    return f.run(file, args, options)
  }
  const service = new Provisioner(f.store as unknown as Store, run, f.env, f.client)
  const op = await service.open(f.input, f.ctx)
  expect(op.state).toBe('uncertain')
  expect(op.result?.paneId).toBe('child:p1')
  expect(f.calls.some(call => call.args[1] === 'run')).toBe(false)
})

test('existing isolation branch fails before resource creation', async () => {
  const f = fixture()
  const run: ProvisionRunner = async (file, args, options) => {
    if (file === 'git' && args.includes('for-each-ref')) return { stdout: 'refs/heads/existing\n', stderr: '' }
    return f.run(file, args, options)
  }
  const service = new Provisioner(f.store as unknown as Store, run, f.env, f.client)
  expect((await service.open({ ...f.input, isolation: { branch: 'existing' } }, f.ctx)).state).toBe('failed')
  expect(f.calls.some(call => call.args.includes('add') || call.file === 'herdr')).toBe(false)
})

test('independent agents still require permission and new pending work after approval refuses close', async () => {
  const f = fixture()
  const opened = await f.service.open({ ...f.input, management: 'independent' }, f.ctx)
  f.ctx.ask = async input => { f.asks.push(input); f.pending(true) }
  const closed = await f.service.close({ identity: opened.result!.identity as string, idempotencyKey: 'close' }, f.ctx)
  expect(closed.state).toBe('failed')
  expect(f.asks).toHaveLength(1)
  expect(f.calls.some(call => call.args[1] === 'close')).toBe(false)
})

test('lost verification after close remains uncertain instead of treating transport as proof', async () => {
  const f = fixture()
  const opened = await f.service.open(f.input, f.ctx)
  f.hook(async (_file, args) => { if (args[1] === 'close') f.fail('agent list') })
  const closed = await f.service.close({ identity: opened.result!.identity as string, idempotencyKey: 'close' }, f.ctx)
  expect(closed.state).toBe('uncertain')
  await f.service.reconcile()
  expect(f.operations.at(-1)?.state).toBe('uncertain')
  f.fail('')
  await f.service.reconcile()
  expect(f.operations.at(-1)?.state).toBe('closed')
  expect(f.calls.filter(call => call.args[1] === 'close')).toHaveLength(1)
})

test('an agent disappearing from discovery alone does not prove its terminal closed', async () => {
  const f = fixture()
  const run: ProvisionRunner = async (file, args, options) => {
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: [{ pane_id: 'child:p1', terminal_id: 'terminal' }] } }), stderr: '' }
    return f.run(file, args, options)
  }
  const service = new Provisioner(f.store as unknown as Store, run, f.env, f.client)
  const opened = await service.open(f.input, f.ctx)
  expect((await service.close({ identity: opened.result!.identity as string, idempotencyKey: 'close' }, f.ctx)).state).toBe('uncertain')
})

test('uncertain launch binds only the expected session without replaying launch', async () => {
  const f = fixture()
  f.fail('pane run')
  const opened = await f.service.open(f.input, f.ctx)
  expect(opened.state).toBe('uncertain')
  f.fail('')
  f.live.agent_session.value = 'replacement-session'
  const calls = f.calls.length
  const restarted = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
  await restarted.reconcile('origin')
  expect(f.operations[0]).toEqual(opened)
  expect(f.agents).toEqual([])
  expect(f.calls.slice(calls).map(call => call.args)).toEqual([['agent', 'list']])
  f.live.agent_session.value = 'child-session'
  await restarted.reconcile('origin')
  expect(f.operations[0].state).toBe('ready')
  expect(f.operations[0].result?.sessionId).toBe(opened.result?.expectedSessionId)
  expect(f.agents).toHaveLength(1)
  expect(f.calls.filter(call => call.args[1] === 'run')).toHaveLength(1)
  expect(f.creates).toHaveLength(1)
})

async function realFixture() {
  const f = fixture()
  const path = join(f.root, 'coordination.sqlite')
  const store = new Store(path)
  const second = new Store(path)
  stores.push(store, second)
  const service = new Provisioner(store, f.run, f.env, f.client)
  f.visible(false)
  const opened = await service.open(f.input, f.ctx)
  expect(opened.state).toBe('launching')
  f.visible(true)
  const binding = {
    sessionId: 'child-session', socket: f.env.HERDR_SOCKET_PATH, paneId: f.live.pane_id,
    terminalId: f.live.terminal_id, workspaceId: f.live.workspace_id, directory: f.folder,
    label: opened.result!.label as string, state: 'idle', lastSeen: Date.now(),
    management: 'managed' as const, managerSessionId: 'origin',
  }
  return { ...f, store, second, service, opened, binding }
}

test('real Store binding makes readiness and management durable across connections', async () => {
  const f = await realFixture()
  // Discovery can see the conversation before provisioning claims its management.
  const { management: _, managerSessionId: __, ...observation } = f.binding
  const observed = f.second.observeAgent(observation)
  expect(observed.management).toBe('independent')
  await f.service.reconcile('origin')
  const ready = f.second.operations('origin')[0]
  expect(ready.state).toBe('ready')
  expect(ready.result?.identity).toBe(observed.id)
  expect(ready.result?.sessionId).toBe(f.binding.sessionId)
  expect(f.second.agent(observed.id).managerSessionId).toBe('origin')
  expect(f.second.bindProvision(ready.id, f.binding).id).toBe(observed.id)
  expect(f.second.operations('origin')[0]).toEqual(ready)
})

test('real Store rejects stale reconciliation replacing a concurrently bound conversation', async () => {
  const f = await realFixture()
  let winner: Agent | undefined
  f.hook(async (_file, args) => {
    if (args[0] !== 'agent') return
    winner = f.second.bindProvision(f.opened.id, f.binding)
    f.live.agent_session.value = 'replacement-session'
  })
  await f.service.reconcile('origin')
  const ready = f.store.operations('origin')[0]
  expect(ready.state).toBe('ready')
  expect(ready.result?.sessionId).toBe('child-session')
  expect(ready.result?.identity).toBe(winner!.id)
  expect(f.store.agents()).toHaveLength(1)
  expect(f.store.agent(winner!.id).managerSessionId).toBe('origin')
  expect(() => f.second.bindProvision(f.opened.id, { ...f.binding, sessionId: 'replacement-session' })).toThrow('already bound')
  f.hook(undefined)
  const calls = f.calls.length
  await new Provisioner(f.second, f.run, f.env, f.client).reconcile('origin')
  expect(f.calls).toHaveLength(calls)
  expect(f.store.operations('origin')[0]).toEqual(ready)
})

test('real Store rejects stale reconciliation taking another operation manager', async () => {
  const f = await realFixture()
  const other = f.second.beginOperation('open_agent', 'other-origin', 'other-open', f.opened.payload)
  expect(f.second.claimOperation(other.id, 'requested', 'preparing')).toBe(true)
  f.second.updateOperation(other.id, 'launching', f.opened.result!)
  let winner: Agent | undefined
  f.hook(async (_file, args) => {
    if (args[0] === 'agent') winner = f.second.bindProvision(other.id, { ...f.binding, managerSessionId: 'other-origin' })
  })
  await f.service.reconcile('origin')
  expect(f.store.operations('origin')[0].state).toBe('launching')
  expect(f.store.operations('origin')[0].result?.identity).toBeUndefined()
  expect(f.store.operations('other-origin')[0].result?.identity).toBe(winner!.id)
  expect(f.store.agent(winner!.id).managerSessionId).toBe('other-origin')
  expect(f.store.agents()).toHaveLength(1)
  expect(() => f.store.bindProvision(f.opened.id, f.binding)).toThrow('another provision operation')
  expect(() => f.store.bindProvision(other.id, f.binding)).toThrow('management differs')
})

test('real Store uncertain launch rejects replacements and binds the expected session on readback', async () => {
  const f = fixture()
  const store = new Store(join(f.root, 'coordination.sqlite'))
  stores.push(store)
  const service = new Provisioner(store, f.run, f.env, f.client)
  f.fail('pane run')
  const opened = await service.open(f.input, f.ctx)
  expect(opened.state).toBe('uncertain')
  f.fail('')
  f.live.agent_session.value = 'replacement-session'
  await service.reconcile('origin')
  expect(store.operations('origin')[0]).toEqual(opened)
  expect(store.agents()).toEqual([])
  f.live.agent_session.value = 'child-session'
  await service.reconcile('origin')
  expect(store.operations('origin')[0].state).toBe('ready')
  expect(store.operations('origin')[0].result?.sessionId).toBe(opened.result?.expectedSessionId)
  expect(store.agents()).toHaveLength(1)
  expect(f.calls.filter(call => call.args[1] === 'run')).toHaveLength(1)
  expect(f.creates).toHaveLength(1)
})

test('uncertain launch without a session receipt is not inspected or bound', async () => {
  const f = fixture()
  f.fail('pane run')
  const opened = await f.service.open(f.input, f.ctx)
  delete f.operations[0].result!.expectedSessionId
  const calls = f.calls.length
  await f.service.reconcile('origin')
  expect(f.operations[0].state).toBe('uncertain')
  expect(f.operations[0].result?.effect).toBe('launch')
  expect(f.agents).toEqual([])
  expect(f.calls).toHaveLength(calls)
  expect(f.creates).toHaveLength(1)
  expect(opened.result?.expectedSessionId).toBe('child-session')
})

test('replacement before first observation cannot bind despite matching terminal and directory', async () => {
  const f = fixture()
  f.live.agent_session.value = 'replacement-session'
  const opened = await f.service.open(f.input, f.ctx)
  expect(opened.state).toBe('launching')
  expect(opened.result?.expectedSessionId).toBe('child-session')
  expect(opened.result?.sessionId).toBeUndefined()
  expect(f.agents).toEqual([])
  const restarted = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
  await restarted.reconcile('origin')
  expect(f.operations[0].state).toBe('launching')
  expect(f.agents).toEqual([])
  f.live.agent_session.value = 'child-session'
  await restarted.reconcile('origin')
  expect(f.operations[0].state).toBe('ready')
  expect(f.operations[0].result?.sessionId).toBe('child-session')
  expect(f.creates).toHaveLength(1)
})

test('real Store first observation rejects a replacement session', async () => {
  const f = await realFixture()
  f.live.agent_session.value = 'replacement-session'
  await f.service.reconcile('origin')
  expect(f.store.operations('origin')[0]).toEqual(f.opened)
  expect(f.store.agents()).toEqual([])
  f.live.agent_session.value = 'child-session'
  await f.service.reconcile('origin')
  expect(f.store.operations('origin')[0].state).toBe('ready')
  expect(f.store.agents()[0].sessionId).toBe('child-session')
})

for (const failure of ['lost receipt', 'missing ID', 'blank ID']) {
  test(`session creation ${failure} remains uncertain without launch, retry or cleanup`, async () => {
    const f = fixture()
    if (failure === 'lost receipt') f.fail('session_create')
    else f.createReply({ data: failure === 'missing ID' ? {} : { id: ' ' } })
    const opened = await f.service.open(f.input, f.ctx)
    expect(opened.state).toBe('uncertain')
    expect(opened.result?.effect).toBe('session_create')
    expect(opened.result?.expectedSessionId).toBeUndefined()
    expect(opened.result?.paneId).toBe('child:p1')
    expect(opened.result?.launchAttempted).toBeUndefined()
    const restarted = new Provisioner(f.store as unknown as Store, f.run, f.env, f.client)
    expect(await restarted.open(f.input, f.ctx)).toEqual(opened)
    await restarted.reconcile('origin')
    expect(f.creates).toHaveLength(1)
    expect(f.calls.some(call => ['run', 'close', 'remove'].includes(call.args[1]))).toBe(false)
    expect(JSON.stringify(opened)).not.toContain('secret-bearing')
  })
}

test('launch cannot occur until the exact session receipt is durably checkpointed', async () => {
  const f = fixture()
  const update = f.store.updateOperation
  f.store.updateOperation = (id, state, result) => {
    if (result.expectedSessionId) throw new Error('injected checkpoint failure')
    return update(id, state, result)
  }
  const opened = await f.service.open(f.input, f.ctx)
  expect(opened.state).toBe('uncertain')
  expect(opened.result?.effect).toBe('session_create')
  expect(opened.result?.expectedSessionId).toBeUndefined()
  expect(f.creates).toHaveLength(1)
  expect(f.calls.some(call => call.args[1] === 'run')).toBe(false)
  await f.service.open(f.input, f.ctx)
  expect(f.creates).toHaveLength(1)
})
