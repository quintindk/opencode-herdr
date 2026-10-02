import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Agent, History, Operation, Question, Request } from './model.js'
import type { Store } from './store.js'

export const remoteLimits = { requestBytes: 64 * 1024, outputBytes: 1024 * 1024, timeoutMs: 10_000 } as const
export type RemotePeer = { id: string; sshTarget: string; helperPath: string; expectedMachineId: string; token: string }
export type RemoteTrust = { trustedOrigins: { machineId: string; token: string }[] }
export type RemoteConfig = { peers: RemotePeer[]; server: RemoteTrust }
export type RemoteInput = Parameters<Store['enqueue']>[0]
type Fields = Record<string, unknown>
type Method = 'handshake' | 'agents' | 'enqueue' | 'inspect' | 'cancel' | 'resume' | 'reply'
export type RemoteRunner = (target: string, command: string, stdin: string) => Promise<string>

function object(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote object')
  return value as Fields
}

function fields(value: unknown, keys: string[]): Fields {
  const result = object(value)
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error('Unknown remote field')
  return result
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Invalid remote text')
  return value
}

function machine(value: unknown): string {
  const id = text(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid remote machine ID')
  return id
}

function token(value: unknown): string {
  const secret = text(value)
  // Encoding is flexible, but operators must supply at least 256 bits of random material.
  if (!/^[\x21-\x7e]{32,512}$/.test(secret)) throw new Error('Invalid remote token')
  return secret
}

function path(value: unknown): string {
  const result = text(value)
  if (!isAbsolute(result) || resolve(result) !== result || /[\r\n]/.test(result)) throw new Error('Remote path must be absolute and normalised')
  return result
}

function peer(value: unknown): RemotePeer {
  const p = fields(value, ['id', 'sshTarget', 'helperPath', 'expectedMachineId', 'token'])
  const sshTarget = text(p.sshTarget)
  if (sshTarget.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(sshTarget)) throw new Error('Invalid SSH target')
  return { id: text(p.id), sshTarget, helperPath: path(p.helperPath), expectedMachineId: machine(p.expectedMachineId), token: token(p.token) }
}

function trust(value: unknown): RemoteTrust {
  const config = fields(value, ['trustedOrigins'])
  if (!Array.isArray(config.trustedOrigins)) throw new Error('Invalid trusted origins')
  const trustedOrigins = config.trustedOrigins.map(value => {
    const origin = fields(value, ['machineId', 'token'])
    return { machineId: machine(origin.machineId), token: token(origin.token) }
  })
  if (new Set(trustedOrigins.map(origin => origin.machineId)).size !== trustedOrigins.length) throw new Error('Duplicate trusted origin')
  if (new Set(trustedOrigins.map(origin => origin.token)).size !== trustedOrigins.length) throw new Error('Tokens must be unique per origin')
  return { trustedOrigins }
}

export function readRemoteConfig(configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode-herdr', 'peers.json')): RemoteConfig {
  configPath = path(configPath)
  // Check all path components, then open without following a final symlink.
  for (let part = configPath; ; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error('Remote config path must not contain symlinks')
    if (part === dirname(part)) break
  }
  const fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > remoteLimits.requestBytes) {
      throw new Error('Remote config requires a same-user regular file with mode 0600')
    }
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new Error('Invalid remote config JSON') }
    const config = fields(parsed, ['peers', 'server'])
    if (config.peers !== undefined && !Array.isArray(config.peers)) throw new Error('Invalid peers')
    const peers = ((config.peers ?? []) as unknown[]).map(peer)
    if (new Set(peers.map(p => p.id)).size !== peers.length) throw new Error('Duplicate peer ID')
    return { peers, server: trust(config.server ?? { trustedOrigins: [] }) }
  } finally { closeSync(fd) }
}

export function remoteSession(machineId: string, sessionId: string): string {
  return `remote:${machine(machineId)}:${encodeURIComponent(text(sessionId))}`
}

function enqueueArgs(value: unknown): Omit<RemoteInput, 'originSessionId'> {
  const a = fields(value, ['originDirectory', 'recipientId', 'kind', 'text', 'executionPolicy', 'idempotencyKey'])
  if (a.kind !== 'task' && a.kind !== 'instruction') throw new Error('Invalid request kind')
  const executionPolicy = a.executionPolicy ?? 'advisory'
  if (executionPolicy !== 'advisory' && executionPolicy !== 'code_change') throw new Error('Invalid execution policy')
  return { originDirectory: path(a.originDirectory), recipientId: text(a.recipientId), kind: a.kind, text: text(a.text), executionPolicy, idempotencyKey: text(a.idempotencyKey) }
}

/** Authenticated Store-only exchange. No filesystem access, process launch or external delivery. */
export function handleRequest(store: Store, allowed: RemoteTrust, packet: unknown): Fields {
  const p = fields(packet, ['protocolVersion', 'originMachineId', 'originSessionId', 'expectedMachineId', 'token', 'op', 'args'])
  if (Buffer.byteLength(JSON.stringify(p)) > remoteLimits.requestBytes) throw new Error('Remote request too large')
  if (p.protocolVersion !== 1) throw new Error('Unsupported remote protocol')
  const originMachineId = machine(p.originMachineId)
  const supplied = token(p.token)
  const origin = trust(allowed).trustedOrigins.find(entry => entry.machineId === originMachineId)
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const matches = timingSafeEqual(digest(supplied), digest(origin?.token ?? 'unconfigured origin'))
  if (!origin || !matches) throw new Error('Remote authentication rejected')
  if (machine(p.expectedMachineId) !== store.machineId) throw new Error('Remote machine mismatch')
  const sessionId = remoteSession(originMachineId, text(p.originSessionId))
  let result: unknown
  switch (p.op) {
    case 'handshake':
      fields(p.args, [])
      result = { machineId: store.machineId }
      break
    case 'agents':
      fields(p.args, [])
      result = store.agents()
      break
    case 'enqueue':
      result = store.enqueue({ ...enqueueArgs(p.args), originSessionId: sessionId })
      break
    case 'inspect': {
      const a = fields(p.args, ['requestId'])
      const requestId = text(a.requestId)
      // Remote origins are senders, never an alternate recipient identity.
      if (store.request(requestId).originSessionId !== sessionId) throw new Error('Remote origin cannot inspect this request')
      result = store.history(requestId, sessionId)
      break
    }
    case 'cancel': {
      const a = fields(p.args, ['requestId'])
      result = store.cancel(text(a.requestId), sessionId)
      break
    }
    case 'resume': {
      const a = fields(p.args, ['requestId', 'instructions', 'idempotencyKey', 'expectedGeneration'])
      if (!Number.isSafeInteger(a.expectedGeneration) || (a.expectedGeneration as number) < 1) throw new Error('Invalid expected generation')
      result = store.resume(text(a.requestId), sessionId, text(a.instructions), text(a.idempotencyKey), a.expectedGeneration as number)
      break
    }
    case 'reply': {
      const a = fields(p.args, ['questionId', 'answer'])
      result = store.reply(text(a.questionId), sessionId, text(a.answer))
      break
    }
    default: throw new Error('Unknown remote operation')
  }
  return { protocolVersion: 1, machineId: store.machineId, ok: true, result }
}

const runSSH: RemoteRunner = (target, command, stdin) => new Promise((resolve, reject) => {
  const child = execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', target, command],
    { timeout: remoteLimits.timeoutMs, maxBuffer: remoteLimits.outputBytes, encoding: 'utf8', killSignal: 'SIGKILL' },
    (error, stdout) => error ? reject(new Error('Remote SSH exchange failed')) : resolve(stdout))
  child.stdin?.on('error', () => reject(new Error('Remote SSH input failed')))
  child.stdin?.end(stdin)
})

function storedRequest(operation: Operation): Request | undefined {
  return operation.result?.request as Request | undefined
}

/** Unknown RPCs retain any last receipt, but never present it as current confirmed state. */
export function remoteOutbox(store: Store, sessionId: string): Request[] {
  return store.operations(sessionId).filter(op => op.kind === 'remote.request').map(op => {
    const request = storedRequest(op)
    if (request) return { ...request, originSessionId: sessionId, ...(op.state === 'unknown' ? { state: 'unknown' as const } : {}) }
    const args = enqueueArgs(op.payload.args)
    // This is an operation placeholder, not a receiver request or delivery identity.
    return { id: op.id, originSessionId: sessionId, originDirectory: args.originDirectory,
      recipientId: args.recipientId, kind: args.kind, text: args.text, executionPolicy: args.executionPolicy ?? 'advisory',
      revision: 0, generation: 0, sequence: 0, deliveryId: '', state: 'unknown', createdAt: op.createdAt, updatedAt: op.updatedAt }
  })
}

export class RemoteTransport {
  private readonly peers: Map<string, RemotePeer>

  constructor(private readonly store: Store, peers: readonly RemotePeer[], private readonly runner: RemoteRunner = runSSH) {
    const configured = peers.map(peer)
    this.peers = new Map(configured.map(p => [p.id, p]))
    if (configured.length !== this.peers.size) throw new Error('Duplicate peer ID')
  }

  private configured(peerId: string): RemotePeer {
    const p = this.peers.get(peerId)
    if (!p) throw new Error('Remote peer is not configured')
    return p
  }

  private async exchange(p: RemotePeer, sessionId: string, op: Method, args: Fields): Promise<unknown> {
    const stdin = JSON.stringify({ protocolVersion: 1, originMachineId: this.store.machineId, originSessionId: text(sessionId), expectedMachineId: p.expectedMachineId, token: p.token, op, args })
    if (Buffer.byteLength(stdin) > remoteLimits.requestBytes) throw new Error('Remote request too large')
    // execFile protects the local shell; POSIX single-quoting protects the SSH remote shell.
    const command = `bun '${p.helperPath.replaceAll("'", "'\\''")}'`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const output = await Promise.race([
        this.runner(p.sshTarget, command, stdin),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Remote timeout')), remoteLimits.timeoutMs) }),
      ])
      if (Buffer.byteLength(output) > remoteLimits.outputBytes) throw new Error('Remote output too large')
      const response = fields(JSON.parse(output), ['protocolVersion', 'machineId', 'ok', 'result', 'error'])
      if (response.protocolVersion !== 1 || response.machineId !== p.expectedMachineId || response.ok !== true) throw new Error('Remote response rejected')
      return response.result
    } catch {
      // Never expose stderr, raw replies, command diagnostics or secret-bearing packets.
      throw new Error('Remote exchange failed or was rejected; outcome unknown')
    } finally { clearTimeout(timer) }
  }

  private async rpc(p: RemotePeer, sessionId: string, op: Method, args: Fields): Promise<unknown> {
    await this.exchange(p, sessionId, 'handshake', {})
    return this.exchange(p, sessionId, op, args)
  }

  async handshake(peerId: string, sessionId = 'discovery'): Promise<{ machineId: string }> {
    const p = this.configured(peerId)
    await this.exchange(p, sessionId, 'handshake', {})
    return { machineId: p.expectedMachineId }
  }

  async list(peerId: string, sessionId = 'discovery'): Promise<Agent[]> {
    const result = await this.rpc(this.configured(peerId), sessionId, 'agents', {})
    if (!Array.isArray(result)) throw new Error('Invalid remote agents response')
    return result as Agent[]
  }

  private receipt(value: unknown, sessionId: string, requestId?: string): Request {
    const r = fields(value, ['id', 'originSessionId', 'originDirectory', 'recipientId', 'kind', 'text', 'executionPolicy', 'revision', 'generation', 'sequence', 'deliveryId', 'state', 'createdAt', 'updatedAt', 'messageId', 'attemptedAt', 'mayContinue', 'summary', 'validation'])
    if (r.originSessionId !== remoteSession(this.store.machineId, sessionId) || (requestId !== undefined && r.id !== requestId) ||
        typeof r.id !== 'string' || !['queued', 'unknown', 'submitted', 'accepted', 'paused', 'completed', 'failed', 'cancelled'].includes(r.state as string) ||
        !Number.isSafeInteger(r.generation) || (r.generation as number) < 1 ||
        !Number.isSafeInteger(r.revision) || (r.revision as number) < 1) throw new Error('Invalid remote request receipt')
    return r as Request
  }

  private matching(p: RemotePeer, sessionId: string): Operation[] {
    const operations = this.store.operations(sessionId).filter(op => op.kind === 'remote.request' && op.payload.peerId === p.id)
    for (const op of operations) {
      if (op.payload.expectedMachineId !== p.expectedMachineId || op.payload.sshTarget !== p.sshTarget || op.payload.helperPath !== p.helperPath) {
        throw new Error('Remote endpoint differs from persisted intent')
      }
    }
    return operations
  }

  private observing(p: RemotePeer, sessionId: string, requestId: string, mutation = false): Operation[] {
    const operations = this.matching(p, sessionId)
    if (operations.some(op => op.id === requestId && !storedRequest(op))) throw new Error('Receipt unavailable; inspect this ID with list_operations')
    const observed = operations.filter(op => storedRequest(op)?.id === requestId)
    if (mutation) {
      for (const op of observed) this.store.failRemote(op.id, op.updatedAt)
      return this.matching(p, sessionId).filter(op => storedRequest(op)?.id === requestId)
    }
    return observed
  }

  private failed(observed: Operation[]): void {
    for (const op of observed) this.store.failRemote(op.id, op.updatedAt)
  }

  async request(peerId: string, input: RemoteInput): Promise<Request> {
    const p = this.configured(peerId)
    const a = fields(input, ['originSessionId', 'originDirectory', 'recipientId', 'kind', 'text', 'executionPolicy', 'idempotencyKey'])
    const sessionId = text(a.originSessionId)
    const { originSessionId: _, ...rest } = a
    const args = enqueueArgs(rest)
    const payload = { peerId: p.id, sshTarget: p.sshTarget, helperPath: p.helperPath, expectedMachineId: p.expectedMachineId, args }
    if (Buffer.byteLength(JSON.stringify(payload)) > remoteLimits.requestBytes - 2048) throw new Error('Remote request too large')
    const operation = this.store.beginOperation('remote.request', sessionId, args.idempotencyKey, payload)
    // Persist uncertainty before any network I/O, including a process crash or lost receipt.
    this.store.failRemote(operation.id, operation.updatedAt)
    const observed = this.store.operations(sessionId).find(op => op.id === operation.id)!
    try {
      const request = this.receipt(await this.rpc(p, sessionId, 'enqueue', args), sessionId)
      if (request.recipientId !== args.recipientId) throw new Error('Remote recipient mismatch')
      this.store.cacheRemote(operation.id, request)
      return request
    } catch {
      this.failed([observed])
      throw new Error('Remote request outcome unknown; retry the identical idempotency key')
    }
  }

  async inspect(peerId: string, requestId: string, sessionId: string): Promise<History> {
    const p = this.configured(peerId)
    const observed = this.observing(p, sessionId, requestId)
    try {
      const history = object(await this.rpc(p, sessionId, 'inspect', { requestId: text(requestId) }))
      const request = this.receipt(history.request, sessionId, requestId)
      for (const op of observed) this.store.cacheRemote(op.id, request, history as History)
      return history as History
    } catch {
      this.failed(observed)
      throw new Error('Remote inspection unavailable; current state unknown')
    }
  }

  async cancel(peerId: string, requestId: string, sessionId: string): Promise<Request> {
    const p = this.configured(peerId)
    const observed = this.observing(p, sessionId, requestId, true)
    try {
      const request = this.receipt(await this.rpc(p, sessionId, 'cancel', { requestId: text(requestId) }), sessionId, requestId)
      for (const op of observed) this.store.cacheRemote(op.id, request)
      return request
    } catch (error) { this.failed(observed); throw error }
  }

  async resume(peerId: string, requestId: string, sessionId: string, instructions: string, idempotencyKey: string, expectedGeneration: number): Promise<Request> {
    const p = this.configured(peerId)
    const observed = this.observing(p, sessionId, requestId, true)
    try {
      const request = this.receipt(await this.rpc(p, sessionId, 'resume', { requestId, instructions, idempotencyKey, expectedGeneration }), sessionId, requestId)
      for (const op of observed) this.store.cacheRemote(op.id, request)
      return request
    } catch (error) { this.failed(observed); throw error }
  }

  async reply(peerId: string, questionId: string, sessionId: string, answer: string): Promise<Question> {
    const p = this.configured(peerId)
    this.matching(p, sessionId)
    const question = await this.rpc(p, sessionId, 'reply', { questionId, answer }) as Question
    await this.inspect(peerId, question.requestId, sessionId)
    return question
  }

  async sync(peerId: string, sessionId: string): Promise<Request[]> {
    const p = this.configured(peerId)
    for (const op of this.matching(p, sessionId)) {
      try {
        const request = storedRequest(op) ?? await this.request(peerId, { ...enqueueArgs(op.payload.args), originSessionId: sessionId })
        await this.inspect(peerId, request.id, sessionId)
      } catch { /* request/inspect persist uncertainty without overwriting newer successes */ }
    }
    return remoteOutbox(this.store, sessionId)
  }
}
