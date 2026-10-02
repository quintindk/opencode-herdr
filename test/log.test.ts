import { afterEach, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const roots: string[] = []
const moduleUrl = new URL('../src/log.ts', import.meta.url).href
const day = new Date().toISOString().slice(0, 10)
const maxBytes = 16 * 1024 * 1024
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'herdr-log-'))
  roots.push(root)
  const directory = join(root, 'opencode', 'opencode-herdr', 'logs')
  mkdirSync(directory, { recursive: true })
  return { root, directory, file: join(directory, `${day}.jsonl`) }
}
async function run(root: string, code: string, env: Record<string, string> = {}) {
  const result = await exec(process.execPath, ['-e', `import { log, loggingStatus, readLogs, events } from ${JSON.stringify(moduleUrl)}; ${code}`], {
    env: { ...process.env, XDG_CONFIG_HOME: root, ...env }, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  })
  return JSON.parse(result.stdout)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('valid records have private modes, UTC metadata, event levels and immutable health snapshots', async () => {
  const f = fixture()
  chmodSync(f.directory, 0o777)
  const result = await run(f.root, `
    await log('tool_completed', { requestId: 'req:1', sessionId: 'ses_1', tool: 'list_agents', durationMs: 1.25, status: 200, phase: 'readback', state: 'completed' });
    await log('remote_unknown', { reason: 'transport' });
    await log('store_failed');
    await log('plugin_ready', { severity: 'warn' });
    const copy = loggingStatus(); copy.failedWrites = 99;
    console.log(JSON.stringify({ records: await readLogs(), status: loggingStatus() }));
  `)
  expect(result.records).toHaveLength(4)
  expect(result.records.map((r: any) => r.level)).toEqual(['info', 'warn', 'error', 'warn'])
  expect(result.records[0]).toMatchObject({ schemaVersion: 1, event: 'tool_completed', details: { requestId: 'req:1', durationMs: 1.25, status: 200, phase: 'readback', state: 'completed' } })
  expect(result.records[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect(result.records[0].pid).toBeGreaterThan(0)
  expect(new Set(result.records.map((r: any) => r.runId)).size).toBe(1)
  expect(result.status).toMatchObject({ directory: f.directory, failedWrites: 0, droppedRecords: 0 })
  expect(result.status.lastWriteAt).toBeString()
  expect(statSync(f.directory).mode & 0o777).toBe(0o700)
  expect(statSync(join(f.directory, '..')).mode & 0o777).toBe(0o700)
  expect(statSync(f.file).mode & 0o777).toBe(0o600)
})

test('every event is accepted and secrets, invalid fields, getters and serialisers are excluded', async () => {
  const f = fixture()
  const result = await run(f.root, `
    for (const event of events) await log(event);
    const details = { requestId: 'valid', operationId: 'a'.repeat(161), sessionId: 'remote:\\u65e5\\u672c', deliveryId: '/secret/path', peerId: 'line\\nbreak', tool: '', phase: 'error message secret', state: 'secret', reason: 'secret', severity: 'secret', status: NaN, durationMs: -1, generation: Infinity, revision: 0.5, attemptCount: 2, sequence: 0, count: Number.MAX_SAFE_INTEGER + 1, error: 'SECRET', args: { token: 'SECRET' }, stdout: 'SECRET', summary: 'SECRET', task: 'SECRET', token: 'SECRET', directory: 'SECRET', toJSON() { throw Error('SECRET') } };
    Object.defineProperty(details, 'agentId', { get() { throw Error('SECRET') } });
    await log('tool_failed', details);
    await log('SECRET');
    await log('tool_failed', new Proxy({}, { getOwnPropertyDescriptor() { throw Error('SECRET') } }));
    console.log(JSON.stringify({ records: await readLogs({ limit: 200 }), status: loggingStatus(), count: events.length }));
  `)
  expect(result.records).toHaveLength(result.count + 1)
  expect(result.records.at(-1).details).toEqual({ requestId: 'valid', attemptCount: 2, sequence: 0 })
  expect(result.status.droppedRecords).toBe(2)
  expect(readFileSync(f.file, 'utf8')).not.toContain('SECRET')
})

test('bounds queued records and counts overload without rejecting', async () => {
  const f = fixture()
  const result = await run(f.root, `await Promise.all(Array.from({ length: 1000 }, () => log('plugin_ready'))); console.log(JSON.stringify({ status: loggingStatus(), records: await readLogs({ limit: 200 }) }));`)
  expect(result.records).toHaveLength(128)
  expect(result.status.droppedRecords).toBe(872)
  expect(result.status.failedWrites).toBe(0)
})

test('day cap drops writes and bounded readback tolerates oversized tampered files', async () => {
  const f = fixture()
  await run(f.root, `await log('plugin_ready'); console.log('{}');`)
  const record = readFileSync(f.file, 'utf8')
  truncateSync(f.file, maxBytes)
  const status = await run(f.root, `await log('plugin_stopped'); console.log(JSON.stringify(loggingStatus()));`)
  expect(status.droppedRecords).toBe(1)
  expect(status.failedWrites).toBe(0)
  expect(statSync(f.file).size).toBe(maxBytes)
  appendFileSync(f.file, '\n' + record)
  const records = await run(f.root, `console.log(JSON.stringify(await readLogs()));`)
  expect(records).toHaveLength(1)
  expect(records[0].event).toBe('plugin_ready')
})

test('retains today and preceding 29 UTC days without deleting unrelated entries', async () => {
  const f = fixture()
  const date = (offset: number) => new Date(Date.parse(day) - offset * 86400000).toISOString().slice(0, 10)
  for (const name of [`${date(29)}.jsonl`, `${date(30)}.jsonl`, `${date(100)}.jsonl`, 'notes.txt', '2026-02-30.jsonl', `${date(-1)}.jsonl`]) writeFileSync(join(f.directory, name), '')
  const target = join(f.root, 'retention-target')
  writeFileSync(target, 'untouched')
  symlinkSync(target, join(f.directory, `${date(31)}.jsonl`))
  await run(f.root, `await log('plugin_ready'); await log('plugin_stopped'); console.log('{}');`)
  expect(readdirSync(f.directory).sort()).toEqual([`${date(29)}.jsonl`, `${day}.jsonl`, 'notes.txt', '2026-02-30.jsonl', `${date(-1)}.jsonl`].sort())
  expect(readFileSync(target, 'utf8')).toBe('untouched')
})

test('malformed and tampered records are skipped or projected, with exact filters and bounded limits', async () => {
  const f = fixture()
  await run(f.root, `await log('plugin_ready'); console.log('{}');`)
  const base = JSON.parse(readFileSync(f.file, 'utf8'))
  const records = Array.from({ length: 220 }, (_, i) => ({ ...base, details: { requestId: i % 2 ? 'r1' : 'r2', operationId: 'op1', sessionId: 'ses1', sequence: i, error: 'SECRET', reason: 'SECRET', phase: '/SECRET', args: 'SECRET' }, secret: 'SECRET' }))
  const bad = [null, {}, { ...base, event: 'SECRET' }, { ...base, timestamp: 'SECRET' }, { ...base, timestamp: '2026-02-30T00:00:00.000Z' }, { ...base, level: 'SECRET' }, { ...base, schemaVersion: 2 }, { ...base, pid: -1 }, { ...base, runId: 'SECRET' }, { ...base, details: [] }]
  writeFileSync(f.file, '\ninvalid\n' + [...records, ...bad].map(r => JSON.stringify(r)).join('\n') + '\n' + 'x'.repeat(5000) + '\n' + JSON.stringify(base))
  const result = await run(f.root, `console.log(JSON.stringify({ all: await readLogs({ limit: 99999 }), filtered: await readLogs({ requestId: 'r1', operationId: 'op1', sessionId: 'ses1', limit: 3 }), mismatch: await readLogs({ operationId: 'other' }), invalid: await readLogs({ day: '../SECRET' }), invalidDate: await readLogs({ day: '2026-02-30' }), invalidId: await readLogs({ requestId: '/SECRET' }), zero: await readLogs({ limit: 0 }), nan: await readLogs({ limit: NaN }) }));`)
  expect(result.all).toHaveLength(200)
  expect(result.all[0].details.sequence).toBe(20)
  expect(result.filtered.map((r: any) => r.details.sequence)).toEqual([215, 217, 219])
  for (const key of ['mismatch', 'invalid', 'invalidDate', 'invalidId', 'zero', 'nan']) expect(result[key]).toEqual([])
  expect(JSON.stringify(result)).not.toContain('SECRET')
})

test('file and ancestor symlinks are rejected without touching their targets', async () => {
  for (const ancestor of [false, true]) {
    const f = fixture()
    const target = join(f.root, 'target')
    if (ancestor) {
      mkdirSync(target)
      rmSync(join(f.root, 'opencode'), { recursive: true })
      symlinkSync(target, join(f.root, 'opencode'))
    } else {
      writeFileSync(target, 'SECRET')
      symlinkSync(target, f.file)
    }
    const result = await run(f.root, `await log('plugin_ready'); console.log(JSON.stringify({ status: loggingStatus(), records: await readLogs() }));`)
    expect(result.status.failedWrites).toBe(1)
    expect(result.status.lastFailureAt).toBeString()
    expect(result.records).toEqual([])
    expect(JSON.stringify(result.status)).not.toContain('SECRET')
    if (ancestor) expect(readdirSync(target)).toEqual([])
    else expect(readFileSync(target, 'utf8')).toBe('SECRET')
  }
})

test('hard links and non-directory paths fail closed, and a later write can recover', async () => {
  const f = fixture()
  const target = join(f.root, 'target')
  writeFileSync(target, 'SECRET')
  linkSync(target, f.file)
  const result = await run(f.root, `
    await log('plugin_ready');
    const { unlink } = await import('node:fs/promises'); await unlink(${JSON.stringify(f.file)});
    await log('plugin_ready');
    console.log(JSON.stringify({ status: loggingStatus(), records: await readLogs() }));
  `)
  expect(readFileSync(target, 'utf8')).toBe('SECRET')
  expect(result.status.failedWrites).toBe(1)
  expect(result.records).toHaveLength(1)
  rmSync(join(f.root, 'opencode'), { recursive: true })
  writeFileSync(join(f.root, 'opencode'), 'SECRET')
  const failure = await run(f.root, `await log('store_failed'); console.log(JSON.stringify({ status: loggingStatus(), records: await readLogs() }));`)
  expect(failure.status.failedWrites).toBe(1)
  expect(failure.records).toEqual([])
})

test('FIFO targets neither block reads nor writes', async () => {
  const f = fixture()
  await exec('mkfifo', [f.file])
  const result = await run(f.root, `await log('plugin_ready'); console.log(JSON.stringify({ status: loggingStatus(), records: await readLogs() }));`)
  expect(result.status.failedWrites).toBe(1)
  expect(result.records).toEqual([])
  expect(statSync(f.file).isFIFO()).toBe(true)
})

test('independent processes append complete records with distinct process run IDs', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 4 }, (_, n) => run(f.root, `for (let i = 0; i < 40; i++) await log('delivery_attempted', { requestId: 'worker-${n}', sequence: i }); console.log(JSON.stringify(loggingStatus()));`)))
  expect(results.every(result => result.failedWrites === 0 && result.droppedRecords === 0)).toBe(true)
  const lines = readFileSync(f.file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines).toHaveLength(160)
  expect(new Set(lines.map(r => r.runId)).size).toBe(4)
  expect(new Set(lines.map(r => r.pid)).size).toBe(4)
  for (let n = 0; n < 4; n++) expect(lines.filter(r => r.details.requestId === `worker-${n}`).map(r => r.details.sequence)).toEqual(Array.from({ length: 40 }, (_, i) => i))
})

test('unset or relative XDG_CONFIG_HOME uses the home config directory', async () => {
  const f = fixture()
  for (const xdg of ['', 'relative-config']) {
    const status = await run(xdg, `await log('plugin_ready'); console.log(JSON.stringify(loggingStatus()));`, { HOME: f.root })
    expect(status.directory).toBe(join(f.root, '.config', 'opencode', 'opencode-herdr', 'logs'))
    expect(status.failedWrites).toBe(0)
  }
  expect(existsSync(resolve('relative-config'))).toBe(false)
})
