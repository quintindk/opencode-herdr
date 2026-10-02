import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import type { Agent, Outcome, Request } from '../src/model.js'
import { Provisioner, type ProvisionRunner } from '../src/provision.js'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import { remoteSession } from '../src/remote.js'

const stores: Store[] = []
const directories: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-store-'))
  directories.push(dir)
  const path = join(dir, 'coordination.sqlite')
  const store = open(path)
  const agent = observe(store)
  return { dir, path, store, agent }
}
function open(path: string): Store {
  const store = new Store(path)
  stores.push(store)
  return store
}
function observe(store: Store, overrides: Partial<Agent> = {}): Agent {
  return store.observeAgent({
    sessionId: 'recipient', socket: '/tmp/opencode.sock', paneId: 'pane', terminalId: 'terminal',
    workspaceId: 'workspace', directory: '/project', label: 'Worker', state: 'idle', lastSeen: Date.now(), ...overrides,
  })
}
function enqueue(store: Store, agent: Agent, overrides: Partial<Parameters<Store['enqueue']>[0]> = {}): Request {
  return store.enqueue({ originSessionId: 'origin', originDirectory: '/origin', recipientId: agent.id,
    kind: 'task', text: 'Original brief', idempotencyKey: crypto.randomUUID(), ...overrides })
}
function accept(store: Store, request: Request, sessionId = 'recipient'): Request {
  const messageId = crypto.randomUUID()
  expect(store.attempt(request.id, request.generation, messageId)).toBe(true)
  store.submitted(request.id, messageId)
  return store.accept(request.id, request.generation, request.deliveryId, sessionId)
}
const completed: Outcome = { outcome: 'completed', summary: 'Checked the task', checks: ['bun test passed'], risks: [] }
const paused: Outcome = { outcome: 'paused', summary: 'Waiting for clarification', checks: [], risks: [] }

function remoteFixture() {
  const { store: sender, path, dir } = fixture()
  const receiver = open(join(dir, 'receiver.sqlite'))
  const agent = observe(receiver)
  const args = { originDirectory: '/origin', recipientId: agent.id, kind: 'task' as const, text: 'Remote brief', executionPolicy: 'code_change' as const, idempotencyKey: 'remote-key' }
  const operation = sender.beginOperation('remote.request', 'origin:session', args.idempotencyKey, { peerId: 'peer', expectedMachineId: receiver.machineId, args })
  const request = receiver.enqueue({ ...args, originSessionId: remoteSession(sender.machineId, 'origin:session') })
  const current = () => sender.operations('origin:session')[0]
  const sync = () => {
    const history = receiver.history(request.id, request.originSessionId)
    sender.cacheRemote(operation.id, history.request, history)
    return history
  }
  return { sender, receiver, agent, operation, request, current, sync, path }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('identity and persistence', () => {
  test('persistent machine identity, stable agents and restrictive permissions', () => {
    const { store, agent, path, dir } = fixture()
    const second = open(path)
    expect(second.machineId).toBe(store.machineId)
    expect(second.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(observe(second, { label: 'Updated', state: 'busy' }).id).toBe(agent.id)
    expect(store.agent(agent.id).label).toBe('Updated')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(path + '-wal').mode & 0o777).toBe(0o600)
    expect(statSync(path + '-shm').mode & 0o777).toBe(0o600)
    for (const field of ['socket', 'terminalId', 'paneId', 'workspaceId', 'directory'] as const) {
      expect(() => observe(store, { [field]: '/different' })).toThrow('binding changed')
    }
    const replacement = observe(store, { sessionId: 'replacement' })
    expect(replacement.id).not.toBe(agent.id)
    expect(store.agents()).toHaveLength(2)
    expect(store.agent(agent.id).management).toBe('independent')
  })

  test('management observations persist without inferring ownership from requests', () => {
    const { store, agent } = fixture()
    expect(() => observe(store, { management: 'managed', managerSessionId: 'manager' })).toThrow('cannot change')
    const managed = observe(store, { sessionId: 'managed-session', management: 'managed', managerSessionId: 'manager' })
    expect(observe(store, { sessionId: managed.sessionId }).managerSessionId).toBe('manager')
    enqueue(store, agent)
    expect(store.agent(agent.id).managerSessionId).toBeUndefined()
    expect(() => observe(store, { sessionId: managed.sessionId, management: 'managed', managerSessionId: 'another-manager' })).toThrow('cannot change')
    expect(() => observe(store, { sessionId: managed.sessionId, management: 'independent' })).toThrow('cannot change')
    expect(() => observe(store, { management: 'independent', managerSessionId: 'manager' })).toThrow()
    expect(observe(store, { management: 'independent' }).managerSessionId).toBeUndefined()
  })

  test('default path honours XDG_CONFIG_HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-xdg-'))
    directories.push(dir)
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      const store = new Store()
      stores.push(store)
      expect(statSync(join(dir, 'opencode', 'opencode-herdr', 'coordination.sqlite')).isFile()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })

  test('rejects invalid input and missing records', () => {
    const { store, agent } = fixture()
    expect(() => observe(store, { sessionId: '' })).toThrow()
    expect(() => observe(store, { directory: 'relative' })).toThrow()
    expect(() => enqueue(store, agent, { text: '   ' })).toThrow()
    expect(() => enqueue(store, agent, { kind: 'bogus' as 'task' })).toThrow()
    expect(() => enqueue(store, agent, { executionPolicy: 'bogus' as 'advisory' })).toThrow()
    expect(() => enqueue(store, agent, { recipientId: 'missing' })).toThrow()
    expect(() => store.request('missing')).toThrow()
    expect(store.list('origin').outbox).toEqual([])
  })
})

describe('FIFO and submission intent', () => {
  test('multiple connections share ordered sequences and one claim across origins', () => {
    const { store, agent, path } = fixture()
    const second = open(path)
    const first = enqueue(store, agent)
    const next = enqueue(second, agent, { originSessionId: 'other', kind: 'instruction' })
    expect(next.sequence).toBeGreaterThan(first.sequence)
    expect(second.pending(agent.id)?.id).toBe(first.id)
    expect(second.attempt(next.id, 1, 'next-message')).toBe(false)
    expect(store.attempt(first.id, 2, 'stale-message')).toBe(false)
    expect(store.attempt(first.id, 1, 'message')).toBe(true)
    expect(second.attempt(first.id, 1, 'duplicate-message')).toBe(false)
    expect(second.pending(agent.id)?.state).toBe('unknown')
    expect(second.attempt(next.id, 1, 'next-message')).toBe(false)
    const restarted = open(path)
    expect(restarted.attempt(first.id, 1, 'restart-message')).toBe(false)
    expect(restarted.request(first.id).messageId).toBe('message')
    expect(restarted.request(first.id).attemptedAt).toBeNumber()
    store.submitted(first.id, 'message')
    expect(second.pending(agent.id)?.state).toBe('submitted')
    store.accept(first.id, 1, first.deliveryId, agent.sessionId)
    expect(second.attempt(next.id, 1, 'next-message')).toBe(false)
    store.finish(first.id, 1, agent.sessionId, completed)
    expect(second.pending(agent.id)?.id).toBe(next.id)
    expect(second.attempt(next.id, 1, 'next-message')).toBe(true)
  })

  test('payload-sensitive deduplication is origin scoped and survives resume', () => {
    const { store, agent, path } = fixture()
    const first = enqueue(store, agent, { idempotencyKey: 'key' })
    const second = open(path)
    expect(enqueue(second, agent, { idempotencyKey: 'key', executionPolicy: 'advisory' })).toEqual(first)
    for (const change of [{ text: 'changed' }, { originDirectory: '/elsewhere' }, { kind: 'instruction' as const }, { executionPolicy: 'code_change' as const }]) {
      expect(() => enqueue(second, agent, { idempotencyKey: 'key', ...change })).toThrow('payload conflict')
    }
    expect(enqueue(second, agent, { idempotencyKey: 'key', originSessionId: 'other' }).id).not.toBe(first.id)
    accept(store, first)
    store.finish(first.id, 1, agent.sessionId, paused)
    const resumed = store.resume(first.id, 'origin', 'New brief', 'resume', 1)
    expect(enqueue(second, agent, { idempotencyKey: 'key' })).toEqual(resumed)
  })

  test('list filters exact conversations, not directories, prefixes or labels', () => {
    const { store, agent } = fixture()
    const a = enqueue(store, agent)
    const b = enqueue(store, agent, { originSessionId: 'origin-other' })
    const other = observe(store, { sessionId: 'recipient-other' })
    const c = enqueue(store, other, { originSessionId: 'origin-other' })
    expect(store.list('origin').outbox.map(r => r.id)).toEqual([a.id])
    expect(store.list('recipient').inbox.map(r => r.id)).toEqual([a.id, b.id])
    expect(store.list('recipient-other').inbox.map(r => r.id)).toEqual([c.id])
    expect(store.list('origin-new')).toEqual({ inbox: [], outbox: [] })
    expect(store.list('Worker')).toEqual({ inbox: [], outbox: [] })
  })

  test('acceptance pins conversation, generation, delivery and actual attempt', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    expect(() => store.accept(request.id, 1, request.deliveryId, agent.sessionId)).toThrow('attempted delivery')
    expect(store.attempt(request.id, 1, 'message')).toBe(true)
    expect(() => store.accept(request.id, 1, request.deliveryId, 'intruder')).toThrow('exact recipient')
    expect(() => store.accept(request.id, 2, request.deliveryId, agent.sessionId)).toThrow('Stale')
    expect(() => store.accept(request.id, 1, 'wrong', agent.sessionId)).toThrow('exact attempted')
    expect(() => store.submitted(request.id, 'wrong')).toThrow('intent')
    const accepted = store.accept(request.id, 1, request.deliveryId, agent.sessionId)
    expect(accepted.state).toBe('accepted')
    expect(store.accept(request.id, 1, request.deliveryId, agent.sessionId)).toEqual(accepted)
    store.submitted(request.id, 'message')
    expect(store.request(request.id).state).toBe('accepted')
    const confirmed = store.request(request.id)
    store.submitted(request.id, 'message')
    expect(store.request(request.id)).toEqual(confirmed)
  })
})

describe('results and cancellation', () => {
  test('one immutable result per generation and no automatic verification', () => {
    const { store, agent, path } = fixture()
    const request = enqueue(store, agent, { executionPolicy: 'code_change' })
    expect(() => store.finish(request.id, 1, agent.sessionId, completed)).toThrow('accepted')
    accept(store, request)
    expect(() => store.finish(request.id, 1, 'intruder', completed)).toThrow('exact recipient')
    const finished = store.finish(request.id, 1, agent.sessionId, completed)
    expect(finished.state).toBe('completed')
    expect(finished.validation).toBe('pending')
    const second = open(path)
    expect(second.finish(request.id, 1, agent.sessionId, { ...completed, evidence: [] })).toEqual(finished)
    for (const change of [{ summary: 'Different' }, { checks: [] }, { evidence: ['new'] }, { risks: ['risk'] }, { outcome: 'failed' as const }]) {
      expect(() => second.finish(request.id, 1, agent.sessionId, { ...completed, ...change })).toThrow('Conflicting result')
    }
    expect(store.history(request.id, 'origin').results).toHaveLength(1)
    expect(store.notices('origin')).toHaveLength(1)
    expect(store.pending(agent.id)).toBeUndefined()
    expect(store.cancel(request.id, 'origin')).toEqual(finished)
    expect(() => store.resume(request.id, 'origin', 'Continue', 'resume')).toThrow('Only paused')
  })

  test('cancellation before intent prevents dispatch and late acceptance', () => {
    const { store, agent, path } = fixture()
    const request = enqueue(store, agent)
    const next = enqueue(store, agent)
    expect(() => store.cancel(request.id, 'intruder')).toThrow('originating')
    const cancelled = store.cancel(request.id, 'origin')
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.mayContinue).toBe(false)
    expect(open(path).attempt(request.id, 1, 'message')).toBe(false)
    expect(store.cancel(request.id, 'origin')).toEqual(cancelled)
    expect(() => store.accept(request.id, 1, request.deliveryId, agent.sessionId)).toThrow()
    expect(store.pending(agent.id)?.id).toBe(next.id)
  })

  test('intent wins cancellation race and late outcomes preserve cancelled state', () => {
    const { store, agent, path } = fixture()
    const second = open(path)
    const request = enqueue(store, agent)
    const next = enqueue(second, agent)
    expect(store.attempt(request.id, 1, 'message')).toBe(true)
    expect(second.cancel(request.id, 'origin').mayContinue).toBe(true)
    expect(second.pending(agent.id)?.id).toBe(next.id)
    expect(() => store.finish(request.id, 1, agent.sessionId, completed)).toThrow('accepted')
    store.submitted(request.id, 'message')
    expect(store.accept(request.id, 1, request.deliveryId, agent.sessionId).state).toBe('cancelled')
    const late = store.finish(request.id, 1, agent.sessionId, completed)
    expect(late.state).toBe('cancelled')
    expect(late.mayContinue).toBe(true)
    expect(late.summary).toBe(completed.summary)
    expect(store.finish(request.id, 1, agent.sessionId, completed)).toEqual(late)
    expect(store.history(request.id, 'origin').results[0].outcome).toBe('completed')
    expect(store.notices('origin')[0].text).toContain('Late outcome for cancelled request')
    expect(store.pending(agent.id)?.id).toBe(next.id)
  })

  test('accepted instruction releases slot without task result or notice', () => {
    const { store, agent } = fixture()
    const instruction = enqueue(store, agent, { kind: 'instruction' })
    const next = enqueue(store, agent)
    const accepted = accept(store, instruction)
    expect(accepted.state).toBe('accepted')
    expect(store.pending(agent.id)?.id).toBe(next.id)
    expect(store.notices()).toEqual([])
    expect(store.cancel(instruction.id, 'origin')).toEqual(accepted)
    expect(() => store.finish(instruction.id, 1, agent.sessionId, completed)).toThrow('Instructions')
    expect(() => store.ask(instruction.id, 1, agent.sessionId, 'Question?')).toThrow()
    expect(() => store.resume(instruction.id, 'origin', 'Continue', 'key')).toThrow()
  })

  test('cancelled instruction may accept late but cannot create a result', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent, { kind: 'instruction' })
    store.attempt(request.id, 1, 'message')
    store.cancel(request.id, 'origin')
    expect(store.accept(request.id, 1, request.deliveryId, agent.sessionId).state).toBe('cancelled')
    expect(store.history(request.id, 'origin').deliveries[0].state).toBe('accepted')
    expect(store.pending(agent.id)).toBeUndefined()
    expect(() => store.finish(request.id, 1, agent.sessionId, completed)).toThrow('Instructions')
  })
})

describe('questions and immutable resume history', () => {
  test('questions retain queue slots and replies are exact and immutable', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    expect(() => store.ask(request.id, 1, agent.sessionId, 'Question?')).toThrow('accepted')
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Include authentication?')
    expect(store.pending(agent.id)?.id).toBe(request.id)
    expect(store.notices('origin')[0].text).toContain(question.id)
    expect(() => store.reply(question.id, 'other', 'Yes')).toThrow('originating')
    expect(() => store.questions(request.id, 'other')).toThrow('inspect')
    const answer = store.reply(question.id, 'origin', 'Yes')
    expect(answer.reply?.text).toBe('Yes')
    expect(store.reply(question.id, 'origin', 'Yes')).toEqual(answer)
    expect(() => store.reply(question.id, 'origin', 'No')).toThrow('Conflicting')
    expect(store.questions(request.id, agent.sessionId)).toEqual([answer])
    expect(store.notices('origin')[0].state).toBe('superseded')
    const openQuestion = store.ask(request.id, 1, agent.sessionId, 'Another question?')
    store.finish(request.id, 1, agent.sessionId, completed)
    expect(store.questions(request.id, 'origin').find(q => q.id === openQuestion.id)?.state).toBe('withdrawn')
    expect(() => store.reply(openQuestion.id, 'origin', 'Too late')).toThrow('no longer open')
  })

  test('pause and resume preserve briefs, attempts, results, questions and FIFO position', () => {
    const { store, agent, path } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Before pause?')
    const firstResult = store.finish(request.id, 1, agent.sessionId, paused)
    const next = enqueue(store, agent)
    expect(() => store.resume(request.id, 'intruder', 'Continue', 'resume', 1)).toThrow('originating')
    const resumed = store.resume(request.id, 'origin', 'Continuation brief', 'resume', 1)
    expect(resumed.generation).toBe(2)
    expect(resumed.sequence).toBeGreaterThan(next.sequence)
    expect(resumed.deliveryId).not.toBe(request.deliveryId)
    expect(resumed.text).toBe('Continuation brief')
    expect(resumed.state).toBe('queued')
    expect(resumed.summary).toBeUndefined()
    expect(resumed.messageId).toBeUndefined()
    expect(resumed.validation).toBeUndefined()
    expect(open(path).resume(request.id, 'origin', 'Continuation brief', 'resume', 1)).toEqual(resumed)
    expect(() => store.resume(request.id, 'origin', 'Changed', 'resume', 1)).toThrow('payload conflict')
    expect(() => store.accept(request.id, 1, request.deliveryId, agent.sessionId)).toThrow('Stale')
    expect(() => store.finish(request.id, 1, agent.sessionId, paused)).toThrow('Stale')
    expect(() => store.reply(question.id, 'origin', 'Too late')).toThrow('Stale')
    expect(store.questions(request.id, agent.sessionId)).toEqual([])
    expect(store.attempt(request.id, 2, 'jump-ahead')).toBe(false)
    store.cancel(next.id, 'origin')
    accept(store, resumed)
    store.finish(request.id, 2, agent.sessionId, paused)
    expect(() => store.resume(request.id, 'origin', 'Stale fresh key', 'stale', 1)).toThrow('Stale')
    store.resume(request.id, 'origin', 'Third brief', 'third', 2)
    expect(() => store.resume(request.id, 'origin', 'Continuation brief', 'resume', 1)).toThrow('Stale')
    const history = store.history(request.id, 'origin')
    expect(history.generations.map(g => g.text)).toEqual(['Original brief', 'Continuation brief', 'Third brief'])
    expect(history.deliveries).toHaveLength(3)
    expect(history.deliveries[0].messageId).toBe(firstResult.messageId)
    expect(history.results).toHaveLength(2)
    expect(history.questions[0].state).toBe('withdrawn')
    expect(store.history(request.id, agent.sessionId)).toEqual(history)
    expect(() => store.history(request.id, 'other')).toThrow('inspect')
  })

  test('cancelling accepted or paused work withdraws questions and never resumes', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Question?')
    store.cancel(request.id, 'origin')
    expect(store.questions(request.id, 'origin')[0].state).toBe('withdrawn')
    expect(() => store.reply(question.id, 'origin', 'Late')).toThrow()
    store.finish(request.id, 1, agent.sessionId, paused)
    expect(() => store.resume(request.id, 'origin', 'Continue', 'resume')).toThrow('Only paused')
    const other = enqueue(store, agent)
    accept(store, other)
    store.finish(other.id, 1, agent.sessionId, paused)
    expect(store.cancel(other.id, 'origin').state).toBe('cancelled')
    expect(() => store.resume(other.id, 'origin', 'Continue', 'resume-other')).toThrow('Only paused')
  })
})

describe('durable transactional notifications', () => {
  test('claims are durable, matching receipts only and no blind replay', () => {
    const { store, agent, path } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    store.finish(request.id, 1, agent.sessionId, completed)
    const notice = store.notices('origin')[0]
    const second = open(path)
    expect(second.notices('other')).toEqual([])
    expect(() => store.noticeDelivered(notice.id, 'unattempted')).toThrow('intent')
    expect(store.noticeAttempt(notice.id, 'notice-message')).toBe(true)
    expect(second.noticeAttempt(notice.id, 'duplicate')).toBe(false)
    expect(open(path).notices('origin')[0].state).toBe('unknown')
    expect(() => second.noticeDelivered(notice.id, 'wrong')).toThrow('intent')
    second.noticeDelivered(notice.id, 'notice-message')
    store.noticeDelivered(notice.id, 'notice-message')
    expect(store.notices('origin')[0].state).toBe('delivered')
    expect(store.noticeAttempt(notice.id, 'again')).toBe(false)
  })

  test('result, question withdrawal, queue release and notice insert roll back together', () => {
    const { store, agent, path } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Question?')
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END")
      expect(() => store.finish(request.id, 1, agent.sessionId, completed)).toThrow('injected notification failure')
      expect(store.request(request.id).state).toBe('accepted')
      expect(store.history(request.id, 'origin').results).toEqual([])
      expect(store.pending(agent.id)?.id).toBe(request.id)
      expect(store.questions(request.id, 'origin')[0].state).toBe('open')
      expect(store.notices('origin')[0].state).toBe('pending')
      expect(() => store.ask(request.id, 1, agent.sessionId, 'Unstored question')).toThrow('injected')
      expect(store.questions(request.id, 'origin').map(q => q.id)).toEqual([question.id])
      db.exec('DROP TRIGGER reject_notice')
      store.finish(request.id, 1, agent.sessionId, completed)
      expect(store.request(request.id).state).toBe('completed')
      expect(store.questions(request.id, 'origin')[0].state).toBe('withdrawn')
      expect(store.notices('origin').filter(n => n.state === 'pending')).toHaveLength(1)
    } finally { db.close() }
  })

  test('withdrawal does not erase unknown question notification evidence', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    store.ask(request.id, 1, agent.sessionId, 'Question?')
    const notice = store.notices()[0]
    store.noticeAttempt(notice.id, 'message')
    store.finish(request.id, 1, agent.sessionId, completed)
    expect(store.notices().find(n => n.id === notice.id)?.state).toBe('unknown')
    expect(store.noticeAttempt(notice.id, 'retry')).toBe(false)
    store.noticeDelivered(notice.id, 'message')
    expect(store.notices().find(n => n.id === notice.id)?.state).toBe('delivered')
  })
})

describe('schema and operation checkpoints', () => {
  test('explicit migration, integrity settings and immutable SQL constraints', () => {
    const { path, store, agent } = fixture()
    const db = new Database(path)
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 })
      expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      // These pragmas are connection-local. Inspect the actual store connection.
      const connection = (store as unknown as { db: Database }).db
      expect(connection.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(connection.query('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
      expect(connection.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 1000 })
      const request = enqueue(store, agent)
      expect(() => db.query("UPDATE generations SET text='changed' WHERE requestId=?").run(request.id)).toThrow('immutable')
      accept(store, request)
      store.finish(request.id, 1, agent.sessionId, completed)
      expect(() => db.query("UPDATE results SET summary='changed' WHERE requestId=?").run(request.id)).toThrow('immutable')
      expect(() => db.query("UPDATE deliveries SET state='nonsense' WHERE requestId=?").run(request.id)).toThrow()
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    } finally { db.close() }
  })

  test('unsupported migrations are refused without rewriting version or data', () => {
    const { path } = fixture()
    const db = new Database(path)
    try {
      db.exec('PRAGMA user_version=99')
      expect(() => new Store(path)).toThrow('Unsupported coordination schema version 99')
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 99 })
      expect(db.query('SELECT * FROM agents').all()).toHaveLength(1)
    } finally { db.close() }
  })

  test('corrupt files and malformed persisted records are not reset or swallowed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-corrupt-'))
    directories.push(dir)
    const path = join(dir, 'coordination.sqlite')
    writeFileSync(path, 'not a SQLite database')
    expect(() => new Store(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('not a SQLite database')
    const { store, agent, path: validPath } = fixture()
    const db = new Database(validPath)
    try {
      db.exec('PRAGMA ignore_check_constraints=ON')
      db.query("UPDATE agents SET management='bogus' WHERE id=?").run(agent.id)
      expect(() => store.agents()).toThrow('management')
    } finally { db.close() }
  })

  test('existing schema never regenerates a missing or corrupt machine identity', () => {
    const { path } = fixture()
    const db = new Database(path)
    try {
      db.exec("UPDATE metadata SET value='invalid' WHERE key='machineId'")
      expect(() => new Store(path)).toThrow('Corrupt machine ID')
      db.exec("DELETE FROM metadata WHERE key='machineId'")
      expect(() => new Store(path)).toThrow('Missing or corrupt')
      expect(db.query('SELECT * FROM metadata').all()).toEqual([])
    } finally { db.close() }
  })

  test('delivery allocation failure rolls back request, generation and dedupe key', () => {
    const { store, agent, path } = fixture()
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'injected delivery failure'); END")
      expect(() => enqueue(store, agent, { idempotencyKey: 'key' })).toThrow('injected delivery failure')
      expect(store.list('origin').outbox).toEqual([])
      expect(db.query('SELECT * FROM requests').all()).toEqual([])
      expect(db.query('SELECT * FROM generations').all()).toEqual([])
      db.exec('DROP TRIGGER reject_delivery')
      const request = enqueue(store, agent, { idempotencyKey: 'key' })
      accept(store, request)
      store.finish(request.id, 1, agent.sessionId, paused)
      db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'injected delivery failure'); END")
      expect(() => store.resume(request.id, 'origin', 'Continue', 'resume', 1)).toThrow('injected delivery failure')
      expect(store.request(request.id).generation).toBe(1)
      expect(store.request(request.id).state).toBe('paused')
      expect(store.history(request.id, 'origin').generations).toHaveLength(1)
      db.exec('DROP TRIGGER reject_delivery')
      expect(store.resume(request.id, 'origin', 'Continue', 'resume', 1).generation).toBe(2)
    } finally { db.close() }
  })

  test('operation dedupe is canonical, scoped and keeps immutable intent', () => {
    const { store, path } = fixture()
    const operation = store.beginOperation('provision', 'origin', 'key', { folder: '/project', config: { b: 2, a: 1 } })
    expect(operation.state).toBe('requested')
    const second = open(path)
    expect(second.beginOperation('provision', 'origin', 'key', { config: { a: 1, b: 2 }, folder: '/project' })).toEqual(operation)
    expect(() => store.beginOperation('provision', 'origin', 'key', { folder: '/different' })).toThrow('payload conflict')
    store.updateOperation(operation.id, 'uncertain', { paneId: 'pane', steps: ['launched'] })
    expect(second.operations('origin')[0].state).toBe('uncertain')
    expect(second.operations('origin')[0].payload).toEqual(operation.payload)
    expect(second.operations('origin')[0].result).toEqual({ paneId: 'pane', steps: ['launched'] })
    expect(store.operations('other')).toEqual([])
    expect(store.beginOperation('cleanup', 'origin', 'key', {}).id).not.toBe(operation.id)
    expect(store.beginOperation('provision', 'other', 'key', {}).id).not.toBe(operation.id)
    expect(() => store.updateOperation('missing', 'ready', {})).toThrow()
    expect(() => store.beginOperation('provision', 'origin', 'invalid', { value: undefined })).toThrow('JSON')
  })
})

describe('operation claims and closure exclusion', () => {
  test('one operation claim across connections, failed CAS leaves no audit', () => {
    const { store, path } = fixture()
    const second = open(path)
    const operation = store.beginOperation('open_agent', 'origin', 'key', { folder: '/project' })
    expect(second.beginOperation('open_agent', 'origin', 'key', { folder: '/project' })).toEqual(operation)
    expect(store.claimOperation(operation.id, 'requested', 'preparing')).toBe(true)
    expect(second.claimOperation(operation.id, 'requested', 'preparing')).toBe(false)
    expect(second.operations('origin')[0].state).toBe('preparing')
    expect(second.claimOperation('missing', 'requested', 'preparing')).toBe(false)
    expect(() => second.claimOperation(operation.id, 'preparing', 'preparing')).toThrow('change state')
    store.beginOperation('open_agent', 'another-origin', 'key', {})
    expect(second.operations()).toHaveLength(2)
    expect(second.operations('origin')).toHaveLength(1)
    const db = new Database(path)
    try {
      expect(db.query('SELECT transition FROM audit_events WHERE entityId=? ORDER BY id').all(operation.id)).toEqual([
        { transition: 'operation:requested' }, { transition: 'claim:requested:preparing' },
      ])
    } finally { db.close() }
  })

  test('queued or attempted delivery wins before close, requested does not reserve', () => {
    const { store, path, agent } = fixture()
    const second = open(path)
    const operation = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    expect(store.closingAgent(agent.id)).toBe(false)
    const request = enqueue(second, agent)
    expect(store.claimOperation(operation.id, 'requested', 'closing')).toBe(false)
    expect(store.claimOperation(operation.id, 'requested', 'authorising')).toBe(false)
    expect(second.attempt(request.id, 1, 'message')).toBe(true)
    expect(store.claimOperation(operation.id, 'requested', 'authorising')).toBe(false)
    expect(store.operations('origin')[0].state).toBe('requested')
    store.accept(request.id, 1, request.deliveryId, agent.sessionId)
    expect(store.claimOperation(operation.id, 'requested', 'closing')).toBe(false)
    store.finish(request.id, 1, agent.sessionId, completed)
    expect(store.claimOperation(operation.id, 'requested', 'closing')).toBe(true)
    expect(second.closingAgent(agent.id)).toBe(true)
  })

  for (const state of ['authorising', 'closing']) {
    test(`${state} claim wins before enqueue and resume, only one close reserves`, () => {
      const { store, path, agent } = fixture()
      const second = open(path)
      const request = enqueue(store, agent)
      accept(store, request)
      store.finish(request.id, 1, agent.sessionId, paused)
      const first = store.beginOperation('close_agent', 'origin', 'first-close', { identity: agent.id, socket: agent.socket })
      const other = second.beginOperation('close_agent', 'other', 'other-close', { identity: agent.id, socket: agent.socket })
      expect(store.claimOperation(first.id, 'requested', state)).toBe(true)
      expect(second.claimOperation(other.id, 'requested', state)).toBe(false)
      expect(() => enqueue(second, agent)).toThrow('reserved for closure')
      expect(() => second.resume(request.id, 'origin', 'Continue', 'resume', 1)).toThrow('reserved for closure')
      expect(second.attempt(request.id, 1, 'message')).toBe(false)
      expect(second.closingAgent(agent.id)).toBe(true)
      expect(open(path).closingAgent(agent.id)).toBe(true)
      expect(() => second.updateOperation(other.id, 'uncertain', { effect: 'pane_close' })).toThrow('conflicts')
      store.updateOperation(first.id, 'blocked', { reason: 'permission unavailable' })
      expect(second.closingAgent(agent.id)).toBe(false)
      expect(second.resume(request.id, 'origin', 'Continue', 'resume', 1).generation).toBe(2)
      expect(second.claimOperation(other.id, 'requested', state)).toBe(false)
    })
  }

  test('uncertain and closed states prevent replay and queue reuse, replacement identity is separate', () => {
    const { store, agent, path } = fixture()
    const operation = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    expect(store.claimOperation(operation.id, 'requested', 'authorising')).toBe(true)
    store.updateOperation(operation.id, 'uncertain', { effect: 'pane_close' })
    const second = open(path)
    expect(second.closingAgent(agent.id)).toBe(true)
    expect(() => enqueue(second, agent)).toThrow('reserved')
    expect(() => second.updateOperation(operation.id, 'failed', {})).toThrow('retain')
    expect(second.claimOperation(operation.id, 'uncertain', 'failed')).toBe(false)
    second.updateOperation(operation.id, 'closed', { effect: null })
    expect(store.closingAgent(agent.id)).toBe(true)
    expect(() => enqueue(store, agent)).toThrow('already closed')
    expect(() => store.updateOperation(operation.id, 'requested', {})).toThrow('cannot be reopened')
    expect(store.claimOperation(operation.id, 'closed', 'requested')).toBe(false)
    observe(store)
    expect(store.closingAgent(agent.id)).toBe(true)
    const replacement = observe(store, { sessionId: 'new-conversation' })
    expect(store.closingAgent(replacement.id)).toBe(false)
    expect(enqueue(store, replacement).state).toBe('queued')
  })

  test('failed preflight releases reservation, effect evidence and attempt guard fail closed', () => {
    const { store, agent, path } = fixture()
    const operation = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    store.claimOperation(operation.id, 'requested', 'authorising')
    store.updateOperation(operation.id, 'failed', { error: 'preflight failed' })
    expect(store.closingAgent(agent.id)).toBe(false)
    const request = enqueue(store, agent)
    expect(() => store.updateOperation(operation.id, 'uncertain', { effect: 'pane_close' })).toThrow('conflicts')
    // Simulate a legacy/inconsistent checkpoint to exercise the final dispatch guard.
    const db = new Database(path)
    try {
      db.query('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify({ effect: 'pane_close' }), operation.id)
      expect(store.closingAgent(agent.id)).toBe(true)
      expect(store.attempt(request.id, 1, 'not-dispatched')).toBe(false)
      expect(store.request(request.id).state).toBe('queued')
    } finally { db.close() }
  })

  test('real Provisioner close uses store reservation throughout approval and readback', async () => {
    const { store, agent, path } = fixture()
    const second = open(path)
    let visible = true
    let closes = 0
    let approvals = 0
    const live = { agent: 'opencode', pane_id: agent.paneId, terminal_id: agent.terminalId, workspace_id: agent.workspaceId,
      cwd: agent.directory, agent_status: 'idle', agent_session: { agent: 'opencode', kind: 'id', value: agent.sessionId } }
    const run: ProvisionRunner = async (_file, args) => {
      expect(second.closingAgent(agent.id)).toBe(true)
      let result: object
      if (args[0] === 'agent') result = { agents: visible ? [live] : [] }
      else if (args[1] === 'close') { visible = false; closes++; result = {} }
      else if (args[1] === 'list') result = { panes: visible ? [live] : [] }
      else throw new Error(`Unexpected command ${args.join(' ')}`)
      return { stdout: JSON.stringify({ result }), stderr: '' }
    }
    const ctx: ToolContext = { sessionID: 'origin', messageID: 'message', agent: 'build', directory: '/origin', worktree: '/origin',
      abort: new AbortController().signal, metadata() {}, async ask() {
        approvals++
        expect(() => enqueue(second, agent)).toThrow('reserved')
      } }
    const client = { session: { async create() { throw new Error('Close must not create a session') } } } as unknown as PluginInput['client']
    const service = new Provisioner(store, run, { HERDR_ENV: '1', HERDR_SOCKET_PATH: agent.socket, HERDR_PANE_ID: 'parent' }, client)
    const result = await service.close({ identity: agent.id, idempotencyKey: 'close' }, ctx)
    expect(result.state).toBe('closed')
    expect((await service.close({ identity: agent.id, idempotencyKey: 'close' }, ctx)).id).toBe(result.id)
    expect(closes).toBe(1)
    expect(approvals).toBe(1)
    expect(second.closingAgent(agent.id)).toBe(true)
  })

  test('real Provisioner open claims requested once and persists verified independent readiness', async () => {
    const { store, dir } = fixture()
    let launches = 0
    let creates = 0
    const binding = { pane_id: 'opened-pane', terminal_id: 'opened-terminal', workspace_id: 'opened-workspace', cwd: dir }
    const run: ProvisionRunner = async (file, args) => {
      if (file === 'opencode') return { stdout: 'build (primary)\n', stderr: '' }
      let result: object
      if (args[1] === 'split' || args[1] === 'get') result = { pane: binding }
      else if (args[1] === 'run') {
        expect(args[3]).toContain("--session 'opened-session'")
        expect(store.operations('origin')[0].result?.expectedSessionId).toBe('opened-session')
        launches++; result = {}
      }
      else if (args[0] === 'agent') result = { agents: [{ ...binding, agent: 'opencode', agent_status: 'idle', agent_session: { agent: 'opencode', kind: 'id', value: 'opened-session' } }] }
      else throw new Error(`Unexpected command ${args.join(' ')}`)
      return { stdout: JSON.stringify({ result }), stderr: '' }
    }
    const ctx: ToolContext = { sessionID: 'origin', messageID: 'message', agent: 'build', directory: dir, worktree: dir,
      abort: new AbortController().signal, metadata() {}, async ask() { throw new Error('Open must not ask to close') } }
    const client = { session: { async create(options: { query: { directory: string } }) {
      creates++
      expect(options.query.directory).toBe(dir)
      expect(store.operations('origin')[0].result?.effect).toBe('session_create')
      return { data: { id: 'opened-session' } }
    } } } as unknown as PluginInput['client']
    const service = new Provisioner(store, run, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/herdr.sock', HERDR_PANE_ID: 'parent' }, client)
    const input = { persona: 'build', folder: dir, placement: 'pane' as const, management: 'independent' as const, idempotencyKey: 'open' }
    const result = await service.open(input, ctx)
    expect(result.state).toBe('ready')
    expect(result.result?.identity).toBeString()
    expect(store.agent(result.result!.identity as string).management).toBe('independent')
    expect((await service.open(input, ctx)).id).toBe(result.id)
    expect(launches).toBe(1)
    expect(creates).toBe(1)
    expect(store.list('origin').outbox).toEqual([])
  })

  test('operation audit failure rolls back both the CAS and close reservation', () => {
    const { store, path, agent } = fixture()
    const operation = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_claim_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected claim audit failure'); END")
      expect(() => store.claimOperation(operation.id, 'requested', 'closing')).toThrow('injected claim audit failure')
      expect(store.closingAgent(agent.id)).toBe(false)
      expect(store.operations('origin')[0].state).toBe('requested')
      db.exec('DROP TRIGGER reject_claim_audit')
      expect(store.claimOperation(operation.id, 'requested', 'closing')).toBe(true)
    } finally { db.close() }
  })
})

describe('snapshot reads, correlated notices and audit', () => {
  test('read transactions do not contend with an existing SQLite writer', () => {
    const { store, path, agent } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    store.ask(request.id, 1, agent.sessionId, 'Question?')
    const writer = new Database(path)
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.query("UPDATE agents SET label='uncommitted' WHERE id=?").run(agent.id)
      expect(store.list('origin').outbox[0].id).toBe(request.id)
      expect(store.history(request.id, 'origin').generations).toHaveLength(1)
      expect(store.questions(request.id, 'origin')).toHaveLength(1)
      expect(store.agent(agent.id).label).toBe('Worker')
      writer.exec('ROLLBACK')
    } finally { writer.close() }
  })

  test('scheduled notice deduplication preserves claimed state and rejects changed payload', () => {
    const { store, path } = fixture()
    const second = open(path)
    const notice = store.scheduleNotice('entity', 'event', 'origin', '/origin', 'Read the exact result')
    expect(second.scheduleNotice('entity', 'event', 'origin', '/origin', 'Read the exact result')).toEqual(notice)
    expect(store.noticeAttempt(notice.id, 'message')).toBe(true)
    expect(second.scheduleNotice('entity', 'event', 'origin', '/origin', 'Read the exact result').state).toBe('unknown')
    expect(() => second.scheduleNotice('entity', 'event', 'origin', '/other', 'Read the exact result')).toThrow('payload conflict')
    expect(() => second.scheduleNotice('entity', 'event', 'origin', '/origin', 'Changed text')).toThrow('payload conflict')
    expect(store.notices()).toHaveLength(1)
    expect(store.scheduleNotice('entity', 'event', 'other', '/origin', 'Read the exact result').id).not.toBe(notice.id)
  })

  test('reply and recipient wake notice are atomic, exact, idempotent and superseded on finish', () => {
    const { store, path, agent } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Question?')
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_reply_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'injected reply notice failure'); END")
      expect(() => store.reply(question.id, 'origin', 'secret answer')).toThrow('injected reply')
      expect(store.questions(request.id, 'origin')[0].state).toBe('open')
      expect(store.notices('origin')[0].state).toBe('pending')
      expect(store.notices(agent.sessionId)).toEqual([])
      expect(store.history(request.id, 'origin').audit.some(event => event.transition === 'reply:1')).toBe(false)
      db.exec('DROP TRIGGER reject_reply_notice')
      store.reply(question.id, 'origin', 'secret answer')
      const notice = store.notices(agent.sessionId)[0]
      expect(notice.directory).toBe(agent.directory)
      expect(notice.text).toContain(request.id)
      expect(notice.text).toContain('generation 1')
      expect(notice.text).toContain(question.id)
      expect(notice.text).toContain('Read questions')
      expect(notice.text).not.toContain('secret answer')
      store.reply(question.id, 'origin', 'secret answer')
      expect(store.notices(agent.sessionId)).toEqual([notice])
      store.finish(request.id, 1, agent.sessionId, completed)
      expect(store.notices(agent.sessionId)[0].state).toBe('superseded')
    } finally { db.close() }
  })

  test('unknown reply wake notices retain evidence on cancellation', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    accept(store, request)
    const question = store.ask(request.id, 1, agent.sessionId, 'Question?')
    store.reply(question.id, 'origin', 'Answer')
    const notice = store.notices(agent.sessionId)[0]
    store.noticeAttempt(notice.id, 'reply-message')
    store.cancel(request.id, 'origin')
    expect(store.notices(agent.sessionId)[0].state).toBe('unknown')
    expect(store.noticeAttempt(notice.id, 'retry')).toBe(false)
    store.noticeDelivered(notice.id, 'reply-message')
    expect(store.notices(agent.sessionId)[0].state).toBe('delivered')
  })

  test('audit is redacted, ordered, transactionally coupled and duplicate-free', () => {
    const { store, path, agent } = fixture()
    const request = enqueue(store, agent, { text: 'secret brief', idempotencyKey: 'secret-key' })
    enqueue(store, agent, { text: 'secret brief', idempotencyKey: 'secret-key' })
    accept(store, request)
    store.accept(request.id, 1, request.deliveryId, agent.sessionId)
    store.finish(request.id, 1, agent.sessionId, paused)
    store.finish(request.id, 1, agent.sessionId, paused)
    store.resume(request.id, 'origin', 'secret continuation', 'resume', 1)
    store.resume(request.id, 'origin', 'secret continuation', 'resume', 1)
    store.cancel(request.id, 'origin')
    store.cancel(request.id, 'origin')
    const audit = store.history(request.id, 'origin').audit
    expect(audit.map(event => event.transition)).toEqual(['enqueue:1', 'attempt:1', 'submitted:1', 'accept:1', 'finish:1:paused', 'resume:2', 'cancel:2'])
    expect(audit.map(event => event.id)).toEqual(audit.map(event => event.id).sort((a, b) => a - b))
    expect(audit[3].sessionId).toBe(agent.sessionId)
    expect(audit[6].sessionId).toBe('origin')
    expect(JSON.stringify(audit)).not.toContain('secret')
    expect(JSON.stringify(audit)).not.toContain(paused.summary)
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
      expect(() => enqueue(store, agent)).toThrow('injected audit failure')
      expect(store.list('origin').outbox).toHaveLength(1)
      expect(store.history(request.id, 'origin').audit).toEqual(audit)
    } finally { db.close() }
  })
})

describe('request revisions and remote cache', () => {
  test('every request mutation advances revision, identical retries do not', () => {
    const { store, agent } = fixture()
    const request = enqueue(store, agent)
    expect(request.revision).toBe(1)
    store.attempt(request.id, 1, 'message')
    expect(store.request(request.id).revision).toBe(2)
    store.submitted(request.id, 'message')
    expect(store.request(request.id).revision).toBe(3)
    store.submitted(request.id, 'message')
    expect(store.request(request.id).revision).toBe(3)
    store.accept(request.id, 1, request.deliveryId, agent.sessionId)
    expect(store.request(request.id).revision).toBe(4)
    store.accept(request.id, 1, request.deliveryId, agent.sessionId)
    const question = store.ask(request.id, 1, agent.sessionId, 'Question?')
    expect(store.request(request.id).revision).toBe(5)
    store.reply(question.id, 'origin', 'Answer')
    expect(store.request(request.id).revision).toBe(6)
    store.reply(question.id, 'origin', 'Answer')
    expect(store.finish(request.id, 1, agent.sessionId, paused).revision).toBe(7)
    expect(store.finish(request.id, 1, agent.sessionId, paused).revision).toBe(7)
    expect(store.resume(request.id, 'origin', 'Continue', 'resume', 1).revision).toBe(8)
    expect(store.cancel(request.id, 'origin').revision).toBe(9)
    expect(store.cancel(request.id, 'origin').revision).toBe(9)
  })

  test('remote cache orders by receiver revision and failure CAS cannot replace newer success', () => {
    const f = remoteFixture()
    f.sender.cacheRemote(f.operation.id, f.request)
    const observed = f.current()
    accept(f.receiver, f.request)
    const latest = f.sync()
    expect(f.current().updatedAt).toBeGreaterThan(observed.updatedAt)
    const cached = f.current()
    open(f.path).failRemote(f.operation.id, observed.updatedAt)
    expect(f.current()).toEqual(cached)
    f.sender.cacheRemote(f.operation.id, f.request)
    expect(f.current()).toEqual(cached)
    expect(() => f.sender.cacheRemote(f.operation.id, { ...latest.request, state: 'unknown' })).toThrow('same revision')
    expect(f.current()).toEqual(cached)
    f.sender.failRemote(f.operation.id, cached.updatedAt)
    expect(f.current().state).toBe('unknown')
    expect(f.current().result).toEqual(cached.result)
    expect(f.current().updatedAt).toBeGreaterThan(cached.updatedAt)
    f.sender.cacheRemote(f.operation.id, latest.request)
    expect(f.current().state).toBe('confirmed')
    expect(f.current().result?.history).toEqual(latest)
    const before = f.current().updatedAt
    f.sender.updateOperation(f.operation.id, 'confirmed', f.current().result!)
    expect(f.current().updatedAt).toBeGreaterThan(before)
  })

  test('remote cache validates origin, recipient, identity, revision and snapshot', () => {
    const f = remoteFixture()
    for (const changes of [{ originSessionId: 'origin:session' }, { recipientId: 'wrong' }, { revision: 0 }, { originDirectory: '/wrong' }, { text: 'changed' }]) {
      expect(() => f.sender.cacheRemote(f.operation.id, { ...f.request, ...changes })).toThrow()
    }
    f.sender.cacheRemote(f.operation.id, f.request)
    expect(() => f.sender.cacheRemote(f.operation.id, { ...f.request, id: 'wrong', revision: 2 })).toThrow('identity changed')
    const history = f.receiver.history(f.request.id, f.request.originSessionId)
    expect(() => f.sender.cacheRemote(f.operation.id, f.request, { ...history, request: { ...f.request, revision: 2 } })).toThrow('history')
    const other = f.sender.beginOperation('open_agent', 'origin', 'other', {})
    expect(() => f.sender.cacheRemote(other.id, f.request)).toThrow('remote.request')
    expect(() => f.sender.failRemote(other.id, other.updatedAt)).toThrow('remote.request')
    f.sender.cacheRemote(f.operation.id, f.request, history)
    expect(f.current().result?.history).toEqual(history)
  })

  test('remote cache notifies every result generation, question changes and late cancelled outcome once', () => {
    const f = remoteFixture()
    accept(f.receiver, f.request)
    const question = f.receiver.ask(f.request.id, 1, f.agent.sessionId, 'Which branch?')
    f.sync()
    const notice = f.sender.notices('origin:session')[0]
    expect(notice.text).toContain(question.id)
    expect(notice.directory).toBe('/origin')
    f.sync()
    expect(f.sender.notices('origin:session')).toHaveLength(1)
    f.receiver.reply(question.id, f.request.originSessionId, 'main')
    f.sync()
    expect(f.sender.notices('origin:session')[0].state).toBe('superseded')
    f.receiver.finish(f.request.id, 1, f.agent.sessionId, paused)
    const resumed = f.receiver.resume(f.request.id, f.request.originSessionId, 'Continue', 'resume', 1)
    accept(f.receiver, resumed)
    f.receiver.cancel(f.request.id, f.request.originSessionId)
    f.receiver.finish(f.request.id, 2, f.agent.sessionId, completed)
    const history = f.sync()
    expect(history.request.state).toBe('cancelled')
    expect(f.current().result?.request).toEqual(history.request)
    const results = f.sender.notices('origin:session').filter(n => n.state === 'pending')
    expect(results).toHaveLength(2)
    expect(results[0].text).toContain('generation 1: paused')
    expect(results[1].text).toContain('generation 2: completed')
    expect(results[1].text).toContain('Late outcomes for cancelled requests')
    expect(results[1].text).toContain('Validation: pending')
    f.sync()
    expect(f.sender.notices('origin:session')).toHaveLength(3)
  })

  test('remote cache and all notices roll back on notification failure', () => {
    const f = remoteFixture()
    f.sender.cacheRemote(f.operation.id, f.request)
    const before = f.current()
    accept(f.receiver, f.request)
    f.receiver.finish(f.request.id, 1, f.agent.sessionId, completed)
    const db = new Database(f.path)
    try {
      db.exec("CREATE TRIGGER reject_remote_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'remote notice failure'); END")
      expect(() => f.sync()).toThrow('remote notice failure')
      expect(f.current()).toEqual(before)
      expect(f.sender.notices()).toEqual([])
      db.exec('DROP TRIGGER reject_remote_notice')
      f.sync()
      expect(f.current().state).toBe('confirmed')
      expect(f.sender.notices()).toHaveLength(1)
    } finally { db.close() }
  })

  test('remote question supersession retains unknown evidence and result notice text stays immutable after cancellation', () => {
    const f = remoteFixture()
    accept(f.receiver, f.request)
    f.receiver.ask(f.request.id, 1, f.agent.sessionId, 'Question?')
    f.sync()
    const questionNotice = f.sender.notices('origin:session')[0]
    f.sender.noticeAttempt(questionNotice.id, 'question-message')
    f.receiver.finish(f.request.id, 1, f.agent.sessionId, paused)
    f.sync()
    const before = f.sender.notices('origin:session')
    expect(before[0].state).toBe('unknown')
    expect(before[1].text).toContain('generation 1: paused')
    f.receiver.cancel(f.request.id, f.request.originSessionId)
    f.sync()
    expect(f.sender.notices('origin:session')).toEqual(before)
    f.sender.noticeDelivered(questionNotice.id, 'question-message')
    expect(f.sender.notices('origin:session')[0].state).toBe('delivered')
  })
})

describe('notice dispatch versus closure', () => {
  test('pending and unknown notice wins before close, delivered notice releases', () => {
    const { store, agent, path } = fixture()
    const second = open(path)
    const op = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    const notice = store.scheduleNotice('entity', 'event', agent.sessionId, agent.directory, 'Read status')
    expect(second.claimOperation(op.id, 'requested', 'closing')).toBe(false)
    expect(store.noticeAttempt(notice.id, 'notice-message')).toBe(true)
    expect(second.claimOperation(op.id, 'requested', 'closing')).toBe(false)
    store.noticeDelivered(notice.id, 'notice-message')
    expect(second.claimOperation(op.id, 'requested', 'closing')).toBe(true)
  })

  test('close wins before notice dispatch without discarding pending notice', () => {
    const { store, agent, path } = fixture()
    const second = open(path)
    const op = store.beginOperation('close_agent', 'origin', 'close', { identity: agent.id, socket: agent.socket })
    expect(store.claimOperation(op.id, 'requested', 'authorising')).toBe(true)
    const notice = second.scheduleNotice('entity', 'event', agent.sessionId, agent.directory, 'Read status')
    expect(second.noticeAttempt(notice.id, 'not-sent')).toBe(false)
    expect(store.notices(agent.sessionId)[0].state).toBe('pending')
    store.updateOperation(op.id, 'failed', {})
    expect(second.noticeAttempt(notice.id, 'sent')).toBe(true)
  })
})

describe('atomic provisioning binding', () => {
  function preparing(store: Store, agent: Agent, management: Agent['management'] = 'managed', key = 'bind') {
    const operation = store.beginOperation('open_agent', 'manager', key, { management, socket: agent.socket })
    store.updateOperation(operation.id, 'launching', { launchAttempted: true, paneId: agent.paneId, terminalId: agent.terminalId,
      workspaceId: agent.workspaceId, destination: agent.directory, expectedSessionId: agent.sessionId, effect: null })
    return operation
  }

  test('inventory-first independent agent can be promoted only once by exact provision intent', () => {
    const { store, agent, path } = fixture()
    const operation = preparing(store, agent)
    const input = { ...agent, management: 'managed' as const, managerSessionId: 'manager' }
    expect(() => store.observeAgent(input)).toThrow('cannot change')
    const bound = store.bindProvision(operation.id, input)
    expect(bound.id).toBe(agent.id)
    expect(bound.managerSessionId).toBe('manager')
    const saved = store.operations('manager')[0]
    expect(saved.state).toBe('ready')
    expect(saved.result?.sessionId).toBe(agent.sessionId)
    expect(open(path).bindProvision(operation.id, input)).toEqual(bound)
    expect(store.operations('manager')[0]).toEqual(saved)
    expect(() => store.bindProvision(operation.id, { ...input, sessionId: 'replacement' })).toThrow('already bound')
    expect(() => store.observeAgent({ ...input, managerSessionId: 'other' })).toThrow('cannot change')
    expect(() => store.updateOperation(operation.id, 'uncertain', {})).toThrow('immutable')
    expect(store.claimOperation(operation.id, 'ready', 'launching')).toBe(false)
    const other = preparing(store, agent, 'managed', 'other')
    expect(() => store.bindProvision(other.id, input)).toThrow('another provision')
  })

  test('binding rejects wrong target, management, pre-launch state and stale checkpoint', () => {
    const { store, agent } = fixture()
    const op = preparing(store, agent)
    const input = { ...agent, management: 'managed' as const, managerSessionId: 'manager' }
    for (const key of ['socket', 'paneId', 'terminalId', 'workspaceId', 'directory'] as const) {
      expect(() => store.bindProvision(op.id, { ...input, [key]: '/wrong' })).toThrow('target')
    }
    expect(() => store.bindProvision(op.id, agent)).toThrow('management')
    expect(() => store.bindProvision(op.id, { ...input, managerSessionId: 'other' })).toThrow('management')
    const saved = store.operations('manager')[0].result!
    store.updateOperation(op.id, 'uncertain', { ...saved, effect: 'placement' })
    expect(() => store.bindProvision(op.id, input)).toThrow('awaiting')
    store.updateOperation(op.id, 'uncertain', { ...saved, effect: 'launch' })
    expect(store.bindProvision(op.id, input).management).toBe('managed')
  })

  test('failed readiness update rolls back management promotion and binding', () => {
    const { store, agent, path } = fixture()
    const operation = preparing(store, agent)
    const db = new Database(path)
    try {
      db.exec("CREATE TRIGGER reject_ready BEFORE UPDATE ON operations WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT, 'readiness failure'); END")
      expect(() => store.bindProvision(operation.id, { ...agent, management: 'managed', managerSessionId: 'manager' })).toThrow('readiness failure')
      expect(store.agent(agent.id).management).toBe('independent')
      expect(store.operations('manager')[0].state).toBe('launching')
      expect(store.operations('manager')[0].result?.sessionId).toBeUndefined()
      db.exec('DROP TRIGGER reject_ready')
      expect(store.bindProvision(operation.id, { ...agent, management: 'managed', managerSessionId: 'manager' }).management).toBe('managed')
    } finally { db.close() }
  })

  test('replacement before readiness cannot bind or acquire management', () => {
    const { store, agent, path } = fixture()
    const operation = preparing(store, agent)
    const before = store.operations('manager')[0]
    const replacement = observe(store, { sessionId: 'replacement' })
    expect(() => open(path).bindProvision(operation.id, { ...replacement, management: 'managed', managerSessionId: 'manager' })).toThrow('created session')
    expect(store.operations('manager')[0]).toEqual(before)
    expect(store.agent(replacement.id).management).toBe('independent')
    expect(store.agent(agent.id).management).toBe('independent')
    expect(store.bindProvision(operation.id, { ...agent, management: 'managed', managerSessionId: 'manager' }).id).toBe(agent.id)
  })

  test('missing expected session fails binding and checkpointed session cannot change or disappear', () => {
    const { store, agent } = fixture()
    const operation = store.beginOperation('open_agent', 'manager', 'bind', { management: 'managed', socket: agent.socket })
    const checkpoint = { launchAttempted: true, paneId: agent.paneId, terminalId: agent.terminalId,
      workspaceId: agent.workspaceId, destination: agent.directory, effect: null }
    store.updateOperation(operation.id, 'launching', checkpoint)
    expect(() => store.bindProvision(operation.id, { ...agent, management: 'managed', managerSessionId: 'manager' })).toThrow('expectedSessionId')
    store.updateOperation(operation.id, 'launching', { ...checkpoint, expectedSessionId: agent.sessionId })
    const before = store.operations('manager')[0]
    expect(() => store.updateOperation(operation.id, 'launching', checkpoint)).toThrow('expectedSessionId is immutable')
    expect(() => store.updateOperation(operation.id, 'launching', { ...checkpoint, expectedSessionId: 'replacement' })).toThrow('expectedSessionId is immutable')
    expect(store.operations('manager')[0]).toEqual(before)
    store.bindProvision(operation.id, { ...agent, management: 'managed', managerSessionId: 'manager' })
    const ready = store.operations('manager')[0]
    expect(() => store.updateOperation(operation.id, 'launching', before.result!)).toThrow('readiness is immutable')
    expect(() => store.updateOperation(operation.id, 'failed', { ...ready.result, error: 'stale reconcile' })).toThrow('readiness is immutable')
    expect(store.operations('manager')[0]).toEqual(ready)
  })
})
