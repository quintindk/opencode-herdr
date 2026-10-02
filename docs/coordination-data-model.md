# Coordination Data Model

Status: Partially implemented. See [Cutover and Limitations](cutover.md) for supported operations and safety gates.

Date: 2026-10-02

Target: `opencode-herdr`

Baseline: `herdr-envoy` at `48886af8c97f4ee7a8be856100bd4daa2ab83251`

## 1. Purpose

Separate agent identity, provisioning, requests, resource ownership and action
authorisation. Consolidate lifecycle semantics rather than merely renaming tools.

This document specifies the proposed domain model. Tool names are illustrative.
The storage choice and location in section 11 are agreed, but not implemented.
These are not existing APIs or commitments to a particular UI.
The target repository implements the core coordination lifecycle and sidebar
projections. This document still includes proposed authority, validation and
retention behaviour not yet implemented. The baseline implementation lives in
the separate `herdr-envoy` repository.

### Agreed Requirements

- Newly provisioned and existing agents use the same request lifecycle.
- Tasks expect a result or explicit handback.
- Instructions are queued for an agent without expecting handback.
- An agent can be started in another folder/workspace without an ongoing
  coordinator ownership relationship or an implicit assignment.
- Such independent agents remain user-managed.
- An independent agent can be closed at its owner's request.
- Sending work does not transfer ownership of the recipient or its resources.
- Persistence uses SQLite behind a transactional storage layer, located at
  `~/.config/opencode/opencode-herdr/coordination.sqlite`.
- Each machine owns its local store. Cross-machine collaboration communicates
  between those machines rather than sharing a database file or central database.

Everything else below is a proposed design. Decisions requiring confirmation are
collected in section 15.

## 2. Baseline and Boundaries

The current Envoy `Job` combines provisioning, assignment, resource references,
request delivery and coordinator notification state. Its variants are implicit:

| Current variant | Representation | Completion |
| --- | --- | --- |
| Bounded delegation | `mode` absent | `result.json` |
| Owned interactive session | `mode: interactive`, no `existing` | `session.json` |
| Existing-agent request | `mode: interactive`, `existing` present | `session.json` |

Current records include `coordinator.json`, `handoff.json`, `.consumed.json`,
`session.json`, `agent-session.json`, `result.json`, `block.json`, `reply.json`
and a heartbeat file. Discovery, mailbox and sidebar output are projections.

The proposed model does not replace external authorities:

| Domain | Authoritative system |
| --- | --- |
| Conversations, persona/model settings, messages | OpenCode |
| Machines, workspaces, panes, terminals | Herdr |
| Repositories, worktrees, branches, commits | Git |
| Requests, receipts, outcomes, grants, operation progress | Coordination plugin |

A stored reference is not proof that an external resource still exists or that
the caller may mutate it. Revalidate both identity and authority before acting.

## 3. Entities and Relationships

| Entity | Responsibility |
| --- | --- |
| `Agent` | Stable plugin identity for one exact OpenCode conversation |
| `Resource` | Reference to a process/container or filesystem resource |
| `Management` | Standing authority over explicitly selected agent resources |
| `Provisioning` | Recoverable creation and startup operation |
| `Request` | Task or instruction directed to one agent |
| `Delivery` | Submission intent and recipient receipt for one request |
| `TaskResult` | Reported task outcome and evidence |
| `Question` | Correlated clarification and reply |
| `Authorisation` | Trusted, scoped permission for a particular operation |
| `CloseOperation` | Recoverable shutdown and optional resource cleanup |
| `Notification` | Delivery of a lifecycle event to an originating conversation |

```text
Principal ──owns──────────────────────> Agent
Principal / coordinator ──manages────> Management ──scopes──> Resources
Provisioning ──creates/binds─────────> Agent + Resources
Request ──targets───────────────────> Agent
Request ──has───────────────────────> Delivery
Task Request ──has──────────────────> TaskResult + Questions
Authorisation ──permits─────────────> CloseOperation ──targets──> Agent/Resources
Lifecycle event ──produces──────────> Notification
```

An agent has many requests. A request has one recipient and never acquires that
recipient's management rights. A conversation restart with a new conversation ID
creates a new agent binding rather than silently redirecting old requests.

## 4. Shared Values and Identity

The schemas below are conceptual TypeScript. `ID` denotes an opaque unique ID,
not a path or display name. Every mutable record has this envelope:

```ts
interface RecordHeader {
  schemaVersion: number
  id: ID
  revision: number
  createdAt: string       // UTC ISO 8601
  updatedAt: string       // UTC ISO 8601
}

interface ConversationRef {
  machineId: ID           // Stable machine registration, not a mutable label
  conversationId: string
}

interface Origin {
  principalId: ID         // User identity supplied by the trusted host
  conversation: ConversationRef
}

interface AgentBinding {
  conversation: ConversationRef
  socketRef: string
  workspaceId: string
  paneId: string
  terminalId: string
  directory: string      // Canonical absolute path on the target machine
}
```

- Display names, paths and pane labels are not identities.
- Resource references are machine-scoped.
- A pane ID alone is insufficient for destructive actions. Validate its current
  terminal and conversation binding.
- The host supplies principal identity. An LLM-provided owner name is not proof.
- Unknown ownership remains unknown. Do not infer ownership merely from discovery.
- Initial scope is local-machine mutations. Machine-aware references do not imply
  remote dispatch or shutdown support.
- `revision` provides compare-and-swap protection against stale writes.

## 5. Agents, Resources and Management

```ts
interface Agent extends RecordHeader {
  label?: string
  binding: AgentBinding
  ownerPrincipalId: ID | null
  managementId: ID | null
  provisioningId?: ID
  availability: "ready" | "unavailable" | "exited"
  lastObservedAt: string
}

interface Resource extends RecordHeader {
  machineId: ID
  kind: "agent_process" | "workspace" | "pane" | "worktree" | "branch" | "folder"
  locator: string
  ownerPrincipalIds: ID[] | null // Null means ownership is not established
  createdByProvisioningId?: ID
  parentResourceId?: ID
  state: "present" | "absent" | "unknown"
  lastObservedAt: string
}

interface Management extends RecordHeader {
  agentId: ID
  manager: Origin
  state: "active" | "released"
  permissions: Array<{
    resourceId: ID
    actions: Array<"close" | "remove_worktree" | "delete_branch">
  }>
}
```

An independent agent has no active `Management` record. It can still have a known
human owner and can still receive requests. Managed agents also have a human owner.

Resources are recorded separately because authority differs by resource. Creating
a workspace in an existing folder may grant authority to close that workspace,
but never implicitly grants authority to delete the folder.

Resource ownership is established by the trusted host independently of agent
ownership. Creation provenance alone is not an ownership claim. Shared resources
require approval satisfying their ownership policy; owning one agent using a
shared worktree does not authorise removing that worktree.

Live busy/idle status is an observation from Herdr/OpenCode, not a task outcome.
An idle agent can still have an outstanding task. An unavailable observation does
not prove exit. Agent exit does not prove that its task completed.

### Owner-Directed Closure

Independent means no standing coordinator shutdown authority. It does not mean
the owner cannot instruct the coordinator to close the agent.

An owner-directed close uses a scoped `Authorisation`. It does not create a
`Management` relationship and does not authorise deletion of the working folder.
The exact trusted approval mechanism is unresolved. Until implemented, a quoted
instruction alone must not enable destructive operations.

## 6. Provisioning

```ts
interface Provisioning extends RecordHeader {
  origin: Origin
  idempotencyKey: string
  persona: string
  machineId: ID
  folder: string
  placement: "pane" | "subworkspace" | "workspace"
  isolation:
    | { kind: "existing_folder" }
    | { kind: "worktree"; branch: string; baseCommit: string }
  management: "managed" | "independent"
  state: "preparing" | "launching" | "ready" | "failed" | "uncertain"
  resourceIds: ID[]
  agentId?: ID
  launchAttempt?: { id: ID; startedAt: string }
  failure?: { code: string; message: string }
}
```

```text
preparing -> launching -> ready
     |           |
     +-----------+----> failed or uncertain
```

- Provisioning does not contain a task. Assignment is a subsequent operation.
- Record creation intent before external side effects and resource IDs immediately
  after confirmation. A launched command is not a verified agent.
- `ready` requires an exact live conversation binding and expected folder.
- An independent agent becomes user-managed once readiness and release of temporary
  provisioning responsibility are durably recorded.
- Before readiness, rollback is limited to resources created by this operation and
  proven unused. Never delete an existing folder.
- `uncertain` means an external effect may have happened. Reconcile inventory before
  retrying launch or attempting cleanup.
- Retrying an idempotency key returns the existing operation. Different parameters
  under the same key are rejected.
- A timeout is an observation or failure reason, not permission to kill the agent.

This operation owns startup bookkeeping, not permanent authority over independent
agents. A failed response after successful startup must not cause duplicate agents.

## 7. Requests and Delivery

```ts
interface RequestBase extends RecordHeader {
  origin: Origin
  recipientAgentId: ID
  idempotencyKey: string
  text: string
  queueSequence: number
  deliveryId: ID
  cancelled?: {
    at: string
    by: Origin
    reason: string
    mayContinue: boolean
  }
}

type Request = RequestBase & (
  | { kind: "instruction" }
  | {
      kind: "task"
      generation: number
      executionPolicy: "advisory" | "code_change"
      outcome: "pending" | "paused" | "completed" | "failed"
      currentResultId?: ID
      validationPolicy?: {
        branch?: string
        baseCommit?: string
        requireCleanWorktree: boolean
        checks: Array<{ command: string; expectedExitCode: number }>
      }
    }
)

interface Delivery extends RecordHeader {
  requestId: ID
  generation: number | null // Task generation; null for instructions
  target: AgentBinding     // Exact binding captured for this delivery
  state: "queued" | "submitted" | "accepted" | "unknown" | "cancelled"
  attempt?: { messageId: string; startedAt: string }
  messageConfirmedAt?: string
  acceptedAt?: string
  acceptedBy?: ConversationRef
  failure?: { code: string; message: string }
}
```

### Meaning of Acceptance

`accepted` means the recipient's request-reading operation has validated its
binding, returned the request and durably recorded acceptance. It does not prove
the model understood or obeyed the content. Message read-back alone only confirms
submission to the conversation.

Acceptance is idempotent. If a response is lost after saving acceptance, reading
again returns the same request without creating a new delivery.

```text
queued -> submitted -> accepted
              |
              +----> unknown -> submitted / accepted after reconciliation

queued -> cancelled
```

Persist the submission intent before calling OpenCode. An uncertain attempt is
not automatically resent. A confirmed message may be accepted after restart.
Never replace a missing recipient with a newly discovered conversation silently.

### Queue Rules

- One ordered queue per exact recipient agent, across request origins.
- Allocate `queueSequence` transactionally rather than sorting solely by clocks.
- Both contracts wait for the recipient to be idle before submission.
- An accepted instruction releases its queue slot and expects no handback.
- A task holds its slot until handback, pause or explicit cancellation.
- Instructions do not bypass an outstanding task in the initial design.
- Releasing an instruction slot does not bypass the idle check for the next item.
- `unknown` delivery holds the slot until reconciled or cancelled.
- A vanished target blocks delivery and surfaces an actionable status.
- Busy checking and submission are not atomic unless the host provides such an API.
  Expose this race rather than claiming an interrupt-free guarantee.

Instruction delivery may produce a receipt in the UI, but must not generate a
waiting-for-result state. Calling handback on an instruction is a clear error,
not an implicit handback of the agent's original task.

### Cancellation

Before submission, cancel delivery. After a submission attempt, cancellation
releases the queue obligation but cannot retract the message or interrupt work.
Preserve the delivery evidence and set `mayContinue: true`.

Late acceptance or results may be recorded after cancellation without clearing
the cancellation record or reopening the queue slot. Notifications identify them
as late outcomes. Cancellation, process shutdown and Git discard are different
operations.

## 8. Task Results, Questions and Resume

```ts
interface TaskResult extends RecordHeader {
  requestId: ID
  generation: number
  author: ConversationRef
  outcome: "paused" | "completed" | "failed"
  summary: string
  evidence: string[]
  checks: Array<{
    command: string
    exitCode: number | null
    summary: string
    provenance: "recipient_reported" | "coordinator_executed"
  }>
  risks: string[]
  followUps: string[]
  git?: { branch: string; baseCommit: string; headCommit: string }
  validation: {
    status: "not_required" | "pending" | "accepted" | "rejected"
    reasons: string[]
    validatedAt?: string
  }
}

interface Question extends RecordHeader {
  requestId: ID
  generation: number
  author: ConversationRef
  text: string
  state: "open" | "answered" | "withdrawn" | "expired"
  reply?: { author: Origin; text: string; at: string }
}
```

- One published result per task generation, guarded by compare-and-swap.
- Repeated identical completion returns the original result. A conflicting retry
  is rejected rather than overwriting history.
- Reported outcome and validation are distinct. A claimed completion can fail
  validation. The UI must show that distinction.
- Policy applies equally to new and existing agents. Provisioning history must
  not determine whether reported Git evidence is validated.
- Check evidence states who ran the command. A reported exit code is not an
  independently verified execution.
- Commit and discard are not task outcomes. Git actions require separate scope
  and authorisation and must not be inferred from handback.
- Questions have their own IDs. Replies match question, request and generation.
  An old reply cannot satisfy a new question.
- A blocked question does not release the task's queue slot.
- Explicit resume of paused work advances generation and re-enters the queue at
  a new sequence position. Preserve earlier results and delivery attempts.
- Existing tasks ahead of resumed work are not pre-empted. Terminal work receives
  a new follow-up request instead of silently reopening its final result.

On resume, allocate a new `Delivery` and update the request's `deliveryId`.
Retain older deliveries by `requestId`; `currentResultId` refers to the current
generation only. No branch, pane or conversation is recreated merely by resume.
Acceptance must match the delivery ID and generation submitted in its prompt.
A delayed read for a prior generation cannot accept or return the resumed task.

## 9. Action Authorisation and Closure

```ts
interface Authorisation extends RecordHeader {
  principalId: ID
  issuedBy: string         // Trusted host/approval provider
  evidenceRef: string     // Reference, not model-supplied proof
  agentId: ID
  binding: AgentBinding
  actions: Array<{
    action: "close" | "force_stop" | "remove_worktree" | "delete_branch" | "discard"
    resourceId?: ID
  }>
  expiresAt: string
  operationId: ID          // One operation; retries are the same operation
  state: "valid" | "consumed" | "revoked"
}

interface CloseOperation extends RecordHeader {
  origin: Origin
  agentId: ID
  target: AgentBinding
  authorities: Array<
    | { kind: "management"; managementId: ID }
    | { kind: "owner_grant"; authorisationId: ID }
  >
  idempotencyKey: string
  state: "requested" | "blocked" | "closing" | "closed" | "failed" | "uncertain"
  resources: Array<{
    resourceId: ID
    action: "close" | "force_stop" | "remove_worktree" | "delete_branch" | "discard"
    authorityId: ID
    state: "pending" | "completed" | "failed"
  }>
  failure?: { code: string; message: string }
}
```

### Closure Invariants

- Revalidate the exact conversation/terminal and authority immediately before
  acting. A reused pane is not the authorised target.
- Independent agents require a trusted owner grant. Managed agents require a
  matching active management permission or a separate owner grant.
- Each step names the authority covering its action and exact resource. Supplementary
  force-stop approval can coexist with standing management permission. A trusted
  issuer must establish resource-specific authority for cleanup, not derive it
  from ownership of the agent alone.
- Closure does not implicitly approve force-stop, discard or branch deletion.
- Default to blocking on busy execution. Offer explicit force-stop approval rather
  than silently interrupting work.
- Check the proposed resource effects before closing the pane. A dirty worktree
  blocks removal, but need not block an authorised close-only operation.
- Closing a workspace must not close unrelated agents within it. If the host lacks
  a safe narrower operation, block and request approval for the full affected set.
- Preserve folders, branches and worktrees unless cleanup was explicitly included.
- Mark `closed` only after confirming the target conversation is no longer live
  and requested resource actions have completed. Transport success is insufficient.
- Partial failure preserves step progress. Retrying cannot expand authorised scope.
- An explicit additional approval may add a new scoped step while the operation is
  blocked. Persist that amendment before execution; an ordinary retry cannot add it.
- Consume a grant for the operation atomically. Recovery may finish that same
  operation, but cannot reuse its grant for a different agent or operation.
- A quoted `userInstruction` may be audit context, never the authorisation itself.

Closing an agent does not mark pending tasks completed. Surface interrupted work
and undeliverable queued requests separately. How those requests are archived or
reassigned requires an explicit subsequent decision.

## 10. Notifications and Observations

```ts
interface Notification extends RecordHeader {
  originEntityId: ID
  eventKey: string
  recipient: ConversationRef
  text: string
  state: "pending" | "submitted" | "delivered" | "superseded" | "failed"
  messageId?: string
  attemptedAt?: string
  deliveredAt?: string
}
```

Persist notifications separately from their source entities. Use a unique
`(originEntityId, eventKey, recipient)` key to suppress duplicate scheduling.
Receipt confirms a message exists, not that a human saw it. A delivered notification
does not alter task outcome or grant cleanup authority.

Discovery, mailbox, queue counts and sidebar state remain derived views. Include
observation time and distinguish unknown/unavailable from absent. Never use a
display label or cached ownership badge as an authorisation check.

Liveness timeouts produce observations/notifications. They do not become automatic
failure, cancellation or shutdown decisions.

## 11. Persistence and Recovery

Agreed: SQLite behind a transactional storage layer, with one database per user
per machine shared across that user's projects:
`~/.config/opencode/opencode-herdr/coordination.sqlite`.
This is mutable runtime state colocated with OpenCode configuration by choice,
not a file to commit or synchronise with dotfiles. Keep the database and its
SQLite sidecar files on a local filesystem. Use SQLite-consistent backups rather
than copying only the main database file while writes are active.

Each machine owns its local store. Cross-machine collaboration will communicate
through authenticated operations between machines, not direct remote database
access or database-file replication. There is no central shared database and no
transaction spanning machines. Transport, authentication and cross-machine
delivery/reconciliation contracts remain to be specified. Initial implementation
scope remains local-machine mutations.

Driver: `bun:sqlite`, validated in the OpenCode 1.18.27 server plugin runtime on
Linux ARM64 with WAL, foreign keys and `synchronous=FULL`. See
[SQLite Driver Validation](sqlite-validation.md) for the repeatable host,
multi-process claim and crash-recovery probes and their limits. Storage migrations
must be explicit and versioned.

Required atomic boundaries:

- Allocate request and queue sequence.
- Persist submission intent before external dispatch.
- Record acceptance and release an instruction's queue slot.
- Publish task result and release its queue slot.
- Advance a resumed generation and allocate its delivery.
- Consume an action grant and start its operation.
- Persist independent readiness and end temporary provisioning responsibility.
- Persist a domain transition and schedule its notification.

External Herdr, OpenCode and Git actions cannot join the database transaction.
Use persisted intent, idempotency and reconciliation. Do not claim exactly-once
external execution where the host provides no such guarantee.

Validate records at read/write boundaries with versioned runtime schemas. Reject
unknown versions safely. Use restrictive permissions and keep authentication
material out of logs and UI projections. Request acceptance/result publication
must authenticate the actual calling conversation, not trust an ID in arguments.
The concrete host transport/authentication mechanism is an implementation decision.

Recovery reconstructs operations from durable state and reconciles external
bindings. It does not silently relaunch independent agents, retarget requests,
delete uncertain resources or retry an unconfirmed instruction blindly.

Audit events record actor, entity, transition, authority reference and time. Do
not log task bodies or secrets by default. Terminal records require an explicit
retention/archive policy rather than indefinite accidental accumulation.

## 12. Illustrative Tool Flows

These examples describe intent. Final tool names and schemas remain open.

### Managed Worker

```json
{
  "tool": "open_agent",
  "persona": "worker",
  "folder": "/work/project",
  "placement": "pane",
  "management": "managed",
  "isolation": { "kind": "worktree", "branch": "feature/auth", "baseCommit": "<sha>" },
  "idempotencyKey": "auth-worker"
}
```

After verified readiness, submit a task to the returned agent identity. The task
does not automatically close its recipient on completion.

```json
{
  "tool": "request_agent",
  "identity": "<agent-id>",
  "kind": "task",
  "text": "Review the authentication changes and return findings without editing.",
  "executionPolicy": "advisory",
  "idempotencyKey": "auth-review"
}
```

### Instruction Without Handback

```json
{
  "tool": "request_agent",
  "identity": "<agent-id>",
  "kind": "instruction",
  "text": "Use the existing test helpers for subsequent work.",
  "idempotencyKey": "test-helper-guidance"
}
```

Returns a queued receipt. Recipient reads and accepts the instruction. Its queue
slot is released. No task result or handback is created.

### Independent Agent and Owner-Directed Close

```json
{
  "tool": "open_agent",
  "persona": "build",
  "folder": "/work/customer-demo",
  "placement": "workspace",
  "management": "independent",
  "isolation": { "kind": "existing_folder" },
  "idempotencyKey": "customer-demo-agent"
}
```

No task is created. Later, the owner requests closure through the trusted approval
path. The host issues a grant scoped to the exact agent and close operation.

```json
{
  "tool": "close_agent",
  "identity": "<agent-id>",
  "authorisationId": "<host-issued-grant-id>",
  "cleanup": "none",
  "idempotencyKey": "close-customer-demo-agent"
}
```

Close the authorised agent without deleting its folder or acquiring management
rights. If busy or if closing its workspace would affect other agents, block and
surface the additional effects for approval.

## 13. Migration From Envoy

No automatic migration is authorised by this specification.

| Existing data | Proposed destination |
| --- | --- |
| Job peer binding and `agent-session.json` | `Agent` |
| Created-resource flags and location fields | `Resource` and scoped `Management` |
| Launch/cleanup progress | `Provisioning` or `CloseOperation` |
| Handoff/consumed task | Task `Request` |
| `existing` delivery fields | `Delivery` |
| Interactive control/latest report | Request generation and `TaskResult` |
| Bounded result and checks | `TaskResult` with explicit evidence provenance |
| Block/reply | `Question`, with a new question identity |
| Pending/delivered notification fields | `Notification` |

Migration must not infer trusted human ownership or owner grants from old job
metadata. Existing requests cannot become managed agents. Old `commit`/`discard`
dispositions are legacy intent, not new trusted authorisations. Old instructions
do not exist as a separate contract and must not be inferred from task wording.

Retain old identifiers and provenance where imported. Missing historical detail
remains unknown. Preserve legacy records until a verified migration/retention
policy exists. Compatibility tool wrappers may translate calls without preserving
the old mixed aggregate internally.

## 14. Acceptance Criteria

- New and pre-existing recipients use identical task result and delivery semantics.
- Accepted instructions create no expected handback and do not strand queue slots.
- A task cannot accidentally complete another task or an instruction.
- Cancellation after dispatch makes no claim that execution stopped.
- Duplicate provisioning and request submissions are idempotent.
- Independent provisioning creates no implicit assignment or management rights.
- An authenticated owner can authorise exact-agent closure without granting folder
  deletion or permanent coordinator management.
- A stale/reused pane binding and an untrusted instruction quote cannot close an agent.
- Busy shutdown, force-stop and dirty-resource cleanup are independently guarded.
- A crash at every submission, acceptance, result, startup-release and close step
  recovers without duplicate work or expanded authority.
- A rejected validation remains visibly different from accepted completion.
- Resume preserves history and cannot consume stale results or question replies.
- UI projections distinguish request outcome, delivery, live activity and authority.
- No migration grants rights that the old records cannot establish.

## 15. Decisions Still Required

1. **Owner identity and approval:** Which trusted host establishes the human owner
   and issues action grants, including for agents discovered after plugin restart?
2. **Instruction priority:** Confirm strict FIFO behind active tasks. Urgent steering
   or interruption would require a separate contract and host support.
3. **Pause and resume:** Confirm generation-based resume with a fresh queue position,
   rather than creating a new linked request for every continuation.
4. **Shutdown semantics:** Confirm default busy refusal and explicit force approval.
   Define whether the host can stop only OpenCode while retaining its terminal.
5. **Remote delivery:** Specify cross-machine transport, authentication and
   reconciliation before enabling remote mutations. The local `bun:sqlite`
   driver has passed the initial host and cross-process probes in section 11.
6. **Ownership defaults:** Require explicit managed/independent provisioning or choose
   a documented default. Do not infer the choice from placement alone.
7. **Retention and migration:** Define archive periods, sensitive brief retention and
   whether legacy Envoy sessions are imported or supported separately until finished.
8. **Tool surface:** Decide which existing names remain as adapters only after the
   entity boundaries and authority rules are agreed.
