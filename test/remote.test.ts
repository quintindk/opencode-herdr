import { afterEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../src/store.js'
import { handleRequest, readRemoteConfig, remoteLimits, remoteOutbox, remoteSession, RemoteTransport, type RemoteRunner } from '../src/remote.js'

const secret = 'random-test-token-0123456789abcdef0123456789abcdef'
const stores: Store[] = []
const dirs: string[] = []
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-remote-'))
  dirs.push(dir)
  return dir
}
function open(path: string) {
  const store = new Store(path)
  stores.push(store)
  return store
}
function fixture() {
  const dir = directory()
  const sender = open(join(dir, 'sender.sqlite'))
  const receiver = open(join(dir, 'receiver.sqlite'))
  const agent = receiver.observeAgent({ sessionId: 'recipient', socket: '/remote/socket', paneId: 'pane', terminalId: 'terminal', workspaceId: 'workspace', directory: '/remote/project', label: 'Worker', state: 'idle', lastSeen: Date.now() })
  const peer = { id: 'other', sshTarget: 'worker@example.org', helperPath: "/opt/helper's files/dist/remote-helper.js", expectedMachineId: receiver.machineId, token: secret }
  const trust = { trustedOrigins: [{ machineId: sender.machineId, token: secret }] }
  const input = { originSessionId: 'origin:session', originDirectory: '/sender/does-not-exist', recipientId: agent.id, kind: 'task' as const, text: 'Review the code', idempotencyKey: 'request-1' }
  const packet = (op = 'enqueue', args: unknown = { ...input, originSessionId: undefined }) => ({ protocolVersion: 1, originMachineId: sender.machineId, originSessionId: input.originSessionId, expectedMachineId: receiver.machineId, token: secret, op, args: JSON.parse(JSON.stringify(args)) })
  const calls: { target: string; command: string; packet: ReturnType<typeof packet> }[] = []
  const runner: RemoteRunner = async (target, command, stdin) => {
    const request = JSON.parse(stdin)
    calls.push({ target, command, packet: request })
    return JSON.stringify(handleRequest(receiver, trust, request))
  }
  const client = new RemoteTransport(sender, [peer], runner)
  return { dir, sender, receiver, agent, peer, trust, input, packet, calls, runner, client }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('explicit peers, authenticated handshake and secret-free persistent outbox', async () => {
  const f = fixture()
  await expect(new RemoteTransport(f.sender, []).list('missing')).rejects.toThrow('not configured')
  expect(await f.client.handshake('other')).toEqual({ machineId: f.receiver.machineId })
  expect((await f.client.list('other'))[0].id).toBe(f.agent.id)
  const request = await f.client.request('other', f.input)
  expect(request.originSessionId).toBe(remoteSession(f.sender.machineId, f.input.originSessionId))
  expect(request.originDirectory).toBe('/sender/does-not-exist')
  expect(request.state).toBe('queued')
  expect(f.receiver.list(f.input.originSessionId).outbox).toHaveLength(0)
  expect(f.calls.at(-2)?.packet.op).toBe('handshake')
  expect(f.calls.at(-1)?.command).toBe("bun '/opt/helper'\\''s files/dist/remote-helper.js'")
  expect(f.calls.every(call => !call.command.includes(secret))).toBe(true)
  const persisted = open(join(f.dir, 'sender.sqlite'))
  expect(persisted.machineId).toBe(f.sender.machineId)
  expect(remoteOutbox(persisted, f.input.originSessionId)[0]).toEqual({ ...request, originSessionId: f.input.originSessionId })
  expect(JSON.stringify(persisted.operations(f.input.originSessionId))).not.toContain(secret)
  expect(JSON.stringify(request)).not.toContain(secret)
  expect(open(join(f.dir, 'receiver.sqlite')).request(request.id)).toEqual(request)
})

test('lost enqueue receipt can retry the same key after restart without redelivery', async () => {
  const f = fixture()
  let loseReceipt = true
  const runner: RemoteRunner = async (...args) => {
    const output = await f.runner(...args)
    if (JSON.parse(args[2]).op === 'enqueue' && loseReceipt) {
      loseReceipt = false
      throw new Error(`connection failed ${secret}`)
    }
    return output
  }
  const client = new RemoteTransport(f.sender, [f.peer], runner)
  await expect(client.request('other', f.input)).rejects.toThrow('outcome unknown')
  const before = f.sender.operations(f.input.originSessionId)[0]
  expect(before.state).toBe('unknown')
  expect(remoteOutbox(f.sender, f.input.originSessionId)[0]).toMatchObject({ id: before.id, state: 'unknown', generation: 0, revision: 0 })
  await expect(client.inspect('other', before.id, f.input.originSessionId)).rejects.toThrow('list_operations')
  const existing = f.receiver.list(remoteSession(f.sender.machineId, f.input.originSessionId)).outbox[0]
  expect(f.receiver.attempt(existing.id, 1, 'external-prompt')).toBe(true)
  const restarted = new RemoteTransport(open(join(f.dir, 'sender.sqlite')), [f.peer], runner)
  await restarted.sync('other', f.input.originSessionId)
  const receipt = f.sender.operations(f.input.originSessionId)[0].result!.request as ReturnType<Store['request']>
  expect(receipt.id).toBe(existing.id)
  expect(receipt.deliveryId).toBe(existing.deliveryId)
  expect(receipt.messageId).toBe('external-prompt')
  expect(receipt.state).toBe('unknown')
  expect(f.sender.operations(f.input.originSessionId)[0].state).toBe('confirmed')
  expect(f.receiver.list(receipt.originSessionId).outbox).toHaveLength(1)
  await expect(restarted.request('other', { ...f.input, text: 'changed' })).rejects.toThrow('payload conflict')
  await expect(new RemoteTransport(f.sender, [{ ...f.peer, sshTarget: 'another' }], runner).request('other', f.input)).rejects.toThrow('payload conflict')
})

test('recovery never replays persisted intents through changed endpoints', async () => {
  const f = fixture()
  const offline = new RemoteTransport(f.sender, [f.peer], async () => { throw new Error('offline') })
  await expect(offline.request('other', f.input)).rejects.toThrow()
  for (const changed of [{ sshTarget: 'changed' }, { helperPath: '/different/helper.js' }, { expectedMachineId: f.sender.machineId }]) {
    const client = new RemoteTransport(f.sender, [{ ...f.peer, ...changed }], f.runner)
    await expect(client.sync('other', f.input.originSessionId)).rejects.toThrow('endpoint differs')
    await expect(client.inspect('other', 'some-request', f.input.originSessionId)).rejects.toThrow('endpoint differs')
  }
  expect(f.calls).toHaveLength(0)
})

test('full history schedules each remote question and result exactly once across restarts', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  f.receiver.attempt(request.id, 1, 'message')
  f.receiver.accept(request.id, 1, request.deliveryId, 'recipient')
  const first = f.receiver.ask(request.id, 1, 'recipient', 'First question?')
  await f.client.sync('other', f.input.originSessionId)
  const second = f.receiver.ask(request.id, 1, 'recipient', 'Second question?')
  await f.client.sync('other', f.input.originSessionId)
  await f.client.sync('other', f.input.originSessionId)
  const questions = f.sender.notices(f.input.originSessionId)
  expect(questions).toHaveLength(2)
  expect(questions.some(notice => notice.text.includes(first.id))).toBe(true)
  expect(questions.some(notice => notice.text.includes(second.id))).toBe(true)
  for (const notice of questions) {
    expect(notice.directory).toBe(f.input.originDirectory)
    f.sender.noticeAttempt(notice.id, `notice-${notice.id}`)
    f.sender.noticeDelivered(notice.id, `notice-${notice.id}`)
  }
  f.receiver.finish(request.id, 1, 'recipient', { outcome: 'paused', summary: 'Pause result', checks: ['checked'], risks: [] })
  // An enqueue retry can cache the paused receipt before the first full result poll.
  await f.client.request('other', f.input)
  await f.client.sync('other', f.input.originSessionId)
  const resumed = await f.client.resume('other', request.id, f.input.originSessionId, 'Continue', 'continuation', 1)
  f.receiver.attempt(request.id, 2, 'message-2')
  f.receiver.accept(request.id, 2, resumed.deliveryId, 'recipient')
  f.receiver.finish(request.id, 2, 'recipient', { outcome: 'completed', summary: 'Final result', checks: [], risks: [] })
  const restarted = new RemoteTransport(open(join(f.dir, 'sender.sqlite')), [f.peer], f.runner)
  await restarted.sync('other', f.input.originSessionId)
  await restarted.sync('other', f.input.originSessionId)
  const notices = f.sender.notices(f.input.originSessionId)
  expect(notices).toHaveLength(4)
  expect(notices.filter(notice => notice.text.includes('Pause result'))).toHaveLength(1)
  expect(notices.filter(notice => notice.text.includes('Final result'))).toHaveLength(1)
  const history = f.sender.operations(f.input.originSessionId)[0].result!.history as ReturnType<Store['history']>
  expect(history.results).toHaveLength(2)
  expect(history.questions).toHaveLength(2)
  expect(history.request.revision).toBe(f.receiver.request(request.id).revision)
})

test('delayed snapshots cannot regress request generation or full history', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  let release!: (value: string) => void
  let captured!: () => void
  const ready = new Promise<void>(resolve => { captured = resolve })
  const slow = new RemoteTransport(f.sender, [f.peer], async (...args) => {
    const output = await f.runner(...args)
    if (JSON.parse(args[2]).op !== 'inspect') return output
    return new Promise<string>(resolve => { release = resolve; captured(); delayedOutput = output })
  })
  let delayedOutput = ''
  const delayed = slow.inspect('other', request.id, f.input.originSessionId)
  await ready
  f.receiver.attempt(request.id, 1, 'message')
  f.receiver.accept(request.id, 1, request.deliveryId, 'recipient')
  f.receiver.finish(request.id, 1, 'recipient', { outcome: 'paused', summary: 'Paused', checks: [], risks: [] })
  await f.client.resume('other', request.id, f.input.originSessionId, 'Continue', 'resume', 1)
  await f.client.sync('other', f.input.originSessionId)
  const latest = f.sender.operations(f.input.originSessionId)[0].result
  release(delayedOutput)
  await delayed.catch(() => {}) // Store may reject or ignore a stale snapshot.
  expect(f.sender.operations(f.input.originSessionId)[0].result).toEqual(latest)
  expect(remoteOutbox(f.sender, f.input.originSessionId)[0].generation).toBe(2)
  expect(remoteOutbox(f.sender, f.input.originSessionId)[0].state).toBe('queued')
})

test('late transport failures cannot overwrite a newer same-revision success', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  let fail!: (error: Error) => void
  let captured!: () => void
  const ready = new Promise<void>(resolve => { captured = resolve })
  const slow = new RemoteTransport(f.sender, [f.peer], async (...args) => {
    if (JSON.parse(args[2]).op !== 'inspect') return f.runner(...args)
    return new Promise<string>((_, reject) => { fail = reject; captured() })
  })
  const delayed = slow.inspect('other', request.id, f.input.originSessionId)
  await ready
  await f.client.inspect('other', request.id, f.input.originSessionId)
  const latest = f.sender.operations(f.input.originSessionId)[0]
  fail(new Error('lost response'))
  await expect(delayed).rejects.toThrow('unknown')
  expect(f.sender.operations(f.input.originSessionId)[0]).toEqual(latest)
  expect(remoteOutbox(f.sender, f.input.originSessionId)[0].state).toBe('queued')
})

test('same-generation delayed question history cannot resurrect an answered question', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  f.receiver.attempt(request.id, 1, 'message')
  f.receiver.accept(request.id, 1, request.deliveryId, 'recipient')
  const question = f.receiver.ask(request.id, 1, 'recipient', 'Proceed?')
  await f.client.sync('other', f.input.originSessionId)
  const stale = f.receiver.history(request.id, remoteSession(f.sender.machineId, f.input.originSessionId))
  await f.client.reply('other', question.id, f.input.originSessionId, 'Proceed')
  const latest = f.sender.operations(f.input.originSessionId)[0]
  expect((latest.result!.request as ReturnType<Store['request']>).revision).toBeGreaterThan(stale.request.revision)
  const delayed = new RemoteTransport(f.sender, [f.peer], async (...args) => JSON.parse(args[2]).op === 'inspect'
    ? JSON.stringify({ protocolVersion: 1, machineId: f.receiver.machineId, ok: true, result: stale })
    : f.runner(...args))
  await delayed.inspect('other', request.id, f.input.originSessionId).catch(() => {})
  expect(f.sender.operations(f.input.originSessionId)[0].result).toEqual(latest.result)
  expect(f.sender.notices(f.input.originSessionId).filter(notice => notice.state === 'pending')).toHaveLength(0)
})

test('wrong protocol, token, origin, machine and unknown operations fail closed', async () => {
  const f = fixture()
  for (const change of [
    { protocolVersion: 2 }, { token: secret + 'wrong' }, { originMachineId: f.receiver.machineId },
    { expectedMachineId: f.sender.machineId }, { op: 'exec' }, { op: 'delete' }, { command: 'touch /tmp/no' },
  ]) expect(() => handleRequest(f.receiver, f.trust, { ...f.packet(), ...change })).toThrow()
  expect(() => handleRequest(f.receiver, { trustedOrigins: [] }, f.packet())).toThrow('authentication')
  expect(() => handleRequest(f.receiver, f.trust, f.packet('enqueue', { ...f.input }))).toThrow('Unknown remote field')
  expect(() => handleRequest(f.receiver, f.trust, f.packet('enqueue', { ...f.packet().args, originDirectory: '/not/../canonical' }))).toThrow('normalised')
  expect(f.receiver.list(remoteSession(f.sender.machineId, f.input.originSessionId)).outbox).toHaveLength(0)
  const client = new RemoteTransport(f.sender, [{ ...f.peer, expectedMachineId: f.sender.machineId }], f.runner)
  await expect(client.request('other', f.input)).rejects.toThrow('unknown')
  expect(f.calls.at(-1)?.packet.op).toBe('handshake')
})

test('response identity is pinned even if a helper ignores the request binding', async () => {
  const f = fixture()
  for (const response of [
    { protocolVersion: 1, machineId: f.sender.machineId, ok: true, result: {} },
    { protocolVersion: 2, machineId: f.receiver.machineId, ok: true, result: {} },
    { protocolVersion: 1, machineId: f.receiver.machineId, ok: false, error: secret },
  ]) {
    const client = new RemoteTransport(f.sender, [f.peer], async () => JSON.stringify(response))
    await expect(client.handshake('other')).rejects.toThrow('unknown')
  }
})

test('inspect, questions, reply, resume and cancel use the origin namespace', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  await expect(f.client.inspect('other', request.id, 'someone-else')).rejects.toThrow()
  await expect(f.client.cancel('other', request.id, 'someone-else')).rejects.toThrow()
  f.receiver.attempt(request.id, 1, 'message-1')
  f.receiver.accept(request.id, 1, request.deliveryId, 'recipient')
  const question = f.receiver.ask(request.id, 1, 'recipient', 'Which branch?')
  expect((await f.client.inspect('other', request.id, f.input.originSessionId)).questions[0].id).toBe(question.id)
  await expect(f.client.reply('other', question.id, 'someone-else', 'main')).rejects.toThrow()
  expect((await f.client.reply('other', question.id, f.input.originSessionId, 'main')).reply?.text).toBe('main')
  f.receiver.finish(request.id, 1, 'recipient', { outcome: 'paused', summary: 'Need continuation', checks: [], risks: [] })
  expect((await f.client.sync('other', f.input.originSessionId))[0].state).toBe('paused')
  await expect(f.client.resume('other', request.id, 'someone-else', 'Continue', 'resume-1', 1)).rejects.toThrow()
  const next = await f.client.resume('other', request.id, f.input.originSessionId, 'Continue', 'resume-1', 1)
  expect(next.generation).toBe(2)
  expect((await f.client.resume('other', request.id, f.input.originSessionId, 'Continue', 'resume-1', 1)).deliveryId).toBe(next.deliveryId)
  const cancelled = await f.client.cancel('other', request.id, f.input.originSessionId)
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.mayContinue).toBe(false)
  expect(remoteOutbox(f.sender, f.input.originSessionId)[0].state).toBe('cancelled')
})

test('sync distinguishes unavailable transport from a confirmed receiver state', async () => {
  const f = fixture()
  const request = await f.client.request('other', f.input)
  const offline = new RemoteTransport(f.sender, [f.peer], async () => { throw new Error(secret) })
  expect((await offline.sync('other', f.input.originSessionId))[0].state).toBe('unknown')
  expect(f.sender.operations(f.input.originSessionId)[0].result?.request).toEqual(request)
  expect((await f.client.sync('other', f.input.originSessionId))[0].state).toBe('queued')
})

test('configuration rejects unsafe SSH targets, paths, duplicates and absent tokens', () => {
  const f = fixture()
  for (const sshTarget of ['-oProxyCommand=evil', 'host\ncommand', 'host with spaces', 'host\0']) {
    expect(() => new RemoteTransport(f.sender, [{ ...f.peer, sshTarget }])).toThrow()
  }
  for (const helperPath of ['relative', '/a/../helper', '/helper\ncommand']) {
    expect(() => new RemoteTransport(f.sender, [{ ...f.peer, helperPath }])).toThrow()
  }
  expect(() => new RemoteTransport(f.sender, [{ ...f.peer, token: '' }])).toThrow()
  expect(() => new RemoteTransport(f.sender, [f.peer, f.peer])).toThrow('Duplicate')
  expect(() => new RemoteTransport(f.sender, [{ ...f.peer, command: 'anything' } as typeof f.peer])).toThrow('Unknown')
})

test('private config requires same-user 0600 regular files and no symlinks', () => {
  const f = fixture()
  const configPath = join(f.dir, 'peers.json')
  writeFileSync(configPath, JSON.stringify({ peers: [f.peer], server: f.trust }), { mode: 0o600 })
  expect(readRemoteConfig(configPath)).toEqual({ peers: [f.peer], server: f.trust })
  chmodSync(configPath, 0o644)
  expect(() => readRemoteConfig(configPath)).toThrow('0600')
  chmodSync(configPath, 0o600)
  symlinkSync(configPath, join(f.dir, 'link.json'))
  expect(() => readRemoteConfig(join(f.dir, 'link.json'))).toThrow('symlinks')
  const link = join(directory(), 'parent')
  symlinkSync(f.dir, link)
  expect(() => readRemoteConfig(join(link, 'peers.json'))).toThrow('symlinks')
  writeFileSync(configPath, JSON.stringify({ server: { trustedOrigins: [f.trust.trustedOrigins[0], f.trust.trustedOrigins[0]] } }))
  expect(() => readRemoteConfig(configPath)).toThrow('Duplicate')
  writeFileSync(configPath, `{"token":${secret}}`)
  expect(() => readRemoteConfig(configPath)).toThrow('Invalid remote config JSON')
})

test('hung exchanges have a bounded deadline and leave durable uncertainty', async () => {
  const f = fixture()
  const client = new RemoteTransport(f.sender, [f.peer], () => new Promise(() => {}))
  await expect(client.request('other', f.input)).rejects.toThrow('outcome unknown')
  expect(f.sender.operations(f.input.originSessionId)[0].state).toBe('unknown')
}, 15_000)

test('request and response byte limits reject without leaking remote diagnostics', async () => {
  const f = fixture()
  await expect(f.client.request('other', { ...f.input, text: 'x'.repeat(remoteLimits.requestBytes) })).rejects.toThrow('too large')
  expect(f.calls).toHaveLength(0)
  expect(() => handleRequest(f.receiver, f.trust, f.packet('enqueue', { ...f.packet().args, text: 'x'.repeat(remoteLimits.requestBytes) }))).toThrow('too large')
  const oversized = new RemoteTransport(f.sender, [f.peer], async () => 'x'.repeat(remoteLimits.outputBytes + 1))
  await expect(oversized.handshake('other')).rejects.toThrow('unknown')
  const malformed = new RemoteTransport(f.sender, [f.peer], async () => secret)
  await expect(malformed.handshake('other')).rejects.toThrow('unknown')
})

test('helper process uses persistent local Store, stdin only and generic failure output', async () => {
  const f = fixture()
  const root = directory()
  const configDir = join(root, 'opencode', 'opencode-herdr')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'peers.json'), JSON.stringify({ server: f.trust }), { mode: 0o600 })
  const remote = open(join(configDir, 'coordination.sqlite'))
  const exchange = (stdin: string, args: string[] = []) => new Promise<{ stdout: string; stderr: string; failed: boolean }>((resolvePromise) => {
    const child = execFile(process.execPath, [resolve('src/remote-helper.ts'), ...args], { env: { ...process.env, XDG_CONFIG_HOME: root }, timeout: 15_000, maxBuffer: remoteLimits.outputBytes },
      (error, stdout, stderr) => resolvePromise({ stdout, stderr, failed: !!error }))
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  })
  const packet = { ...f.packet('handshake', {}), expectedMachineId: remote.machineId }
  const result = await exchange(JSON.stringify(packet))
  expect(result.failed).toBe(false)
  expect(JSON.parse(result.stdout).machineId).toBe(remote.machineId)
  expect((await exchange(JSON.stringify(packet))).stdout).toBe(result.stdout)
  for (const failure of [
    await exchange(JSON.stringify({ ...packet, token: secret + 'wrong' })),
    await exchange(JSON.stringify(packet), ['exec']),
    await exchange('x'.repeat(remoteLimits.requestBytes + 1)),
  ]) {
    expect(failure.failed).toBe(true)
    expect(failure.stderr).toBe('')
    expect(failure.stdout).not.toContain(secret)
    expect(JSON.parse(failure.stdout).ok).toBe(false)
  }
})
