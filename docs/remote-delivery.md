# Remote Delivery

Remote peers are explicit configuration, not discovered execution targets. Each
machine keeps its own persistent `Store` and database machine ID. There is no
daemon, remote installation, arbitrary command API, or resource-cleanup RPC.

## Prerequisites

- Install Bun on both machines. The receiver's non-interactive SSH `PATH` must
  resolve `bun`. Node alone cannot run the SQLite helper.
- Build this project with `npm run build` and provision the build on the receiver.
  Configure the absolute path to its `dist/remote-helper.js`. The sibling built
  modules must also be present. The transport does not install anything.
- Configure non-interactive SSH authentication and verify the host key in advance.
  Unknown or changed host keys fail. The transport never enrols keys automatically.
- Read the receiver's actual `Store.machineId` through a trusted provisioning
  channel. Never accept a returned machine ID as a replacement for the configured ID.

## Configuration

The local file is `~/.config/opencode/opencode-herdr/peers.json`, or
`$XDG_CONFIG_HOME/opencode/opencode-herdr/peers.json` when configured. It must be a
regular file owned by the running OS user, mode `0600`, with no symlinks in its
path. Missing files fail closed. No peers are configured by default.

```json
{
  "peers": [
    {
      "id": "build-machine",
      "sshTarget": "worker@build-machine",
      "helperPath": "/opt/opencode-herdr/dist/remote-helper.js",
      "expectedMachineId": "REPLACE_WITH_RECEIVER_DATABASE_UUID",
      "token": "REPLACE_WITH_INDEPENDENT_RANDOM_SECRET"
    }
  ],
  "server": {
    "trustedOrigins": [
      {
        "machineId": "REPLACE_WITH_SENDER_DATABASE_UUID",
        "token": "REPLACE_WITH_MATCHING_RANDOM_SECRET"
      }
    ]
  }
}
```

Place a sender's token in its local `peers` entry and the matching receiver's
`server.trustedOrigins` entry. Supply an independently generated opaque secret
with at least 256 bits of entropy per origin/receiver relationship, for example
64 random hexadecimal characters. Tokens are never generated automatically.
Printable tokens of 32 to 512 characters are accepted, but length checks do not
prove entropy. Missing tokens, duplicate origins and reused server tokens fail.
Either `peers` or `server` can be omitted, meaning an empty allowlist.

`readRemoteConfig()` reads trusted local configuration. Pass its `peers` to
`new RemoteTransport(store, peers)`. Tokens are configuration, never tool inputs.
Do not log the config or inject arbitrary runner functions from tool arguments.
The optional runner constructor parameter is a trusted test seam only.

## Trust Boundary

SSH authenticates an OS account, not the packet's claimed origin machine or
OpenCode session. The helper therefore requires both an allowlisted origin
machine ID and its opaque token. Comparison uses SHA-256 digests and
`timingSafeEqual`. The token travels only inside JSON on SSH stdin, never in
process arguments, stored operation payloads, receipts or error diagnostics.

This is a same-user trust model, **not multi-user authentication proof**. Anyone
who can read or modify that OS user's configuration, helper, SSH setup or database
can impersonate the user and its sessions. Root can also bypass these controls.
The token is a bearer credential, not proof of a physical machine. SSH environment
variables such as `SSH_CONNECTION` do not prove a claimed origin identity. Separate
OS accounts and trusted provisioning are required across hostile principals.

SSH target, helper path and local SSH configuration are operator-trusted config.
Targets beginning with `-` or containing whitespace/control characters are
rejected. Helper paths must be absolute, normalised and contain no NUL/newlines.
The remote path is POSIX single-quoted, including embedded apostrophes.

## Wire Protocol

Each call launches exactly:

```text
execFile('ssh', ['-T', '-o', 'BatchMode=yes', '-o',
  'StrictHostKeyChecking=yes', '--', sshTarget, "bun '<quoted helperPath>'"])
```

One JSON packet is written to stdin, followed by EOF:

```json
{
  "protocolVersion": 1,
  "originMachineId": "SENDER_DATABASE_UUID",
  "originSessionId": "sender-session",
  "expectedMachineId": "RECEIVER_DATABASE_UUID",
  "token": "SECRET_FROM_LOCAL_CONFIGURATION",
  "op": "inspect",
  "args": { "requestId": "request-id" }
}
```

Every operation validates the protocol, origin token and expected receiver
database ID before accessing coordination records. The client performs an
authenticated handshake before other RPCs and verifies the machine ID again on
each response. It never falls back to another peer or retargets a changed database.

Success is `{protocolVersion:1,machineId,ok:true,result}`. The helper emits only a
generic failure envelope and exits nonzero on rejection. Raw exceptions, packets,
stderr and SSH diagnostics are not returned to callers. Input is limited to
64 KiB, output to 1 MiB, and each SSH/helper process to 10 seconds. A handshake
and the subsequent operation are separate exchanges, each with that bound.
Oversized listings or histories fail rather than truncate silently.

| Operation | Arguments | Result |
| --- | --- | --- |
| `handshake` | none | receiver machine ID |
| `agents` | none | local Store agents |
| `enqueue` | originDirectory, recipientId, kind, text, executionPolicy (default advisory), idempotencyKey | Request |
| `inspect` | requestId | History, including questions and outcomes |
| `cancel` | requestId | Request |
| `resume` | requestId, instructions, idempotencyKey, expectedGeneration | Request |
| `reply` | questionId, answer | Question |

Unknown operations and extra argument fields are rejected. The helper takes no
command-line arguments. All methods call local Store methods only. Cancellation
retires queue work and may report `mayContinue`; it never terminates an agent or
deletes resources. Listing does not grant ownership or inspection rights.

The receiver namespaces the origin as
`remote:<machine UUID>:<encodeURIComponent(session ID)>`. Local OpenCode session
IDs must not use the reserved `remote:` prefix. This separates ordinary local
sessions and equal session IDs from different origin machines. Origin directories
must be lexically canonical absolute paths. They are metadata only: the helper
never resolves symlinks, opens, creates, or otherwise accesses the sender's path.
Actual notifications/delivery must recognise remote origins rather than treating
their directories as receiver-local working directories.

## Persistence And Recovery

`RemoteTransport.request(peerId, input)` records an immutable, secret-free intent
using `Store.beginOperation('remote.request', originSessionId, idempotencyKey,
payload)`. The payload pins peer ID, SSH target, helper path, expected machine ID
and enqueue arguments. Changing any of those with the same key is a conflict.
Rotating a configured token does not change the intent.

Before mutating network I/O, the operation becomes `unknown`. A valid enqueue receipt sets
it to `confirmed`, with the latest request in `operation.result.request`. These
are **RPC receipt states**, separate from the request's receiver delivery state.
A confirmed receipt may legitimately describe a receiver request in `unknown`.

A lost response leaves the operation uncertain. Retrying `request` with the
identical key and payload is safe: receiver `Store.enqueue` deduplicates it and
returns the same request's current generation. It does not create another external
prompt or reset delivery state. This is not permission to retry an uncertain model
prompt submission. External delivery remains the receiver plugin's responsibility.

`inspect(peerId, requestId, sessionId)` and `sync(peerId, sessionId)` refresh saved
receipts. `remoteOutbox(store, sessionId)` projects those receipts as `Request[]`,
using the local origin session ID. Unavailable inspection produces `unknown`
instead of presenting stale state as confirmed. Last receipts remain stored.
An intent with no receipt is displayed as an `unknown` placeholder using its local
operation ID, revision/generation/sequence zero and an empty delivery ID. That ID
is not a receiver request ID. Inspect it through `list_operations`, not request
inspection. Transport request methods reject these placeholder IDs before SSH.

`sync` automatically retries missing-receipt enqueue intents after restart, using
their immutable persisted arguments and original idempotency key. Before any
recovery or inspection it checks that peer ID, SSH target, helper path and receiver
machine ID still match the stored endpoint. Changed endpoints fail closed rather
than silently retargeting work. Token rotation is permitted. The caller schedules
polling/backoff (currently a five-second plugin interval), not the transport.

## Atomic Cache Contract

The transport uses these Store methods directly:

```ts
cacheRemote(operationId: string, request: Request, history?: History): void
failRemote(operationId: string, observedUpdatedAt: number): void
```

Every receiver request carries a positive monotonic `revision`. It advances on
request, delivery, question, answer and result changes, including changes that do
not change the displayed request state. `cacheRemote` transactionally guards
against older revisions, stores the receipt and optional full
`operation.result.history`, and schedules deduplicated local notices for every
result and open question in that history. Equal-revision history may enrich a
receipt-only cache. Newer receipt-only updates must not discard saved history.
Notifications are based on result/question identity, never a request-state diff.
Repeated polls and restart recovery therefore do not duplicate notices or miss
a result whose request state was already cached by enqueue or resume.

`failRemote` is compare-and-swap against the operation's observed `updatedAt`.
It marks uncertainty while retaining receipts/history only if no later cache
success has advanced that version. Store operations advance `updatedAt` strictly
monotonically, including successes in the same millisecond and same-revision
polls. A delayed failure cannot overwrite a newer success, and a delayed snapshot
cannot regress a request to an earlier generation. Receipt-only enqueue/cancel/
resume calls use the same revision guard. Full histories arrive through inspect
and sync; reply also refreshes history to reflect the answered question.

`list(peerId)` lists agents. `cancel`, `resume` and `reply` require an exact origin
session, use Store ownership rules and inherit Store retry semantics. Resume
requires the generation being continued plus a stable idempotency key. These
methods do not grant management or destructive resource rights.

No configured peers or live SSH host are needed for the tests. Run
`npm run typecheck` and `bun test test/remote.test.ts`. Tests exchange packets
between independent persistent stores, simulate lost receipts and exercise the
helper subprocess. They do not claim to validate a real SSH deployment.
