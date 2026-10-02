# Structured Logging

`src/log.ts` is a best-effort diagnostic sink, not an audit journal or coordination store. No delivery, approval, closure, cleanup or other state transition may depend on a log succeeding. It has no console fallback and never serialises exceptions.

## API

```ts
import { log, loggingStatus, readLogs, type Details, type Event, type LogRecord } from './log.js'

await log('delivery_unknown', {
  requestId: request.id,
  deliveryId: request.deliveryId,
  generation: request.generation,
  reason: 'readback',
})

const health = loggingStatus()
const records = await readLogs({ day: '2026-10-02', requestId: request.id, limit: 100 })
```

- `log(event: Event, details: Details = {}): Promise<void>` never rejects. Awaiting it waits for that record to be written, dropped or failed. Fire-and-forget is supported, but process exit can lose queued records. There is no fsync durability guarantee.
- `loggingStatus(): LoggingStatus` returns a copy of `{ directory, failedWrites, droppedRecords, lastFailureAt?, lastWriteAt? }`. Counters and timestamps are process-local. No raw errors are exposed. Invalid input, queue overflow and size-cap refusal increment `droppedRecords`. Filesystem/append/retention failures increment `failedWrites`. Read failures return an empty list and do not increment write counters.
- `readLogs({ day?, limit?, requestId?, operationId?, sessionId? }): Promise<LogRecord[]>` defaults to the current UTC day and the newest 100 matching records. The limit is capped at 200, rounded down, and non-positive/non-finite values return no records. Filters are exact and combined with AND. Results retain file order, not timestamp sorting across processes.
- `Event`, `Details`, `Level`, `LogRecord`, `LoggingStatus`, `ReadLogsOptions` and the readonly `events` array are exported. The directory is resolved once on module import. Restart to change configuration.

Diagnostics may expose the log directory only in response to an explicit operator request. Do not inject diagnostic readback or health paths into routine messages, task payloads or telemetry.

## Record Contract

Each newline-delimited JSON record contains only `schemaVersion: 1`, an ISO UTC `timestamp`, positive integer `pid`, process-local random UUID `runId`, `level`, `event`, and `details`. Failed events default to `error`. Unknown outcomes, `plugin_conflict` and `delivery_deferred` default to `warn`. Other events default to `info`. An optional `details.severity` accepts only `info`, `warn` or `error`, becomes `level`, and is not persisted inside details.

Allowed event names:

```text
plugin_started plugin_ready plugin_stopped plugin_conflict
tool_started tool_completed tool_failed
delivery_deferred delivery_attempted delivery_confirmed delivery_unknown
notification_attempted notification_confirmed notification_unknown
reconciliation_started reconciliation_completed reconciliation_failed
provision_checkpoint approval_requested approval_decided
closure_checkpoint cleanup_checkpoint
validation_started validation_completed validation_failed
remote_attempted remote_confirmed remote_unknown sidebar_failed store_failed
```

Allowed details:

| Fields | Validation |
| --- | --- |
| `operationId`, `requestId`, `deliveryId`, `sessionId`, `agentId`, `peerId`, `tool`, `correlationId` | Strings matching `^[A-Za-z0-9_.:-]{1,160}$` |
| `phase` | Static call-site token matching `^[a-z][a-z0-9_]{0,47}$` |
| `state` | One of the states below |
| `reason` | One of the reasons below |
| `status`, `generation`, `revision`, `attemptCount`, `sequence`, `count` | Non-negative safe integers |
| `durationMs` | Finite non-negative number no greater than `Number.MAX_SAFE_INTEGER` |

States:

```text
starting ready stopped idle working busy blocked queued pending attempted
unknown submitted accepted confirmed deferred delivered superseded paused
completed failed cancelled open answered withdrawn requested approved denied
not_required
```

Reasons:

```text
busy binding settings transport readback conflict cancelled unavailable
timeout permission validation io unknown shutdown
```

Invalid fields are omitted, not truncated or coerced. Invalid events drop the whole record. Unicode remote session references are omitted. Unknown properties, inherited properties, getters, `toJSON`, error messages, arguments, paths, stdout, summaries, tasks and tokens are never serialised. No directory fingerprint is calculated.

**Callers must supply genuine identifiers and static phase/tool labels.** A syntactically valid token could still be a secret. Validation cannot distinguish a secret placed deliberately in an identifier field. Never pass user prose, exception text or credentials through allowed fields.

Readback constructs fresh records with this same allowlist. Unknown properties and invalid detail values in tampered files are discarded. Invalid envelopes, oversized lines, malformed JSON and incomplete final lines are skipped. Records are schema-checked, not authenticated: a same-user process can forge otherwise valid records.

## Storage And Bounds

- Default directory: `~/.config/opencode/opencode-herdr/logs`. An absolute `XDG_CONFIG_HOME` replaces `~/.config`. Empty or relative XDG paths are ignored.
- Daily files are named `YYYY-MM-DD.jsonl`, based on the enqueue timestamp in UTC. The app-specific directory and `logs` directory are enforced as mode `0700`. Newly created ancestors use `0700`, but existing shared config ancestors are not chmodded. Log files are enforced as mode `0600` before appending.
- Every ancestor is opened with `O_DIRECTORY | O_NOFOLLOW`, and child operations use pinned directory descriptors. Final files use `O_NOFOLLOW`; writes use `O_APPEND | O_CREAT`. Non-regular files, hard-linked files and app directories/files not owned by the effective process user are refused.
- Descriptor-relative paths use `/proc/self/fd` on Linux and `/dev/fd` elsewhere. A missing or incompatible descriptor filesystem, symlinked home/config ancestor, or unsupported platform fails closed. There is no unsafe path-based fallback. This is tested on Linux with Bun. It is not protection against a malicious process with the same UID or root, nor against an administrator making an existing ancestor writable to other users.
- Each process queues at most 128 records including the in-flight append. Excess calls resolve immediately and increment the drop counter. Each serialised record is limited to 4096 bytes including its newline. No unbounded promise queue is retained by the logger.
- A file is soft-capped at 16 MiB. A write whose size would cross the cap is dropped. The pre-write size check is not a cross-process lock: simultaneous writers may overshoot by their in-flight record sizes. Each record uses one append write, and partial writes are counted as failures without retrying fragments. Correct concurrent append semantics require a local filesystem that honours `O_APPEND`; do not use this as a distributed log on NFS.
- Retention runs before the first write of each UTC day per process. It removes only strictly valid dated `.jsonl` names older than today plus the preceding 29 UTC days. It does not follow stale symlinks, remove unrelated names or remove future-dated files. An inactive process performs no scheduled cleanup. Directory enumeration is proportional to its entry count.
- Reads consume at most the smaller of the opened file's initial size and 16 MiB, from the end of the file. A partial first line and any incomplete last line are ignored. Later appends cannot increase this read budget. At most 200 records are retained in the result. Reads are not a transactionally consistent snapshot of concurrently modified files.

## Verification

Run `bun test test/log.test.ts`. Coverage includes record validation, privacy projection on write/read, UTC retention, private modes, symlinks, hard links, path failure and recovery, queue overflow, day caps, malformed/oversized readback, filters, XDG fallback and concurrent independent Bun processes.
