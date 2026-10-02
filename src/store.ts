import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Agent, Delivery, History, Notice, Operation, Outcome, Question, Request, TaskResult } from './model.js'

// Keep the Node-built plugin independent of Bun's ambient types. Execution requires Bun.
type Value = string | number | null
type Row = Record<string, unknown>
type AgentInput = Omit<Agent, 'id' | 'machineId' | 'management'> & { management?: Agent['management']; managerSessionId?: string }
interface SQLite {
  exec(sql: string): void
  query(sql: string): {
    get(...values: Value[]): unknown
    all(...values: Value[]): unknown[]
    run(...values: Value[]): { changes: number }
  }
  transaction<T>(fn: () => T): { immediate(): T; deferred(): T }
  close(): void
}
const { Database } = createRequire(import.meta.url)('bun:sqlite') as {
  Database: new (path: string) => SQLite
}

const schema = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE agents (
  id TEXT PRIMARY KEY, machineId TEXT NOT NULL, sessionId TEXT NOT NULL UNIQUE,
  socket TEXT NOT NULL, paneId TEXT NOT NULL, terminalId TEXT NOT NULL,
  workspaceId TEXT NOT NULL, directory TEXT NOT NULL, label TEXT NOT NULL,
  state TEXT NOT NULL, lastSeen INTEGER NOT NULL CHECK(lastSeen >= 0),
  management TEXT NOT NULL CHECK(management IN ('managed','independent')),
  managerSessionId TEXT,
  CHECK((management = 'managed' AND managerSessionId IS NOT NULL) OR
        (management = 'independent' AND managerSessionId IS NULL))
) STRICT;
CREATE TABLE requests (
  id TEXT PRIMARY KEY, originSessionId TEXT NOT NULL, originDirectory TEXT NOT NULL,
  recipientId TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK(kind IN ('task','instruction')),
  executionPolicy TEXT NOT NULL CHECK(executionPolicy IN ('advisory','code_change')),
  idempotencyKey TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, cancelledAt INTEGER,
  mayContinue INTEGER CHECK(mayContinue IN (0,1)),
  UNIQUE(originSessionId, idempotencyKey),
  CHECK((cancelledAt IS NULL AND mayContinue IS NULL) OR
        (cancelledAt IS NOT NULL AND mayContinue IS NOT NULL)),
  FOREIGN KEY(id, generation) REFERENCES generations(requestId, generation)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE generations (
  requestId TEXT NOT NULL REFERENCES requests(id),
  generation INTEGER NOT NULL CHECK(generation > 0), text TEXT NOT NULL,
  createdAt INTEGER NOT NULL, originSessionId TEXT NOT NULL, resumeKey TEXT,
  PRIMARY KEY(requestId, generation), UNIQUE(originSessionId, resumeKey)
) STRICT;
CREATE TABLE deliveries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  requestId TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','unknown','submitted','accepted','cancelled')),
  sessionId TEXT NOT NULL, socket TEXT NOT NULL, paneId TEXT NOT NULL,
  terminalId TEXT NOT NULL, workspaceId TEXT NOT NULL, directory TEXT NOT NULL,
  messageId TEXT UNIQUE, attemptedAt INTEGER, submittedAt INTEGER, acceptedAt INTEGER,
  UNIQUE(requestId, generation),
  FOREIGN KEY(requestId, generation) REFERENCES generations(requestId, generation),
  CHECK((messageId IS NULL AND attemptedAt IS NULL) OR
        (messageId IS NOT NULL AND attemptedAt IS NOT NULL)),
  CHECK(state NOT IN ('unknown','submitted','accepted') OR messageId IS NOT NULL),
  CHECK((state = 'accepted') = (acceptedAt IS NOT NULL)),
  CHECK(state != 'queued' OR messageId IS NULL)
) STRICT;
CREATE TABLE results (
  requestId TEXT NOT NULL, generation INTEGER NOT NULL, sessionId TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','paused','failed')),
  summary TEXT NOT NULL, checks TEXT NOT NULL CHECK(json_valid(checks)),
  risks TEXT NOT NULL CHECK(json_valid(risks)), evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  validation TEXT NOT NULL CHECK(validation IN ('pending','not_required')),
  createdAt INTEGER NOT NULL, PRIMARY KEY(requestId, generation),
  FOREIGN KEY(requestId, generation) REFERENCES generations(requestId, generation)
) STRICT;
CREATE TABLE questions (
  id TEXT PRIMARY KEY, requestId TEXT NOT NULL, generation INTEGER NOT NULL,
  sessionId TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','answered','withdrawn')),
  createdAt INTEGER NOT NULL, replySessionId TEXT, replyText TEXT, repliedAt INTEGER,
  FOREIGN KEY(requestId, generation) REFERENCES generations(requestId, generation),
  CHECK((state = 'answered' AND replySessionId IS NOT NULL AND replyText IS NOT NULL AND repliedAt IS NOT NULL) OR
        (state != 'answered' AND replySessionId IS NULL AND replyText IS NULL AND repliedAt IS NULL))
) STRICT;
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, entityId TEXT NOT NULL, eventKey TEXT NOT NULL,
  sessionId TEXT NOT NULL, directory TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','unknown','delivered','superseded')),
  messageId TEXT UNIQUE, attemptedAt INTEGER, deliveredAt INTEGER, createdAt INTEGER NOT NULL,
  UNIQUE(entityId, eventKey, sessionId),
  CHECK((messageId IS NULL AND attemptedAt IS NULL) OR
        (messageId IS NOT NULL AND attemptedAt IS NOT NULL)),
  CHECK(state NOT IN ('unknown','delivered') OR messageId IS NOT NULL),
  CHECK(state != 'pending' OR messageId IS NULL),
  CHECK(state != 'delivered' OR deliveredAt IS NOT NULL)
) STRICT;
CREATE TABLE operations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, originSessionId TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL, state TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), result TEXT CHECK(json_valid(result)),
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  UNIQUE(kind, originSessionId, idempotencyKey)
) STRICT;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entityId TEXT NOT NULL,
  transition TEXT NOT NULL, sessionId TEXT NOT NULL, createdAt INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_entity ON audit_events(entityId, id);
CREATE INDEX operations_close ON operations(json_extract(payload, '$.identity')) WHERE kind='close_agent';
CREATE INDEX requests_recipient ON requests(recipientId);
CREATE INDEX requests_origin ON requests(originSessionId);
CREATE INDEX questions_request ON questions(requestId, generation);
CREATE INDEX notifications_session ON notifications(sessionId, state);
CREATE TRIGGER generations_immutable BEFORE UPDATE ON generations BEGIN
  SELECT RAISE(ABORT, 'Generation briefs are immutable'); END;
CREATE TRIGGER results_immutable BEFORE UPDATE ON results BEGIN
  SELECT RAISE(ABORT, 'Results are immutable'); END;
PRAGMA user_version = 1;
`

const projection = `SELECT r.*, g.text, d.sequence, d.id AS deliveryId,
  d.messageId, d.attemptedAt, t.summary, t.validation,
  CASE WHEN r.cancelledAt IS NOT NULL THEN 'cancelled'
       WHEN t.outcome IS NOT NULL THEN t.outcome ELSE d.state END AS state
  FROM requests r JOIN generations g ON g.requestId=r.id AND g.generation=r.generation
  JOIN deliveries d ON d.requestId=r.id AND d.generation=r.generation
  LEFT JOIN results t ON t.requestId=r.id AND t.generation=r.generation`

// Authorisation is a temporary reservation. An attempted close must stay reserved
// until reconciliation, even if a caller reports failure instead of uncertainty.
const closeReservation = `(state IN ('authorising','closing','uncertain','closed') OR json_extract(result, '$.effect')='pane_close')`

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}: expected nonblank text`)
  return value
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}: expected nonnegative integer`)
  return value
}

function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new Error(`Invalid ${name}: ${String(value)}`)
  return value as T
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid ${name}: expected string array`)
  return value
}

function directory(value: unknown): string {
  const path = text(value, 'directory')
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Directory must be an absolute normalised path')
  return path
}

function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing or corrupt coordination record')
  return value as Row
}

// Canonical JSON makes operation deduplication independent of object key order.
function json(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${json((value as Row)[key])}`).join(',')}}`
  }
  throw new Error('Expected JSON data without undefined or non-finite values')
}

export class Store {
  readonly machineId: string
  private readonly db: SQLite

  constructor(path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode-herdr', 'coordination.sqlite')) {
    if (path !== ':memory:') {
      path = resolve(path)
      const parent = dirname(path)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 })
      if (lstatSync(parent).isSymbolicLink()) throw new Error('Coordination directory must not be a symlink')
      chmodSync(parent, 0o700)
      if (existsSync(path)) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Coordination database must be a regular file')
      } else {
        try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Coordination database must be a regular file')
        }
      }
      chmodSync(path, 0o600)
    }
    this.db = new Database(path)
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
      this.atomic(() => {
        const version = number(this.one('PRAGMA user_version').user_version, 'schema version')
        if (version > 1) throw new Error(`Unsupported coordination schema version ${version}; supported version is 1`)
        if (version === 0) {
          this.db.exec(schema)
          this.run('INSERT INTO metadata(key,value) VALUES (?,?)', 'machineId', randomUUID())
        }
      })
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (path !== ':memory:') {
        for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600)
      }
      this.machineId = text(this.one('SELECT value FROM metadata WHERE key=?', 'machineId').value, 'machine ID')
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.machineId)) throw new Error('Corrupt machine ID')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close(): void { this.db.close() }
  private atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate() }
  private snapshot<T>(fn: () => T): T { return this.db.transaction(fn).deferred() }
  private one(sql: string, ...args: Value[]): Row { return row(this.db.query(sql).get(...args)) }
  private all(sql: string, ...args: Value[]): Row[] { return this.db.query(sql).all(...args).map(row) }
  private run(sql: string, ...args: Value[]): number { return this.db.query(sql).run(...args).changes }

  private audit(entityId: string, transition: string, sessionId: string): void {
    this.run('INSERT INTO audit_events(entityId,transition,sessionId,createdAt) VALUES (?,?,?,?)', entityId, transition, sessionId, Date.now())
  }

  private touchRequest(id: string): void {
    this.run('UPDATE requests SET revision=revision+1,updatedAt=MAX(updatedAt+1,?) WHERE id=?', Date.now(), id)
  }

  observeAgent(input: AgentInput): Agent { return this.saveAgent(input) }

  private saveAgent(input: AgentInput, provision = false): Agent {
    for (const key of ['sessionId', 'socket', 'paneId', 'terminalId', 'workspaceId', 'state'] as const) text(input[key], key)
    if (typeof input.label !== 'string') throw new Error('Invalid label')
    directory(input.directory)
    number(input.lastSeen, 'lastSeen')
    return this.atomic(() => {
      const existing = this.db.query('SELECT * FROM agents WHERE sessionId=?').get(input.sessionId)
      const previous = existing ? this.readAgent(row(existing)) : undefined
      if (previous && ['socket', 'terminalId', 'directory', 'paneId', 'workspaceId'].some(key => previous[key as keyof Agent] !== input[key as keyof typeof input])) {
        throw new Error('Agent binding changed; refusing to rebind an existing conversation')
      }
      const management = choice(input.management ?? previous?.management ?? 'independent', ['managed', 'independent'], 'management')
      const manager = management === 'managed' ? text(input.managerSessionId ?? previous?.managerSessionId, 'managerSessionId') : null
      if (management === 'independent' && input.managerSessionId !== undefined) throw new Error('Independent agent cannot have a manager')
      if (previous && (previous.management !== management || (previous.managerSessionId ?? null) !== manager)) {
        if (!provision || previous.management !== 'independent' || management !== 'managed') throw new Error('Observation cannot change agent management')
      }
      const id = previous?.id ?? createHash('sha256').update(`${this.machineId}\0${input.sessionId}`).digest('hex')
      this.run(`INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(sessionId) DO UPDATE SET label=excluded.label, state=excluded.state,
          lastSeen=excluded.lastSeen, management=excluded.management, managerSessionId=excluded.managerSessionId`,
      id, this.machineId, input.sessionId, input.socket, input.paneId, input.terminalId, input.workspaceId,
      input.directory, input.label, input.state, input.lastSeen, management, manager)
      return this.agent(id)
    })
  }

  bindProvision(operationId: string, input: AgentInput): Agent {
    return this.atomic(() => {
      const operation = this.readOperation(this.one('SELECT * FROM operations WHERE id=?', text(operationId, 'operation ID')))
      if (operation.kind !== 'open_agent') throw new Error('Binding requires an open_agent operation')
      const saved = row(operation.result)
      if (saved.launchAttempted !== true) throw new Error('Binding requires persisted launch intent')
      if (input.sessionId !== text(saved.expectedSessionId, 'expectedSessionId')) {
        throw new Error(saved.sessionId !== undefined ? 'Provision operation is already bound to another conversation' : 'Provision session differs from created session')
      }
      if (input.socket !== operation.payload.socket || input.paneId !== saved.paneId || input.terminalId !== saved.terminalId ||
          input.workspaceId !== saved.workspaceId || input.directory !== saved.destination) throw new Error('Provision binding differs from saved launch target')
      const management = choice(operation.payload.management, ['managed', 'independent'], 'provision management')
      const manager = management === 'managed' ? operation.originSessionId : undefined
      if ((input.management !== undefined && input.management !== management) ||
          (input.managerSessionId !== undefined && input.managerSessionId !== manager)) throw new Error('Provision management differs from saved intent')
      if (saved.sessionId !== undefined || saved.identity !== undefined) {
        if (operation.state !== 'ready' || saved.sessionId !== input.sessionId) throw new Error('Provision operation is already bound to another conversation')
        const agent = this.agent(text(saved.identity, 'provision identity'))
        if (agent.sessionId !== input.sessionId || agent.management !== management || agent.managerSessionId !== manager) throw new Error('Saved provision binding is inconsistent')
        for (const key of ['socket', 'paneId', 'terminalId', 'workspaceId', 'directory'] as const) if (agent[key] !== input[key]) throw new Error('Saved provision target is inconsistent')
        return agent
      }
      if (operation.state !== 'launching' && !(operation.state === 'uncertain' && saved.effect === 'launch')) throw new Error('Provision is not awaiting launch verification')
      const observed = this.db.query('SELECT id FROM agents WHERE sessionId=?').get(input.sessionId)
      if (observed && this.db.query(`SELECT id FROM operations WHERE kind='open_agent' AND id!=? AND json_extract(result,'$.identity')=? LIMIT 1`).get(operationId, text(row(observed).id, 'agent ID'))) {
        throw new Error('Agent is already bound to another provision operation')
      }
      const agent = this.saveAgent({ ...input, management, managerSessionId: manager }, true)
      this.updateOperation(operationId, 'ready', { ...saved, identity: agent.id, sessionId: agent.sessionId, effect: null, error: null })
      return agent
    })
  }

  private readAgent(r: Row): Agent {
    if (r.machineId !== this.machineId) throw new Error('Agent belongs to a different machine')
    const result: Agent = {
      id: text(r.id, 'agent ID'), machineId: text(r.machineId, 'machine ID'), sessionId: text(r.sessionId, 'session ID'),
      socket: text(r.socket, 'socket'), paneId: text(r.paneId, 'pane ID'), terminalId: text(r.terminalId, 'terminal ID'),
      workspaceId: text(r.workspaceId, 'workspace ID'), directory: directory(r.directory),
      label: typeof r.label === 'string' ? r.label : text(r.label, 'label'), state: text(r.state, 'agent state'),
      lastSeen: number(r.lastSeen, 'lastSeen'), management: choice(r.management, ['managed', 'independent'], 'management'),
    }
    if (r.managerSessionId !== null) result.managerSessionId = text(r.managerSessionId, 'managerSessionId')
    if ((result.management === 'managed') !== (result.managerSessionId !== undefined)) throw new Error('Corrupt management binding')
    return result
  }

  agents(): Agent[] { return this.all('SELECT * FROM agents ORDER BY id').map(r => this.readAgent(r)) }
  agent(id: string): Agent { return this.readAgent(this.one('SELECT * FROM agents WHERE id=?', text(id, 'agent ID'))) }

  enqueue(input: { originSessionId: string; originDirectory: string; recipientId: string; kind: Request['kind']; text: string; executionPolicy?: Request['executionPolicy']; idempotencyKey: string }): Request {
    text(input.originSessionId, 'originSessionId')
    directory(input.originDirectory)
    text(input.recipientId, 'recipientId')
    text(input.text, 'request text')
    text(input.idempotencyKey, 'idempotencyKey')
    choice(input.kind, ['task', 'instruction'], 'request kind')
    const policy = choice(input.executionPolicy ?? 'advisory', ['advisory', 'code_change'], 'executionPolicy')
    return this.atomic(() => {
      const duplicate = this.db.query(`SELECT r.*, g.text FROM requests r JOIN generations g ON g.requestId=r.id AND g.generation=1
        WHERE r.originSessionId=? AND r.idempotencyKey=?`).get(input.originSessionId, input.idempotencyKey)
      if (duplicate) {
        const old = row(duplicate)
        if (old.originDirectory !== input.originDirectory || old.recipientId !== input.recipientId || old.kind !== input.kind || old.text !== input.text || old.executionPolicy !== policy) throw new Error('Idempotency key payload conflict')
        return this.request(text(old.id, 'request ID'))
      }
      const agent = this.agent(input.recipientId)
      if (this.closingAgent(agent.id)) throw new Error('Agent is reserved for closure or already closed')
      const id = randomUUID()
      const now = Date.now()
      this.run(`INSERT INTO requests(id,originSessionId,originDirectory,recipientId,kind,executionPolicy,idempotencyKey,generation,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,1,?,?)`, id, input.originSessionId, input.originDirectory, agent.id, input.kind, policy, input.idempotencyKey, now, now)
      this.run('INSERT INTO generations VALUES (?,1,?,?,?,NULL)', id, input.text, now, input.originSessionId)
      this.createDelivery(id, 1, agent)
      this.audit(id, 'enqueue:1', input.originSessionId)
      return this.request(id)
    })
  }

  private createDelivery(id: string, generation: number, agent: Agent): void {
    this.run(`INSERT INTO deliveries(id,requestId,generation,state,sessionId,socket,paneId,terminalId,workspaceId,directory)
      VALUES (?,?,?,'queued',?,?,?,?,?,?)`, randomUUID(), id, generation, agent.sessionId, agent.socket, agent.paneId, agent.terminalId, agent.workspaceId, agent.directory)
  }

  private readRequest(r: Row): Request {
    const result: Request = {
      id: text(r.id, 'request ID'), originSessionId: text(r.originSessionId, 'origin session'), originDirectory: directory(r.originDirectory),
      recipientId: text(r.recipientId, 'recipient ID'), kind: choice(r.kind, ['task', 'instruction'], 'request kind'),
      text: text(r.text, 'request text'), executionPolicy: choice(r.executionPolicy, ['advisory', 'code_change'], 'execution policy'),
      revision: number(r.revision, 'revision'),
      generation: number(r.generation, 'generation'), sequence: number(r.sequence, 'sequence'), deliveryId: text(r.deliveryId, 'delivery ID'),
      state: choice(r.state, ['queued', 'unknown', 'submitted', 'accepted', 'paused', 'completed', 'failed', 'cancelled'], 'request state'),
      createdAt: number(r.createdAt, 'createdAt'), updatedAt: number(r.updatedAt, 'updatedAt'),
    }
    if (result.revision < 1 || result.generation < 1 || result.sequence < 1) throw new Error('Corrupt request ordering or revision')
    if (r.messageId !== null) result.messageId = text(r.messageId, 'message ID')
    if (r.attemptedAt !== null) result.attemptedAt = number(r.attemptedAt, 'attemptedAt')
    if (r.mayContinue !== null) {
      if (r.mayContinue !== 0 && r.mayContinue !== 1) throw new Error('Corrupt cancellation flag')
      result.mayContinue = r.mayContinue === 1
    }
    if (r.summary !== null) result.summary = text(r.summary, 'summary')
    if (r.validation !== null) result.validation = choice(r.validation, ['pending', 'not_required'], 'validation')
    return result
  }

  request(id: string): Request { return this.readRequest(this.one(`${projection} WHERE r.id=?`, text(id, 'request ID'))) }

  list(sessionId: string): { inbox: Request[]; outbox: Request[] } {
    text(sessionId, 'session ID')
    return this.snapshot(() => ({
      inbox: this.all(`${projection} WHERE r.recipientId IN (SELECT id FROM agents WHERE sessionId=?) ORDER BY d.sequence`, sessionId).map(r => this.readRequest(r)),
      outbox: this.all(`${projection} WHERE r.originSessionId=? ORDER BY d.sequence`, sessionId).map(r => this.readRequest(r)),
    }))
  }

  pending(recipientId: string): Request | undefined {
    const r = this.db.query(`${projection} WHERE r.recipientId=? AND r.cancelledAt IS NULL AND t.requestId IS NULL
      AND (d.state IN ('queued','unknown','submitted') OR (d.state='accepted' AND r.kind='task'))
      ORDER BY d.sequence LIMIT 1`).get(text(recipientId, 'recipient ID'))
    return r ? this.readRequest(row(r)) : undefined
  }

  attempt(id: string, expectedGeneration: number, messageId: string): boolean {
    text(messageId, 'message ID')
    number(expectedGeneration, 'generation')
    return this.atomic(() => {
      const request = this.request(id)
      if (request.generation !== expectedGeneration || request.state !== 'queued' || this.closingAgent(request.recipientId) || this.pending(request.recipientId)?.id !== id) return false
      const now = Date.now()
      const changed = this.run(`UPDATE deliveries SET state='unknown',messageId=?,attemptedAt=? WHERE id=? AND state='queued'`, messageId, now, request.deliveryId)
      if (changed) {
        this.touchRequest(id)
        this.audit(id, `attempt:${expectedGeneration}`, request.originSessionId)
      }
      return changed === 1
    })
  }

  submitted(id: string, messageId: string): void {
    text(messageId, 'message ID')
    this.atomic(() => {
      const request = this.request(id)
      if (request.messageId !== messageId) throw new Error('Submission does not match current delivery intent')
      const d = this.one('SELECT * FROM deliveries WHERE id=?', request.deliveryId)
      if (d.state !== 'unknown' && d.state !== 'submitted' && d.state !== 'accepted') throw new Error('Delivery has no submission intent')
      if (d.submittedAt !== null) return
      const now = Date.now()
      this.run(`UPDATE deliveries SET state=CASE WHEN state='accepted' THEN state ELSE 'submitted' END,submittedAt=? WHERE id=?`, now, request.deliveryId)
      this.touchRequest(id)
      this.audit(id, `submitted:${request.generation}`, request.originSessionId)
    })
  }

  private recipient(request: Request, generation: number, sessionId: string): void {
    if (request.generation !== generation) throw new Error('Stale request generation')
    const agent = this.agent(request.recipientId)
    const d = this.one('SELECT * FROM deliveries WHERE id=?', request.deliveryId)
    if (sessionId !== agent.sessionId || sessionId !== d.sessionId) throw new Error('Only the exact recipient conversation may act')
    for (const key of ['socket', 'paneId', 'terminalId', 'workspaceId', 'directory'] as const) {
      if (agent[key] !== d[key]) throw new Error('Pinned delivery binding no longer matches agent')
    }
  }

  accept(id: string, generation: number, deliveryId: string, sessionId: string): Request {
    return this.atomic(() => {
      const request = this.request(id)
      this.recipient(request, generation, sessionId)
      if (request.deliveryId !== deliveryId || !request.messageId) throw new Error('Acceptance requires the exact attempted delivery')
      const d = this.one('SELECT * FROM deliveries WHERE id=?', deliveryId)
      if (d.state === 'accepted') return request
      if (d.state !== 'unknown' && d.state !== 'submitted') throw new Error('Delivery cannot be accepted')
      const now = Date.now()
      this.run("UPDATE deliveries SET state='accepted',acceptedAt=? WHERE id=?", now, deliveryId)
      this.touchRequest(id)
      this.audit(id, `accept:${generation}`, sessionId)
      return this.request(id)
    })
  }

  finish(id: string, generation: number, sessionId: string, outcome: Outcome): Request {
    const payload = {
      outcome: choice(outcome.outcome, ['completed', 'paused', 'failed'], 'outcome'),
      summary: text(outcome.summary, 'summary'), checks: strings(outcome.checks, 'checks'),
      risks: strings(outcome.risks, 'risks'), evidence: strings(outcome.evidence ?? [], 'evidence'),
    }
    return this.atomic(() => {
      const request = this.request(id)
      this.recipient(request, generation, sessionId)
      if (request.kind !== 'task') throw new Error('Instructions cannot have task results')
      const existing = this.db.query('SELECT * FROM results WHERE requestId=? AND generation=?').get(id, generation)
      if (existing) {
        const old = this.readResult(row(existing))
        if (json(payload) !== json({ outcome: old.outcome, summary: old.summary, checks: old.checks, risks: old.risks, evidence: old.evidence })) throw new Error('Conflicting result for immutable generation')
        return request
      }
      if (this.one('SELECT state FROM deliveries WHERE id=?', request.deliveryId).state !== 'accepted') throw new Error('Task must be accepted before handback')
      const now = Date.now()
      const validation = request.executionPolicy === 'code_change' ? 'pending' : 'not_required'
      this.run('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?)', id, generation, sessionId, payload.outcome, payload.summary,
        JSON.stringify(payload.checks), JSON.stringify(payload.risks), JSON.stringify(payload.evidence), validation, now)
      this.touchRequest(id)
      this.withdrawQuestions(id, generation)
      this.audit(id, `finish:${generation}:${payload.outcome}`, sessionId)
      this.scheduleNotice(id, `result:${generation}`, request.originSessionId, request.originDirectory,
        `${request.state === 'cancelled' ? 'Late outcome for cancelled request' : 'Request'} ${id} generation ${generation}: ${payload.outcome}. ${payload.summary}\nValidation: ${validation}.\nChecks: ${JSON.stringify(payload.checks)}\nRisks: ${JSON.stringify(payload.risks)}`)
      return this.request(id)
    })
  }

  cancel(id: string, originSessionId: string): Request {
    return this.atomic(() => {
      const request = this.request(id)
      this.owner(request, originSessionId)
      if (['cancelled', 'completed', 'failed'].includes(request.state) || (request.kind === 'instruction' && request.state === 'accepted')) return request
      const now = Date.now()
      this.run('UPDATE requests SET cancelledAt=?,mayContinue=? WHERE id=?', now, request.messageId ? 1 : 0, id)
      this.touchRequest(id)
      this.run("UPDATE deliveries SET state='cancelled' WHERE id=? AND state='queued'", request.deliveryId)
      this.withdrawQuestions(id, request.generation)
      this.audit(id, `cancel:${request.generation}`, originSessionId)
      return this.request(id)
    })
  }

  // Supplying expectedGeneration also guards fresh-key calls delayed across multiple pauses.
  resume(id: string, originSessionId: string, instructions: string, idempotencyKey: string, expectedGeneration?: number): Request {
    text(instructions, 'continuation text')
    text(idempotencyKey, 'idempotencyKey')
    if (expectedGeneration !== undefined) number(expectedGeneration, 'expectedGeneration')
    return this.atomic(() => {
      const request = this.request(id)
      this.owner(request, originSessionId)
      const duplicate = this.db.query('SELECT * FROM generations WHERE originSessionId=? AND resumeKey=?').get(originSessionId, idempotencyKey)
      if (duplicate) {
        const old = row(duplicate)
        if (old.requestId !== id || old.text !== instructions || (expectedGeneration !== undefined && old.generation !== expectedGeneration + 1)) throw new Error('Resume idempotency key payload conflict')
        if (old.generation !== request.generation) throw new Error('Stale resume generation')
        return request
      }
      if (expectedGeneration !== undefined && request.generation !== expectedGeneration) throw new Error('Stale resume generation')
      if (request.kind !== 'task' || request.state !== 'paused') throw new Error('Only paused, non-cancelled tasks may resume')
      if (this.closingAgent(request.recipientId)) throw new Error('Agent is reserved for closure or already closed')
      const agent = this.agent(request.recipientId)
      this.recipient(request, request.generation, agent.sessionId)
      const next = request.generation + 1
      const now = Date.now()
      this.run('INSERT INTO generations VALUES (?,?,?,?,?,?)', id, next, instructions, now, originSessionId, idempotencyKey)
      this.createDelivery(id, next, agent)
      this.run('UPDATE requests SET generation=? WHERE id=?', next, id)
      this.touchRequest(id)
      this.audit(id, `resume:${next}`, originSessionId)
      return this.request(id)
    })
  }

  private owner(request: Request, sessionId: string): void {
    if (request.originSessionId !== sessionId) throw new Error('Only the originating conversation may act')
  }

  private access(request: Request, sessionId: string): void {
    if (request.originSessionId !== sessionId && this.agent(request.recipientId).sessionId !== sessionId) throw new Error('Conversation cannot inspect this request')
  }

  ask(id: string, generation: number, sessionId: string, question: string): Question {
    text(question, 'question text')
    return this.atomic(() => {
      const request = this.request(id)
      this.recipient(request, generation, sessionId)
      if (request.kind !== 'task' || request.state !== 'accepted') throw new Error('Questions require an accepted active task')
      const questionId = randomUUID()
      this.run(`INSERT INTO questions(id,requestId,generation,sessionId,text,state,createdAt) VALUES (?,?,?,?,?,'open',?)`, questionId, id, generation, sessionId, question, Date.now())
      this.touchRequest(id)
      this.scheduleNotice(questionId, 'question', request.originSessionId, request.originDirectory, `Question ${questionId} for request ${id} generation ${generation}: ${question}`)
      this.audit(id, `ask:${generation}`, sessionId)
      return this.readQuestion(this.one('SELECT * FROM questions WHERE id=?', questionId))
    })
  }

  reply(questionId: string, originSessionId: string, answer: string): Question {
    text(answer, 'reply text')
    return this.atomic(() => {
      const question = this.readQuestion(this.one('SELECT * FROM questions WHERE id=?', questionId))
      const request = this.request(question.requestId)
      this.owner(request, originSessionId)
      if (question.generation !== request.generation) throw new Error('Stale question generation')
      if (question.state === 'answered') {
        if (question.reply?.text !== answer) throw new Error('Conflicting question reply')
        return question
      }
      if (question.state !== 'open' || request.state !== 'accepted') throw new Error('Question is no longer open on an active task')
      this.run("UPDATE questions SET state='answered',replySessionId=?,replyText=?,repliedAt=? WHERE id=?", originSessionId, answer, Date.now(), questionId)
      this.touchRequest(request.id)
      this.run("UPDATE notifications SET state='superseded' WHERE entityId=? AND state='pending'", questionId)
      const recipient = this.agent(request.recipientId)
      this.scheduleNotice(questionId, `reply:${question.generation}`, recipient.sessionId, recipient.directory,
        `Reply available for request ${request.id}, generation ${question.generation}, question ${questionId}. Read questions for this exact request and verify its current generation before using the answer. This notice is not a new assignment or permission to resume, run commands or act on a later generation.`)
      this.audit(request.id, `reply:${question.generation}`, originSessionId)
      return this.readQuestion(this.one('SELECT * FROM questions WHERE id=?', questionId))
    })
  }

  questions(id: string, sessionId: string): Question[] {
    return this.snapshot(() => {
      const request = this.request(id)
      this.access(request, sessionId)
      return this.all('SELECT * FROM questions WHERE requestId=? AND generation=? ORDER BY createdAt,id', id, request.generation).map(r => this.readQuestion(r))
    })
  }

  private readQuestion(r: Row): Question {
    const question: Question = {
      id: text(r.id, 'question ID'), requestId: text(r.requestId, 'request ID'), generation: number(r.generation, 'generation'),
      sessionId: text(r.sessionId, 'session ID'), text: text(r.text, 'question text'),
      state: choice(r.state, ['open', 'answered', 'withdrawn'], 'question state'), createdAt: number(r.createdAt, 'createdAt'),
    }
    if (question.state === 'answered') question.reply = { sessionId: text(r.replySessionId, 'reply session'), text: text(r.replyText, 'reply text'), at: number(r.repliedAt, 'reply time') }
    return question
  }

  private withdrawQuestions(id: string, generation: number): void {
    this.run(`UPDATE notifications SET state='superseded' WHERE state='pending' AND entityId IN
      (SELECT id FROM questions WHERE requestId=? AND generation=?)`, id, generation)
    this.run("UPDATE questions SET state='withdrawn' WHERE requestId=? AND generation=? AND state='open'", id, generation)
  }

  // Trusted backend API: callers must authenticate the destination conversation.
  scheduleNotice(entityId: string, eventKey: string, sessionId: string, path: string, message: string): Notice {
    text(entityId, 'notice entity ID')
    text(eventKey, 'notice event key')
    text(sessionId, 'notice session ID')
    directory(path)
    text(message, 'notice text')
    return this.atomic(() => {
      const old = this.db.query('SELECT * FROM notifications WHERE entityId=? AND eventKey=? AND sessionId=?').get(entityId, eventKey, sessionId)
      if (old) {
        const existing = row(old)
        if (existing.directory !== path || existing.text !== message) throw new Error('Notice idempotency payload conflict')
        return this.readNotice(existing)
      }
      const id = randomUUID()
      this.run(`INSERT INTO notifications(id,entityId,eventKey,sessionId,directory,text,state,createdAt)
        VALUES (?,?,?,?,?,?,'pending',?) ON CONFLICT(entityId,eventKey,sessionId) DO NOTHING`, id, entityId, eventKey, sessionId, path, message, Date.now())
      return this.readNotice(this.one('SELECT * FROM notifications WHERE id=?', id))
    })
  }

  private readNotice(r: Row): Notice {
    const notice: Notice = {
      id: text(r.id, 'notice ID'), sessionId: text(r.sessionId, 'session ID'), directory: directory(r.directory), text: text(r.text, 'notice text'),
      state: choice(r.state, ['pending', 'unknown', 'delivered', 'superseded'], 'notice state'),
    }
    if (r.messageId !== null) notice.messageId = text(r.messageId, 'message ID')
    return notice
  }

  notices(sessionId?: string): Notice[] {
    if (sessionId !== undefined) text(sessionId, 'session ID')
    return this.all(`SELECT * FROM notifications${sessionId === undefined ? '' : ' WHERE sessionId=?'} ORDER BY createdAt,rowid`, ...(sessionId === undefined ? [] : [sessionId])).map(r => this.readNotice(r))
  }

  noticeAttempt(id: string, messageId: string): boolean {
    text(id, 'notice ID')
    text(messageId, 'message ID')
    return this.atomic(() => {
      const target = this.db.query(`SELECT a.id FROM notifications n JOIN agents a ON a.sessionId=n.sessionId WHERE n.id=?`).get(id)
      if (target && this.closingAgent(text(row(target).id, 'notice recipient'))) return false
      return this.run("UPDATE notifications SET state='unknown',messageId=?,attemptedAt=? WHERE id=? AND state='pending'", messageId, Date.now(), id) === 1
    })
  }

  noticeDelivered(id: string, messageId: string): void {
    text(messageId, 'message ID')
    this.atomic(() => {
      const notice = this.one('SELECT * FROM notifications WHERE id=?', id)
      if (notice.messageId !== messageId || (notice.state !== 'unknown' && notice.state !== 'delivered')) throw new Error('Notice receipt does not match a delivery intent')
      if (notice.state === 'delivered') return
      this.run("UPDATE notifications SET state='delivered',deliveredAt=? WHERE id=?", Date.now(), id)
    })
  }

  private readResult(r: Row): TaskResult {
    return {
      requestId: text(r.requestId, 'request ID'), generation: number(r.generation, 'generation'), sessionId: text(r.sessionId, 'session ID'),
      outcome: choice(r.outcome, ['completed', 'paused', 'failed'], 'outcome'), summary: text(r.summary, 'summary'),
      checks: strings(JSON.parse(text(r.checks, 'checks')), 'checks'), risks: strings(JSON.parse(text(r.risks, 'risks')), 'risks'),
      evidence: strings(JSON.parse(text(r.evidence, 'evidence')), 'evidence'), validation: choice(r.validation, ['pending', 'not_required'], 'validation'),
      createdAt: number(r.createdAt, 'createdAt'),
    }
  }

  history(id: string, sessionId: string): History {
    return this.snapshot(() => {
      const request = this.request(id)
      this.access(request, sessionId)
      return {
        request,
        generations: this.all('SELECT * FROM generations WHERE requestId=? ORDER BY generation', id).map(r => ({ generation: number(r.generation, 'generation'), text: text(r.text, 'brief'), createdAt: number(r.createdAt, 'createdAt') })),
        deliveries: this.all('SELECT * FROM deliveries WHERE requestId=? ORDER BY generation', id).map(r => {
          const delivery: Delivery = {
            id: text(r.id, 'delivery ID'), requestId: id, generation: number(r.generation, 'generation'), sequence: number(r.sequence, 'sequence'),
            state: choice(r.state, ['queued', 'unknown', 'submitted', 'accepted', 'cancelled'], 'delivery state'),
            target: { sessionId: text(r.sessionId, 'session ID'), socket: text(r.socket, 'socket'), paneId: text(r.paneId, 'pane ID'), terminalId: text(r.terminalId, 'terminal ID'), workspaceId: text(r.workspaceId, 'workspace ID'), directory: directory(r.directory) },
          }
          if (r.messageId !== null) delivery.messageId = text(r.messageId, 'message ID')
          for (const key of ['attemptedAt', 'acceptedAt', 'submittedAt'] as const) if (r[key] !== null) delivery[key] = number(r[key], key)
          return delivery
        }),
        results: this.all('SELECT * FROM results WHERE requestId=? ORDER BY generation', id).map(r => this.readResult(r)),
        questions: this.all('SELECT * FROM questions WHERE requestId=? ORDER BY generation,createdAt,id', id).map(r => this.readQuestion(r)),
        audit: this.all('SELECT * FROM audit_events WHERE entityId=? ORDER BY id', id).map(r => ({
          id: number(r.id, 'audit ID'), entityId: text(r.entityId, 'audit entity ID'), transition: text(r.transition, 'audit transition'),
          sessionId: text(r.sessionId, 'audit session ID'), createdAt: number(r.createdAt, 'audit createdAt'),
        })),
      }
    })
  }

  beginOperation(kind: string, originSessionId: string, key: string, payload: Record<string, unknown>): Operation {
    text(kind, 'operation kind')
    text(originSessionId, 'originSessionId')
    text(key, 'idempotencyKey')
    row(payload)
    const encoded = json(payload)
    return this.atomic(() => {
      const old = this.db.query('SELECT * FROM operations WHERE kind=? AND originSessionId=? AND idempotencyKey=?').get(kind, originSessionId, key)
      if (old) {
        if (row(old).payload !== encoded) throw new Error('Operation idempotency key payload conflict')
        return this.readOperation(row(old))
      }
      const id = randomUUID()
      const now = Date.now()
      this.run("INSERT INTO operations VALUES (?,?,?,?,'requested',?,NULL,?,?)", id, kind, originSessionId, key, encoded, now, now)
      this.audit(id, 'operation:requested', originSessionId)
      return this.readOperation(this.one('SELECT * FROM operations WHERE id=?', id))
    })
  }

  cacheRemote(operationId: string, request: Request, history?: History): void {
    // Reuse request boundary validation without treating an external receipt as a SQL row.
    const validated = this.readRequest({ ...row(request), messageId: request.messageId ?? null, attemptedAt: request.attemptedAt ?? null,
      summary: request.summary ?? null, validation: request.validation ?? null,
      mayContinue: request.mayContinue === undefined ? null : request.mayContinue === true ? 1 : request.mayContinue === false ? 0 : -1 })
    const encodedRequest = json(validated)
    this.atomic(() => {
      const operation = this.readOperation(this.one('SELECT * FROM operations WHERE id=?', text(operationId, 'operation ID')))
      if (operation.kind !== 'remote.request') throw new Error('Remote cache requires a remote.request operation')
      const args = row(operation.payload.args)
      const peer = text(operation.payload.peerId, 'remote peer ID')
      const remoteMachine = text(operation.payload.expectedMachineId, 'remote machine ID')
      const path = directory(args.originDirectory)
      if (validated.originSessionId !== `remote:${this.machineId}:${encodeURIComponent(operation.originSessionId)}` ||
          validated.recipientId !== args.recipientId || validated.originDirectory !== path || validated.kind !== args.kind ||
          validated.executionPolicy !== (args.executionPolicy ?? 'advisory') ||
          (validated.generation === 1 && validated.text !== args.text)) throw new Error('Remote receipt does not match persisted origin or request intent')
      const previous = operation.result?.request === undefined ? undefined : row(operation.result.request)
      if (previous) {
        if (previous.id !== validated.id) throw new Error('Remote request identity changed')
        const revision = number(previous.revision, 'cached revision')
        if (validated.revision < revision) return
        if (validated.revision === revision && json(previous) !== encodedRequest) throw new Error('Conflicting remote request at the same revision')
      }
      const previousHistory = operation.result?.history
      if (history !== undefined) {
        row(history)
        if (json(history.request) !== encodedRequest || !Array.isArray(history.results) || !Array.isArray(history.questions) ||
            !Array.isArray(history.generations) || !Array.isArray(history.deliveries) || !Array.isArray(history.audit)) throw new Error('Invalid remote history snapshot')
        if (previousHistory && row(row(previousHistory).request).revision === validated.revision && json(previousHistory) !== json(history)) throw new Error('Conflicting remote history at the same revision')
        const resultGenerations = new Set<number>()
        for (const result of history.results) {
          row(result)
          if (result.requestId !== validated.id || number(result.generation, 'result generation') < 1 || result.generation > validated.generation || resultGenerations.has(result.generation)) throw new Error('Invalid remote result identity or generation')
          resultGenerations.add(result.generation)
          text(result.sessionId, 'result session ID')
          number(result.createdAt, 'result createdAt')
          choice(result.outcome, ['completed', 'paused', 'failed'], 'remote outcome')
          text(result.summary, 'remote summary')
          strings(result.checks, 'remote checks')
          strings(result.risks, 'remote risks')
          strings(result.evidence, 'remote evidence')
          choice(result.validation, ['pending', 'not_required'], 'remote validation')
          if (validated.executionPolicy === 'code_change' && result.validation !== 'pending') throw new Error('Remote code change must await validation')
          // Never include the mutable current request state in an immutable result notice.
          const entity = json(['remote', peer, remoteMachine, validated.id])
          this.scheduleNotice(entity, `result:${result.generation}`, operation.originSessionId, path,
            `Remote result from ${peer} for request ${validated.id} generation ${result.generation}: ${result.outcome}. ${result.summary}\nValidation: ${result.validation}.\nChecks: ${JSON.stringify(result.checks)}\nRisks: ${JSON.stringify(result.risks)}\nEvidence: ${JSON.stringify(result.evidence)}\nLate outcomes for cancelled requests do not clear cancellation or authorise further work.`)
        }
        const questionIds = new Set<string>()
        for (const question of history.questions) {
          row(question)
          text(question.id, 'remote question ID')
          if (question.requestId !== validated.id || number(question.generation, 'question generation') < 1 || question.generation > validated.generation || questionIds.has(question.id)) throw new Error('Invalid remote question identity or generation')
          questionIds.add(question.id)
          text(question.sessionId, 'question session ID')
          text(question.text, 'question text')
          number(question.createdAt, 'question createdAt')
          choice(question.state, ['open', 'answered', 'withdrawn'], 'remote question state')
          const entity = json(['remote', peer, remoteMachine, validated.id, question.id])
          if (question.state === 'open' && question.generation === validated.generation && validated.state === 'accepted') {
            this.scheduleNotice(entity, `question:${question.generation}`, operation.originSessionId, path,
              `Remote question from ${peer} for request ${validated.id} generation ${question.generation}, question ${question.id}: ${question.text}`)
          } else {
            this.run("UPDATE notifications SET state='superseded' WHERE entityId=? AND sessionId=? AND state='pending'", entity, operation.originSessionId)
          }
        }
      }
      const savedHistory = history ?? previousHistory
      if (savedHistory !== undefined) {
        for (const question of (row(savedHistory).questions as Question[])) {
          if (validated.state !== 'accepted' || question.generation !== validated.generation) {
            this.run("UPDATE notifications SET state='superseded' WHERE entityId=? AND sessionId=? AND state='pending'",
              json(['remote', peer, remoteMachine, validated.id, question.id]), operation.originSessionId)
          }
        }
      }
      const result = { request: validated, ...(savedHistory === undefined ? {} : { history: savedHistory }) }
      this.run("UPDATE operations SET state='confirmed',result=?,updatedAt=MAX(updatedAt+1,?) WHERE id=?", json(result), Date.now(), operationId)
    })
  }

  failRemote(operationId: string, observedUpdatedAt: number): void {
    text(operationId, 'operation ID')
    number(observedUpdatedAt, 'observed updatedAt')
    this.atomic(() => {
      const operation = this.readOperation(this.one('SELECT * FROM operations WHERE id=?', operationId))
      if (operation.kind !== 'remote.request') throw new Error('Remote failure requires a remote.request operation')
      this.run("UPDATE operations SET state='unknown',updatedAt=MAX(updatedAt+1,?) WHERE id=? AND updatedAt=?", Date.now(), operationId, observedUpdatedAt)
    })
  }

  updateOperation(id: string, state: string, result: Record<string, unknown>): Operation {
    text(state, 'operation state')
    row(result)
    const encoded = json(result)
    return this.atomic(() => {
      const operation = this.readOperation(this.one('SELECT * FROM operations WHERE id=?', id))
      if (operation.kind === 'open_agent') {
        if (operation.result?.expectedSessionId !== undefined && result.expectedSessionId !== operation.result.expectedSessionId) throw new Error('Checkpointed expectedSessionId is immutable')
        if (result.expectedSessionId !== undefined) text(result.expectedSessionId, 'expectedSessionId')
        if (operation.state === 'ready' && state !== 'ready') throw new Error('Verified provision readiness is immutable')
      }
      if (operation.kind === 'open_agent' && operation.result?.sessionId !== undefined &&
          (state !== 'ready' || ['sessionId', 'identity', 'paneId', 'terminalId', 'workspaceId', 'destination', 'launchAttempted'].some(key => result[key] !== operation.result![key]))) throw new Error('Verified provision binding is immutable')
      if (operation.kind === 'close_agent') {
        if (operation.state === 'closed' && state !== 'closed') throw new Error('Confirmed closure cannot be reopened')
        if (operation.result?.effect === 'pane_close' && state !== 'closed' && !['uncertain', 'closing'].includes(state)) throw new Error('Attempted close must retain its uncertain reservation')
        if (['authorising', 'closing', 'uncertain', 'closed'].includes(state) || result.effect === 'pane_close') {
          const identity = text(operation.payload.identity, 'close identity')
          this.agent(identity)
          if (this.otherClose(identity, id) || this.pending(identity) ||
              (!['authorising', 'closing', 'uncertain', 'closed'].includes(operation.state) && this.pendingNotice(identity))) throw new Error('Close conflicts with another reservation or pending request/notice')
        }
      }
      this.run('UPDATE operations SET state=?,result=?,updatedAt=MAX(updatedAt+1,?) WHERE id=?', state, encoded, Date.now(), id)
      if (operation.state !== state) this.audit(id, `operation:${state}`, operation.originSessionId)
      return this.readOperation(this.one('SELECT * FROM operations WHERE id=?', id))
    })
  }

  claimOperation(id: string, expectedState: string, nextState: string): boolean {
    text(id, 'operation ID')
    text(expectedState, 'expected operation state')
    text(nextState, 'next operation state')
    if (expectedState === nextState) throw new Error('Operation claim must change state')
    return this.atomic(() => {
      const found = this.db.query('SELECT * FROM operations WHERE id=?').get(id)
      if (!found) return false
      const operation = this.readOperation(row(found))
      if (operation.state !== expectedState) return false
      if (operation.kind === 'open_agent' && (operation.state === 'ready' || operation.result?.sessionId !== undefined)) return false
      if (operation.kind === 'close_agent') {
        if (operation.state === 'closed') return false
        if (operation.result?.effect === 'pane_close' && !['uncertain', 'closing', 'closed'].includes(nextState)) return false
        if (['authorising', 'closing', 'uncertain', 'closed'].includes(nextState)) {
          const identity = text(operation.payload.identity, 'close identity')
          this.agent(identity)
          if (this.otherClose(identity, id) || this.pending(identity) || this.pendingNotice(identity)) return false
        }
      }
      const changed = this.run('UPDATE operations SET state=?,updatedAt=MAX(updatedAt+1,?) WHERE id=? AND state=?', nextState, Date.now(), id, expectedState)
      if (changed) this.audit(id, `claim:${expectedState}:${nextState}`, operation.originSessionId)
      return changed === 1
    })
  }

  private otherClose(identity: string, exceptId: string): boolean {
    return !!this.db.query(`SELECT id FROM operations WHERE kind='close_agent' AND json_extract(payload, '$.identity')=?
      AND id!=? AND ${closeReservation} LIMIT 1`).get(identity, exceptId)
  }

  private pendingNotice(identity: string): boolean {
    return !!this.db.query(`SELECT n.id FROM notifications n JOIN agents a ON a.sessionId=n.sessionId
      WHERE a.id=? AND n.state IN ('pending','unknown') LIMIT 1`).get(identity)
  }

  closingAgent(identity: string): boolean {
    text(identity, 'agent identity')
    return this.otherClose(identity, '')
  }

  // Omitting origin is reserved for trusted backend restart reconciliation.
  operations(originSessionId?: string): Operation[] {
    if (originSessionId !== undefined) text(originSessionId, 'originSessionId')
    return this.all(`SELECT * FROM operations${originSessionId === undefined ? '' : ' WHERE originSessionId=?'} ORDER BY createdAt,rowid`, ...(originSessionId === undefined ? [] : [originSessionId])).map(r => this.readOperation(r))
  }

  private readOperation(r: Row): Operation {
    const operation: Operation = {
      id: text(r.id, 'operation ID'), kind: text(r.kind, 'operation kind'), originSessionId: text(r.originSessionId, 'originSessionId'),
      state: text(r.state, 'operation state'), payload: row(JSON.parse(text(r.payload, 'operation payload'))),
      createdAt: number(r.createdAt, 'createdAt'), updatedAt: number(r.updatedAt, 'updatedAt'),
    }
    if (r.result !== null) operation.result = row(JSON.parse(text(r.result, 'operation result')))
    return operation
  }
}
