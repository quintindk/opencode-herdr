import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'

export const events = Object.freeze([
  'plugin_started', 'plugin_ready', 'plugin_stopped', 'plugin_conflict',
  'tool_started', 'tool_completed', 'tool_failed',
  'delivery_deferred', 'delivery_attempted', 'delivery_confirmed', 'delivery_unknown',
  'notification_attempted', 'notification_confirmed', 'notification_unknown',
  'reconciliation_started', 'reconciliation_completed', 'reconciliation_failed',
  'provision_checkpoint', 'approval_requested', 'approval_decided',
  'closure_checkpoint', 'cleanup_checkpoint',
  'validation_started', 'validation_completed', 'validation_failed',
  'remote_attempted', 'remote_confirmed', 'remote_unknown', 'sidebar_failed', 'store_failed',
] as const)
export type Event = typeof events[number]
export type Level = 'info' | 'warn' | 'error'
const reasons = ['busy', 'binding', 'settings', 'transport', 'readback', 'conflict', 'cancelled', 'unavailable', 'timeout', 'permission', 'validation', 'io', 'unknown', 'shutdown'] as const
const states = ['starting', 'ready', 'stopped', 'idle', 'working', 'busy', 'blocked', 'queued', 'pending', 'attempted', 'unknown', 'submitted', 'accepted', 'confirmed', 'deferred', 'delivered', 'superseded', 'paused', 'completed', 'failed', 'cancelled', 'open', 'answered', 'withdrawn', 'requested', 'approved', 'denied', 'not_required'] as const
const ids = ['operationId', 'requestId', 'deliveryId', 'sessionId', 'agentId', 'peerId', 'tool', 'correlationId'] as const
const numbers = ['status', 'durationMs', 'generation', 'revision', 'attemptCount', 'sequence', 'count'] as const
export type Details = Partial<Record<typeof ids[number], string> & Record<typeof numbers[number], number>> & {
  phase?: string
  state?: typeof states[number]
  reason?: typeof reasons[number]
  severity?: Level
}
export type LogRecord = {
  schemaVersion: 1
  timestamp: string
  pid: number
  runId: string
  level: Level
  event: Event
  details: Omit<Details, 'severity'>
}
export type LoggingStatus = {
  directory: string
  failedWrites: number
  droppedRecords: number
  lastFailureAt?: string
  lastWriteAt?: string
}
export type ReadLogsOptions = { day?: string; limit?: number; requestId?: string; operationId?: string; sessionId?: string }

const maxBytes = 16 * 1024 * 1024
const maxLineBytes = 4096
const maxBacklog = 128
const safeId = /^[A-Za-z0-9_.:-]{1,160}$/
const safePhase = /^[a-z][a-z0-9_]{0,47}$/
const runId = randomUUID()
const config = process.env.XDG_CONFIG_HOME
// Relative XDG paths are invalid under the XDG specification.
const directory = join(config && isAbsolute(config) ? resolve(config) : join(homedir(), '.config'), 'opencode', 'opencode-herdr', 'logs')
const health: LoggingStatus = { directory, failedWrites: 0, droppedRecords: 0 }
let pending = 0
let tail = Promise.resolve()
let retainedDay = ''

export function loggingStatus(): LoggingStatus { return { ...health } }

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function own(value: object, key: string): unknown {
  // Never invoke caller-supplied getters or serialisers.
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function cleanDetails(value: unknown): LogRecord['details'] {
  const result: LogRecord['details'] = {}
  if (!value || typeof value !== 'object') return result
  for (const key of ids) {
    const field = own(value, key)
    if (typeof field === 'string' && safeId.test(field)) result[key] = field
  }
  for (const key of numbers) {
    const field = own(value, key)
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= Number.MAX_SAFE_INTEGER && (key === 'durationMs' || Number.isInteger(field))) result[key] = field
  }
  const phase = own(value, 'phase'), state = own(value, 'state'), reason = own(value, 'reason')
  if (typeof phase === 'string' && safePhase.test(phase)) result.phase = phase
  if (member(states, state)) result.state = state
  if (member(reasons, reason)) result.reason = reason
  return result
}

function level(event: Event): Level {
  if (event.endsWith('_failed')) return 'error'
  if (event.endsWith('_unknown') || event === 'plugin_conflict' || event === 'delivery_deferred') return 'warn'
  return 'info'
}

function child(handle: FileHandle, name: string): string {
  // Descriptor-relative traversal pins every ancestor, not just the final filename.
  // Missing descriptor filesystems fail closed rather than falling back to unsafe paths.
  return `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${handle.fd}/${name}`
}

async function logDirectory(create: boolean): Promise<FileHandle> {
  const root = parse(directory).root
  const parts = directory.slice(root.length).split(sep).filter(Boolean)
  let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (let i = 0; i < parts.length; i++) {
      const path = child(handle, parts[i])
      if (create) {
        try { await mkdir(path, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        if (i >= parts.length - 2) {
          const stat = await next.stat()
          if (typeof process.geteuid !== 'function' || stat.uid !== process.geteuid()) throw new Error('ownership')
          await next.chmod(0o700)
        }
      } catch (error) { await next.close(); throw error }
      await handle.close()
      handle = next
    }
    return handle
  } catch (error) { await handle.close(); throw error }
}

function validDay(day: unknown): day is string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
}

async function retain(handle: FileHandle, day: string): Promise<void> {
  if (retainedDay === day) return
  const cutoff = new Date(Date.parse(day) - 29 * 86400000).toISOString().slice(0, 10)
  for (const name of await readdir(child(handle, '.'))) {
    if (!name.endsWith('.jsonl') || !validDay(name.slice(0, -6)) || name.slice(0, -6) >= cutoff) continue
    // unlink never follows a final symlink and cannot escape the pinned directory.
    try { await unlink(child(handle, name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  retainedDay = day
}

async function checkedFile(handle: FileHandle, day: string, write: boolean): Promise<FileHandle> {
  const file = await open(child(handle, `${day}.jsonl`), constants.O_NOFOLLOW | constants.O_NONBLOCK | (write ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY), 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || typeof process.geteuid !== 'function' || stat.uid !== process.geteuid()) throw new Error('file')
    if (write) await file.chmod(0o600)
    return file
  } catch (error) { await file.close(); throw error }
}

async function append(record: LogRecord, bytes: Buffer): Promise<void> {
  const handle = await logDirectory(true)
  try {
    const day = record.timestamp.slice(0, 10)
    await retain(handle, new Date().toISOString().slice(0, 10))
    const file = await checkedFile(handle, day, true)
    try {
      if ((await file.stat()).size + bytes.length > maxBytes) { health.droppedRecords++; return }
      // One append syscall per record. Never retry partial writes across other writers.
      const result = await file.write(bytes)
      if (result.bytesWritten !== bytes.length) throw new Error('partial')
      health.lastWriteAt = new Date().toISOString()
    } finally { await file.close() }
  } finally { await handle.close() }
}

/** Best-effort diagnostics only. Invalid, saturated and failed writes always resolve. */
export function log(event: Event, details: Details = {}): Promise<void> {
  try {
    if (!member(events, event) || pending >= maxBacklog) { health.droppedRecords++; return Promise.resolve() }
    const severity = details && typeof details === 'object' ? own(details, 'severity') : undefined
    const record: LogRecord = { schemaVersion: 1, timestamp: new Date().toISOString(), pid: process.pid, runId, level: member(['info', 'warn', 'error'] as const, severity) ? severity : level(event), event, details: cleanDetails(details) }
    const bytes = Buffer.from(JSON.stringify(record) + '\n')
    if (bytes.length > maxLineBytes) { health.droppedRecords++; return Promise.resolve() }
    pending++
    tail = tail.then(() => append(record, bytes)).catch(() => {
      health.failedWrites++
      health.lastFailureAt = new Date().toISOString()
    }).finally(() => { pending-- })
    return tail
  } catch {
    health.droppedRecords++
    return Promise.resolve()
  }
}

function readRecord(line: string, day: string): LogRecord | undefined {
  try {
    if (Buffer.byteLength(line) > maxLineBytes) return
    const value = JSON.parse(line)
    if (!value || value.schemaVersion !== 1 || !member(events, value.event) || !member(['info', 'warn', 'error'] as const, value.level)) return
    if (typeof value.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.timestamp) || value.timestamp.slice(0, 10) !== day || new Date(value.timestamp).toISOString() !== value.timestamp) return
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.runId)) return
    if (!value.details || typeof value.details !== 'object' || Array.isArray(value.details)) return
    return { schemaVersion: 1, timestamp: value.timestamp, pid: value.pid, runId: value.runId, level: value.level, event: value.event, details: cleanDetails(value.details) }
  } catch { return }
}

/** Returns the newest matching records in file order, with bounded input and output. */
export async function readLogs(options: ReadLogsOptions = {}): Promise<LogRecord[]> {
  try {
    const day = options.day ?? new Date().toISOString().slice(0, 10)
    if (!validDay(day)) return []
    if (options.limit !== undefined && (typeof options.limit !== 'number' || !Number.isFinite(options.limit))) return []
    const limit = options.limit === undefined ? 100 : Math.min(200, Math.max(0, Math.floor(options.limit)))
    if (!Number.isFinite(limit) || !limit) return []
    const filters = ['requestId', 'operationId', 'sessionId'] as const
    for (const key of filters) if (options[key] !== undefined && (typeof options[key] !== 'string' || !safeId.test(options[key]!))) return []
    const handle = await logDirectory(false)
    try {
      const file = await checkedFile(handle, day, false)
      try {
        const size = (await file.stat()).size
        const length = Math.min(size, maxBytes)
        const start = size - length
        const bytes = Buffer.alloc(length)
        let read = 0
        while (read < length) {
          const result = await file.read(bytes, read, length - read, start + read)
          if (!result.bytesRead) break
          read += result.bytesRead
        }
        const text = bytes.subarray(0, read).toString('utf8')
        const result: LogRecord[] = []
        // Scan backwards without splitting a tampered file into millions of strings.
        let end = text.lastIndexOf('\n')
        while (end >= 0 && result.length < limit) {
          const previous = end === 0 ? -1 : text.lastIndexOf('\n', end - 1)
          if (previous < 0 && start > 0) break
          if (end - previous <= maxLineBytes) {
            const record = readRecord(text.slice(previous + 1, end), day)
            if (record && filters.every(key => options[key] === undefined || record.details[key] === options[key])) result.push(record)
          }
          if (previous < 0) break
          end = previous
        }
        return result.reverse()
      } finally { await file.close() }
    } finally { await handle.close() }
  } catch { return [] }
}
