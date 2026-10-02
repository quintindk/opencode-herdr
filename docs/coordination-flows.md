# Coordination Flows

Status: Partially implemented. See [Cutover and Limitations](cutover.md) for supported operations and safety gates.

Date: 2026-10-02

Companion: [Coordination Data Model](coordination-data-model.md)

## 1. Scope and Reading Guide

Specify the observable behaviour, calls, state changes and failure paths for the
proposed coordination model. This document makes no code or configuration changes
and does not authorise live agent operations or migration.

The data-model document defines the entities. This document exercises them.
Tool names below are illustrative contracts, not the current installed tools.
OpenCode/Herdr capabilities mentioned as requirements have not been verified by
this specification. Unsupported operations must refuse rather than improvise.

Agreed product requirements are tasks with handback, queued instructions without
handback, independent provisioning, separated resource ownership, and independent
agent closure at its owner's request. Queue priority, approval mechanisms and
other design choices remain proposals pending agreement.

Persistence is agreed: SQLite with a transactional storage layer at
`~/.config/opencode/opencode-herdr/coordination.sqlite`, shared across projects
for one user on one machine. Each machine owns its local store. Cross-machine
collaboration will use operations between machines, not a shared database file
or central database. Remote transport and delivery contracts remain unspecified
and remote mutations remain outside the initial implementation scope.

### Actors

| Actor | Responsibility |
| --- | --- |
| Owner | Human whose authority the trusted host establishes |
| Coordinator | Conversation that provisions agents or originates requests |
| Recipient | Exact conversation receiving a request |
| Plugin | Persists state, validates callers and runs delivery/reconciliation |
| Approval host | Establishes principal identity and issues scoped action grants |
| OpenCode/Herdr/Git | Perform and report external operations |

The coordinator is not automatically the owner. A recipient may itself coordinate
other work, subject to the same authority rules. Neither role grants extra rights.

### Common Guarantees

- Public calls return durable receipts, not unsupported claims of execution.
- Mutable operations use an idempotency key scoped to origin and operation kind.
  Identical retries return the same record; changed payloads under the same key fail.
- Agent identity, delivery identity and task generation are explicit. No ambiguous
  fallback to an original assignment or a similarly named conversation.
- Caller identity comes from the host transport, not tool arguments.
- No task result implies process shutdown, commit, merge, push or cleanup.
- No cancellation implies interruption. No instruction acceptance implies obedience.
- Unknown external outcomes remain unknown until reconciled.
- Side effects require both exact targeting and sufficient authority.

### Coverage Index

| Flow | Intent |
| --- | --- |
| F01 | Discover, inspect and select an agent |
| F02 | Provision an independent agent in an existing folder |
| F03 | Provision a managed agent, with or without isolation |
| F04 | Compose provisioning and assignment |
| F05 | Queue, submit and accept a task |
| F06 | Queue and accept an instruction without handback |
| F07 | Serialise requests from multiple coordinators |
| F08 | Ask and answer a clarification |
| F09 | Complete or fail a task and validate evidence |
| F10 | Pause and explicitly resume work |
| F11 | Cancel queued or submitted work |
| F12 | Reconcile uncertain delivery |
| F13 | Observe busy, missing, exited or moved recipients |
| F14 | Close an independent agent at the owner's request |
| F15 | Close a managed agent and optionally clean up resources |
| F16 | Handle busy shutdown, changed scope and partial cleanup |
| F17 | Release management without closing an agent |
| F18 | Deliver notifications and expose status |
| F19 | Recover after crashes and concurrent operations |
| F20 | Archive records and handle legacy sessions |

## 2. Illustrative Calls and Receipts

| Call | Role | Durable effect |
| --- | --- | --- |
| `list_agents`, `inspect_agent` | Discovery | None beyond observations |
| `open_agent` | Provisioning | Creates/reuses a `Provisioning` |
| `request_agent` | Assignment | Creates a `Request` and `Delivery` |
| `read_request` | Recipient acceptance | Accepts the exact delivery |
| `ask_request`, `reply_request` | Clarification | Creates/answers a `Question` |
| `read_question` | Recipient reply retrieval | Read-only authenticated answer retrieval |
| `hand_back` | Task result | Publishes one result per generation |
| `resume_request` | Continuation | Advances generation and queues a delivery |
| `cancel_request` | Queue retirement | Records cancellation without interruption |
| `inspect_request`, `inspect_operation` | Status | Read-only projections |
| `close_agent` | Shutdown | Prepares/retries a `CloseOperation` |
| `release_agent` | Management release | Ends standing management authority |

`read_request` is a proposed explicit name for request-aware reading, not a
requirement to remove the current `read_task` name. The approval host is not an
agent-callable tool for manufacturing its own grants.

Example initial request receipt:

```json
{
  "requestId": "req-1",
  "deliveryId": "delivery-1",
  "recipientAgentId": "agent-1",
  "kind": "task",
  "generation": 1,
  "delivery": "queued",
  "outcome": "pending"
}
```

Example provisioning receipt:

```json
{
  "provisioningId": "provision-1",
  "state": "preparing",
  "agentId": null
}
```

An agent ID is returned once bound and verified. Inspection or a notification
reports readiness. A synchronous implementation may return `ready` immediately
only if it has already verified the postcondition.

## 3. Discovery and Provisioning

### F01. Discover and Select

**Preconditions:** Local discovery is available. Remote discovery is read-only in
the initial scope.

1. Coordinator calls `list_agents`.
2. Plugin reads current Herdr inventory and correlates exact conversation bindings.
3. Return agent identity, machine, folder, activity, availability, observation time
   and known management relationship. Unknown owner remains unknown.
4. Coordinator selects one identity. If a human description matches several agents,
   ask which one; do not select by display order.
5. The subsequent mutation refreshes identity and authority independently.

**Exit:** Selection confers no management rights. A stale cached identity produces
an unavailable/mismatch response, never a new agent launch.

### F02. Provision an Independent Agent

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

1. Validate the canonical folder exists, requested persona is available, and the
   host supports the placement. Require an explicit management choice.
2. Save `Provisioning(preparing)` and creation intent before external effects.
3. Create the requested container and record its identity. The folder remains an
   existing resource, never a newly owned directory.
4. Save launch intent, set `launching`, then start OpenCode without an implicit
   assignment or a coordinator-owned delegate bootstrap role.
5. Verify the new conversation, terminal and expected directory.
6. Atomically record `Agent`, resource references and `Provisioning(ready)` with no
   active `Management`. End temporary provisioning responsibility.
7. Return/notify the agent identity. The user can work with the agent directly.

**Exit:** No `Request`, result expectation or handback requirement exists.

**Failure:** Before launch, rollback only resources proven created and unused.
After an uncertain launch, preserve resources and mark `uncertain`. A retry reads
the existing operation and reconciles it. It must not start a second agent.

**Existing workspace:** If the host returns an already-open workspace, do not
assume it is exclusively available. Refuse or require an explicit revised placement
that cannot replace or close existing sessions.

### F03. Provision a Managed Agent

```json
{
  "tool": "open_agent",
  "persona": "worker",
  "folder": "/work/project",
  "placement": "pane",
  "management": "managed",
  "isolation": {
    "kind": "worktree",
    "branch": "feature/request-lifecycle",
    "baseCommit": "<resolved-sha>"
  },
  "idempotencyKey": "request-lifecycle-worker"
}
```

1. Apply F02's identity, idempotency and launch checks.
2. For worktree isolation, validate repository, fresh branch and base revision.
   Persist the resolved commit rather than a moving branch name.
3. Record each created branch, worktree and container as a separate resource.
4. At verified readiness, create a `Management` record scoped to the resources and
   actions authorised by the provisioning policy.
5. Expose those permissions in inspection. Do not infer force-stop or discard rights.

**Existing-folder variant:** Use `isolation: existing_folder`. Management may cover
the created agent/container, but does not permit folder deletion.

**Exit:** The agent is ready and managed, but still has no task. Being managed does
not make it subordinate to a particular request's result lifecycle.

### F04. Provision Then Assign

```text
Coordinator -> open_agent(...)              -> provisioning receipt
Coordinator -> inspect_operation(id)        -> ready, agent identity
Coordinator -> request_agent(identity, ...) -> request receipt
Recipient   -> read_request(deliveryId)     -> task
Recipient   -> hand_back(...)               -> result receipt
```

The coordinator uses separate idempotency keys for provisioning and assignment.
If assignment fails, the ready agent remains available. Do not compensate by closing
it automatically. If the coordinator crashes between calls, recovery reports a
ready agent with no assignment, rather than inventing or resending a task.

Fan-out repeats this flow for separate agents/branches and tracks each receipt.
It is not an all-or-nothing transaction. A successful sibling is not destroyed
because another launch failed. Shared external resources still need coordination.

## 4. Request Execution

### F05. Task Delivery and Acceptance

```json
{
  "tool": "request_agent",
  "identity": "agent-1",
  "kind": "task",
  "text": "Review the authentication changes. Return findings without editing.",
  "executionPolicy": "advisory",
  "idempotencyKey": "authentication-review"
}
```

1. Authenticate the origin and resolve one exact supported recipient.
2. Validate nonblank content and the task policy. Do not acquire resource authority.
3. Atomically allocate `Request(generation=1, outcome=pending)`, a queue sequence
   and `Delivery(queued)` pinned to the recipient binding.
4. Return the queued receipt immediately. The queue worker owns subsequent delivery.
5. When the request reaches the head and the recipient is idle, preserve its current
   persona/model/variant. Revalidate the binding immediately before dispatch.
6. Persist message ID and attempt time before submitting a prompt containing the
   exact request, delivery and generation references.
7. Read back the message to confirm submission. Do not mark accepted yet.
8. Recipient calls `read_request` for that delivery. Authenticate the conversation
   and validate the current generation, binding and submission evidence.
9. Atomically record acceptance before returning the task. Identical reads are safe.

```json
{
  "tool": "read_request",
  "requestId": "req-1",
  "deliveryId": "delivery-1",
  "generation": 1
}
```

**Exit:** Delivery is `accepted`; task outcome remains `pending`; the queue slot is
held. Neither the coordinator becoming idle nor the recipient finishing a turn
constitutes handback.

### F06. Instruction Without Handback

```json
{
  "tool": "request_agent",
  "identity": "agent-1",
  "kind": "instruction",
  "text": "Use the existing test helpers for subsequent work.",
  "idempotencyKey": "use-test-helpers"
}
```

1. Follow F05's queue, identity and submission process with no task generation.
2. Recipient calls `read_request` using the instruction's delivery ID.
3. Atomically record acceptance and release the instruction's queue slot.
4. Return the content with `kind: instruction` and `handbackExpected: false`.
5. Expose a delivery receipt in inspection/UI. Do not create a `TaskResult` or queue
   a completion prompt back to the coordinator.

**Exit:** The instruction is delivered and accepted. Whether the recipient follows
it is not verified by this contract. It may affect subsequent work in that conversation
but does not automatically change persistent agent configuration or other sessions.

**Errors:** `hand_back` and task-specific questions/resume reject instruction IDs.
Instruction text asking for a result does not silently convert its contract to a
task. Use a task when a reply matters. Delivery failures remain visible without
requiring a successful-result handback.

### F07. Multiple Origins and Queue Ordering

Proposed strict order for one recipient:

| Queue position | Request | Release condition |
| --- | --- | --- |
| 10 | Coordinator A task | Result, pause or cancellation |
| 11 | Coordinator B instruction | Acceptance |
| 12 | Coordinator A task | Result, pause or cancellation |

The queue worker claims and checks the head transactionally. Two plugin processes
must not dispatch the same request or independent queue heads concurrently.

An idle observation does not release position 10. Position 11 cannot steer the
active task under this proposal; it applies once eligible. After accepting position
11, position 12 still waits for recipient idle. Urgent intervention is not a queued
instruction and remains out of scope.

User submissions can race the final idle check. If the host cannot reserve an idle
turn atomically, document that limitation and preserve the request's receipt state.
Do not abort user work to make the queue look deterministic.

### F08. Clarification and Reply

```json
{
  "tool": "ask_request",
  "requestId": "req-1",
  "generation": 1,
  "text": "Should the review include the token refresh endpoint?",
  "idempotencyKey": "review-scope-question"
}
```

1. Authenticate the recipient and accepted, current, nonterminal task generation.
2. Persist `Question(open)` with its own ID and schedule a coordinator notification.
3. Keep the task pending and its queue slot held. Display the open question as a
   blocked-work projection, not as a new task outcome enum.
4. Origin replies with the exact question ID and generation.
5. Persist the answer and make it available through the authenticated recipient
   channel. A correlated reply may wake the waiting task; it is not an ordinary
   queued request placed behind that same task.
6. A repeated identical reply returns the saved answer; conflicting replies fail.

Recipient calls `read_question(questionId, requestId, generation)` to retrieve the
saved state and answer. Authenticate it against the question's recipient and task
generation. An open response means no answer yet. Waiting must use bounded polls
or a host subscription, not hold a tool transaction indefinitely. After restart,
request inspection exposes that generation's question IDs so the recipient can
retrieve an answer already saved. Retrieval is idempotent and does not depend on
a wake-up prompt succeeding. Any optional wake-up is only a correlated hint and
cannot apply a stale-generation answer to current work.

An expired/withdrawn question cannot consume a late answer. Expiry does not fail
or release the task. The recipient may ask another question, pause or report failure.
No arbitrary timeout is fixed here. A human decision requiring action authority
must use the approval host; a clarification answer is not an action grant.

### F09. Result Publication and Validation

```json
{
  "tool": "hand_back",
  "requestId": "req-1",
  "generation": 1,
  "outcome": "completed",
  "summary": "Reviewed authentication changes. Two findings require attention.",
  "evidence": ["src/auth.ts:42", "src/tokens.ts:87"],
  "checks": [],
  "risks": [],
  "followUps": ["Address the reported findings."]
}
```

1. Authenticate the recipient and verify task, delivery and current generation.
2. Compare-and-swap one `TaskResult` into this generation. Atomically update the
   request outcome, release the queue slot and schedule the result notification.
3. If validation is required, expose `pending` validation rather than verified success.
4. Validate the requested Git/evidence policy separately and persist accepted or
   rejected status and reasons. Validation does not automatically execute commands
   without an applicable execution policy/permission.
5. Report claimed outcome and validation status distinctly. Preserve evidence provenance.

The queue releases on handback, not on coordinator acknowledgement or validation.
Therefore, later work can alter the same checkout before validation. Validate against
the recorded commit where possible; label live-worktree observations with their time.
Do not claim a clean checkout observed later proves it was clean at handback.

`outcome: failed` follows the same authenticated publication flow and can include
partial results. A rejected completion remains a reported completion with rejected
validation, not a silent rewrite to failure. Correction uses a new follow-up request.

Open questions for that generation are withdrawn in the publication transaction.
Identical result retries return the original receipt. Conflicting or stale-generation
results are rejected and cannot overwrite a later generation.

**Exit:** The agent remains running and its resource relationship is unchanged.
Git commit, merge, push and discard remain separate actions, not automatic follow-ons.

### F10. Pause and Resume

1. Recipient hands back `outcome: paused` with summary, evidence and remaining work.
2. Publish a paused result, release the queue slot and preserve the agent/resources.
3. An explicit continuation calls `resume_request` with the expected generation.
4. Validate originating authority, paused status and the same recipient binding.
5. Atomically advance generation, clear the current result pointer, set outcome to
   pending and allocate a new queue sequence and delivery.
6. Preserve prior results and delivery records. Deliver through F05 when eligible.

```json
{
  "tool": "resume_request",
  "requestId": "req-1",
  "expectedGeneration": 1,
  "instructions": "Continue with the token refresh endpoint included.",
  "idempotencyKey": "resume-authentication-review"
}
```

Continuation instructions require immutable generation-specific storage, identified
as a data-model gap in section 9. Do not overwrite the original brief or rely on
unpersisted prompt text. Until represented, the `instructions` variant is not
implementation-ready.

Resume does not recreate an unavailable agent, change its identity or jump ahead
of intervening requests. Old deliveries/results/replies cannot act on the new
generation. Completed/failed tasks get new requests, not resume. Cancelled paused
work also gets a new request under this proposal; cancellation is not silently cleared.

### F11. Cancellation

```json
{
  "tool": "cancel_request",
  "requestId": "req-1",
  "reason": "This review is no longer needed."
}
```

Only the originating authority may cancel its request by default. Recipient-side
queue administration needs a separate policy and is not implied by discovery.

| Point of cancellation | Persisted effect | What the user sees |
| --- | --- | --- |
| Queued, no attempt | Delivery cancelled; queue released | Cancelled before submission |
| Attempt saved or submitted | Cancellation flag; preserve delivery evidence | Retired; execution may continue |
| Accepted task | Cancellation flag; queue released | Not interrupted; late result possible |
| Accepted instruction | No remaining delivery obligation | Already accepted; cannot retract |
| Terminal task | No new execution effect | Already handed back |

Cancellation and submission compete under the same serialisation boundary. If
submission intent wins, return `mayContinue: true`, even when a receipt is missing.
Identical cancellation retries are safe. A late accepted delivery or result may be
recorded but cannot reopen the slot or erase cancellation. Never submit an implicit
stop instruction as a substitute for cancellation.

### F12. Uncertain Delivery

1. Save intent and attempt submission.
2. Transport response/read-back is inconclusive: mark delivery `unknown` and hold
   the slot. Expose message ID and reason only to authorised inspection surfaces.
3. Reconcile against the exact conversation and message identity.
4. If the message exists, restore confirmed submitted state and await acceptance.
5. If recipient acceptance is authenticated, record it even if the original caller
   never received a submission response.
6. If absence cannot be proven, retain unknown status. Permit cancellation, not blind
   replay. A replacement request requires an explicit duplicate-execution warning.

An intent written just before a crash might never have been sent. This is still
uncertain without a host guarantee proving non-delivery. Elapsed time is not proof.

If the host supplies authoritative proof that no submission occurred and no delayed
submission can still land, expose `retryable_non_delivery`. An explicit retry may
return the same delivery to queued after cancellation and binding checks. Preserve
the earlier attempt and proof, allocate a new message identity on dispatch, and
retain the original queue sequence. This is a proposed transition/history addition
to the data model, not permission to treat an empty message search as proof.

### F13. Availability and Binding Changes

| Observation | Behaviour |
| --- | --- |
| Recipient busy | Wait; preserve queue order |
| Idle but accepted task outstanding | Continue holding task slot |
| Inventory temporarily unavailable | Mark observation unknown/unavailable; do not close or relaunch |
| Same conversation restored with same verified binding | Continue reconciliation |
| New conversation in old pane | New agent identity; old requests remain pinned |
| Same conversation but changed terminal/folder | Block pinned deliveries until an explicit rebind policy exists |
| Confirmed process exit | Agent exited; expose interrupted/undeliverable work |

Interrupted and undeliverable are diagnostic projections in the present model,
not invented `Request.outcome` values. Do not fabricate a recipient-authored result.
No automatic reassignment is proposed. Create a new request explicitly if another
agent should continue, preserving the old record and warning about partial effects.

## 5. Closure and Resource Authority

### F14. Owner-Directed Independent Closure

Human intent: "Close the agent in the customer-demo workspace. Keep the files."

1. Discover and resolve the exact agent; ask if ambiguous.
2. Prepare a close-only operation with a stable operation ID and effects preview.
   No external shutdown occurs during preparation.
3. Approval host establishes the requester is the owner and issues a grant bound
   to that operation, exact agent binding and affected resource actions.
4. Coordinator submits/retries `close_agent` using that grant and the same operation.
5. Revalidate identity, grant scope/expiry/revocation, affected containers and live activity.
6. Atomically bind/consume the grant for this operation and persist execution intent.
7. Perform the narrowest supported graceful shutdown.
8. Verify the conversation is no longer live. Record completed resource steps and
   `CloseOperation(closed)` only when all requested effects are confirmed.

Before step 6, acquire an agent-scoped dispatch exclusion in the same serialisation
domain used to persist request submission intent. If dispatch intent already won,
reconcile that delivery before starting shutdown. If closure wins, no queue worker
may submit another request until closure releases the exclusion. This prevents
plugin-originated dispatch racing shutdown; it does not solve concurrent human input.

An unauthorised prepared operation does not block the recipient's queue. A busy or
preflight refusal before shutdown intent releases any temporary exclusion. Once
shutdown has been attempted, retain exclusion through uncertainty or partial failure
until reconciliation proves the agent either exited or is safe to resume dispatch.
Confirmed exit leaves requests undeliverable, not cancelled. Stale lock expiry alone
must not restart dispatch while an external shutdown may still be in flight.

```json
{
  "tool": "close_agent",
  "identity": "agent-2",
  "operationId": "close-1",
  "authorisationId": "<host-issued-grant>",
  "cleanup": "none",
  "idempotencyKey": "close-customer-demo-agent"
}
```

Preparation/approval API details are unresolved, but reserving the operation before
grant issuance avoids circular grant scope. A request without a grant may return a
blocked prepared operation and approval challenge; it must not close anything.

**Exit:** Folder, branch and worktree are preserved. No `Management` record is
created. Unknown ownership or an unsupported trusted approval path blocks closure.
A quoted instruction is audit context, not proof of owner authority.

### F15. Managed Closure and Optional Cleanup

Apply F14's dispatch exclusion and reconciliation rules to managed closure too.

1. Resolve the managed agent and verify the caller's standing permissions.
2. Prepare exact per-resource steps. Default to close-only.
3. For requested cleanup, inspect worktree dirtiness, branch status and shared use
   before shutting down the agent. Report the whole effect set.
4. Validate each step against its own management permission or owner grant.
5. Persist intent, close the agent, verify shutdown and execute authorised cleanup.
6. Record each step independently. Close the overall operation only when all requested
   steps have completed; preserve metadata after partial failure.

Safe worktree removal and safe branch deletion are distinct steps. Dirty data or
unmerged branches cause refusal, not automatic force. Existing folders are never
implicitly removed. A clean branch/worktree is not proof nobody else uses it.

No automatic merge is included. A completed task does not authorise branch deletion.
A paused task does not force preservation of the process if the owner separately
authorises closure, but its unfinished status must remain visible.

### F16. Busy, Shared, Dirty or Partially Closed Targets

| Condition | Required response |
| --- | --- |
| Agent busy | Block by default and offer wait or explicit force-stop approval |
| Graceful shutdown timed out | Reconcile; do not silently escalate to force |
| Workspace contains unrelated agents | Narrow the action or block for full affected-set approval |
| Dirty worktree with cleanup requested | Block cleanup before shutdown; offer an explicit close-only revision |
| Branch cannot be safely deleted | Preserve branch and failed-step record |
| Pane binding changed | Refuse; never act on the replacement conversation |
| Shutdown response lost | Mark uncertain and read back exact external state |
| Process closed, cleanup failed | Report process closed and cleanup incomplete, not total success |
| Grant expired/revoked before a step starts | Stop before that step and require valid authority |

An explicit supplemental approval may amend a blocked operation with `force_stop`
or resource-specific discard. Persist the changed effect set and authority before
acting. An ordinary retry cannot change scope. Destructive discard remains a distinct
step and needs resource ownership checks, including any shared-owner policy.

Revocation cannot undo a side effect already submitted. Recovery may reconcile that
effect, but must not initiate a new step under revoked authority. A consumed grant
is usable only for its original operation, not indefinitely for unrelated retries.

The current grant schema targets one agent. Approval covering multiple agents in a
shared workspace is not yet modelled. Until resolved, refuse broad workspace closure
and use separately authorised narrow operations where supported.

After confirmed shutdown, mark the agent exited and surface outstanding work. Do
not claim requests were cancelled or completed merely because their process stopped.

### F17. Release Management Without Shutdown

1. Current manager explicitly requests release of the exact managed relationship.
2. Check for active provisioning/cleanup operations relying on that relationship.
3. Refuse while such an operation is executing or uncertain. Do not revoke its
   authority midway by accidentally changing a pointer.
4. Atomically mark management released and clear the agent's active management pointer.
5. Record an audit event and return the still-live, now-independent agent identity.

Existing requests remain owned by their originators and can finish normally. Their
presence does not confer residual cleanup rights. All created resources remain in
place; the confirmed human owner remains unchanged.

Release is irreversible through this call. Adopting or transferring management is a
separate owner-approved flow not yet specified by the data model. Do not interpret
`request_agent` as adoption or a way to recover released permissions.

## 6. Reporting, Recovery and Retention

### F18. Notifications and Inspection

1. Persist a relevant domain transition and its notification record atomically.
2. Deliver through the origin conversation's supported background channel.
3. If the origin is busy, defer. If submission is uncertain, reconcile by stable
   message identity before a retry according to the host's deduplication guarantees.
4. Mark delivered only after message read-back. Preserve superseded status separately.
5. Inspection remains available even when the notification target is unavailable.

| Event | Proposed reporting |
| --- | --- |
| Agent ready | Provisioning receipt/status and readiness notification |
| Instruction accepted | UI/inspection receipt, no result prompt |
| Delivery blocked/unknown | Visible queue diagnostic and deduplicated origin alert |
| Question opened | Correlated origin notification |
| Task handback | Outcome plus explicit validation status |
| Validation completed/rejected | Updated inspection and distinct validation event |
| Close partially failed | Exact completed and outstanding steps |
| Target exited with work pending | Interrupted/undeliverable diagnostic |

Notification delivery is not a prerequisite for queue release. A lost coordinator
conversation does not transfer ownership to a new one. Any future routing recovery
must authenticate the owner explicitly.

Inspection separates delivery, task outcome, validation, agent activity and resource
authority. Redact secrets and restrict briefs/results to authorised principals.
Shared queue counts must not expose another principal's task text or approval data.

### F19. Crash and Concurrency Recovery

| Crash/race boundary | Recovery rule |
| --- | --- |
| Before persisted operation | Retry can create it |
| After provisioning intent, before known external result | Reconcile resources; no duplicate launch |
| Agent ready, caller response lost | Return the same ready agent |
| Independent readiness not durably recorded | Reconcile startup; do not infer permanent cleanup rights |
| Request saved, no dispatch | Resume queue processing |
| Attempt saved, no receipt | Unknown delivery; no blind resend |
| Acceptance saved, response lost | Idempotent read returns same delivery |
| Result saved, response lost | Same generation/result receipt returned |
| Pause versus resume retry | Expected generation and revision decide one transition |
| Two coordinators enqueue simultaneously | Transaction assigns distinct ordered sequences |
| Two recipient workers scan | One durable claim/serialised submission intent |
| Cancellation versus dispatch | Serialised intent determines `mayContinue` |
| Closure versus queue dispatch | Agent-scoped exclusion decides one intent; uncertain shutdown keeps dispatch blocked |
| Resume versus late completion | Generation check prevents overwrite |
| Shutdown versus binding reuse | Fresh binding check prevents closing replacement |
| Shutdown succeeded, metadata update lost | Verify absence of exact target and resume bookkeeping |
| Cleanup partially completed | Verify each step and retry only unfinished authorised steps |
| Notification sent, acknowledgement lost | Reconcile stable message identity |

Do not hold a database transaction open while waiting for OpenCode, Herdr or Git.
Persist intent, perform the effect, then reconcile under a fresh revision check.
Lease/claim implementation details must prevent duplicate workers without pretending
a lease expiry proves an external effect did not occur.

Recovery validates schema versions and caller/target bindings. Corrupt or unsupported
records are quarantined/read-only with an actionable diagnostic, not silently reset.
No recovery path automatically kills agents, merges commits or deletes uncertain data.

### F20. Archive and Legacy Sessions

1. Identify records with no active queue obligation, pending operation or unresolved
   external outcome. Accepted instructions are eligible once retention rules allow.
2. Check cross-record references and preserve required idempotency/authority history.
3. Archive under the authorised retention policy. Do not delete execution resources.
4. Remove sensitive bodies only under the chosen policy, retaining enough metadata
   to distinguish an old duplicate submission from new work.

No archive command, retention duration or import is approved by this specification.
The current schema needs archive/tombstone semantics before implementation.

Legacy Envoy jobs stay on their existing lifecycle until an explicit migration is
designed. Import cannot turn historical `commit`/`discard` text into trusted grants,
existing requests into managed agents, or unknown owner identity into a known owner.
Never let old and new queue workers claim the same imported request concurrently.

## 7. End-to-End Scenarios

### A. Independent Agent, Instruction, Owner Closure

```text
Owner asks for an agent in /work/customer-demo
Coordinator opens independent agent              [F02]
Plugin verifies readiness; creates no task
Coordinator queues setup instruction              [F06]
Recipient accepts; no handback is expected
Owner works directly with recipient
Owner later asks to close it
Plugin prepares exact effects; host approves      [F14]
Plugin closes agent and preserves folder
```

### B. Managed Implementation With Review and Reuse

```text
Coordinator provisions isolated managed worker    [F03]
Coordinator submits code-change task              [F04-F05]
Recipient asks a scope question; origin replies   [F08]
Recipient completes with commit/check evidence    [F09]
Coordinator reviews reported and validated facts
Coordinator sends follow-up task to same agent    [F05]
Recipient completes; agent remains running
Coordinator explicitly closes and cleans up       [F15]
```

Neither completion automatically merges or deletes the branch. Any commit/merge/push
authority comes from the assignment and applicable execution permissions, not from
the result status itself.

### C. Paused Work While Another Request Runs

```text
Task A accepted
Recipient hands back paused                      [F10]
Task B becomes eligible and is accepted           [F07]
Coordinator resumes A at generation 2
A receives a new queue position behind B
Late generation-1 result cannot complete A
B hands back; A generation 2 becomes eligible
```

### D. Unknown Instruction Delivery and Cancellation

```text
Instruction queued
Submission intent saved; connection fails         [F12]
Receipt cannot be established; queue shows unknown
Origin cancels after seeing duplicate-work risk   [F11]
Queue obligation released; mayContinue is true
Recipient later accepts original instruction
Late receipt is retained; no result is expected
```

## 8. Flow Acceptance Tests

These are proposed tests, not tests executed by this documentation change.

| Test | Required assertion |
| --- | --- |
| Repeated independent launch | Same agent, no task or management record |
| Managed existing-folder launch | Container permissions never imply folder deletion |
| Task versus instruction | Only task requires/accepts handback |
| Accepted instruction | Slot released atomically; next dispatch still checks idle |
| Multi-origin FIFO | Delivered active task blocks later instructions |
| Unknown dispatch | No automatic duplicate prompt |
| Exact acceptance | Wrong conversation/delivery/generation refused |
| Duplicate handback | Identical receipt returned; conflicting result refused |
| Validation rejection | Distinct from claimed completion and not hidden by UI |
| Pause/resume | Fresh sequence/generation; immutable old history |
| Stale question reply | Cannot answer a different question/generation |
| Cancel before/after intent | Correct distinction between prevented and may continue |
| Late cancelled result | Recorded without reopening queue or clearing cancellation |
| Independent owner close | Trusted grant permits close, not resource deletion |
| Fabricated approval | Instruction quote cannot authorise shutdown |
| Busy or shared close | No force or collateral shutdown without exact authority |
| Dirty cleanup | Preflight refusal; no premature pane closure |
| Partial close recovery | No repeated completed effect or expanded permissions |
| Management release | Agent remains live; requests retain origin; rights are removed |
| Coordinator restart | Tracking restored without ownership transfer or relaunch |
| Notification loss | Outcome preserved independently of origin receipt |
| Unsupported schema | No destructive guesses or reset |
| Legacy coexistence | A request is never delivered by two independent queue systems |

## 9. Open Decisions and Model Gaps

The flows expose the following decisions. They are not silently added to the
companion data model and must be resolved before implementation.

| Topic | Required decision or schema addition |
| --- | --- |
| Trusted owner and grants | Select host identity/approval mechanism; closure remains blocked without it |
| Generation-specific briefs | Persist immutable continuation instructions and payload identity per generation/delivery |
| Proven non-delivery retry | Add explicit unknown-to-queued retry with authoritative proof and retained attempt history |
| Shutdown exclusion | Persist agent-scoped dispatch exclusion tied to a close operation and recovery checks |
| Close preparation | Define operation reservation, effect preview and grant issuance/retry interface |
| Multi-agent container closure | Model affected-agent set and corresponding grants, or refuse broad closure |
| Instruction scheduling | Confirm strict FIFO, no active-task bypass and delivery-only feedback |
| Pause authority | Define who may request/approve pause and resume; result text is not proof of consent |
| New management authority | Define trusted provisioning permission and scope of standing management |
| Management release/adoption | Confirm release flow; owner-approved adoption/transfer is not defined |
| Recipient loss | Define optional administrative outcome without fabricating a recipient-authored result |
| Binding changes | Define explicit rebind behaviour, or continue requiring new requests |
| Validation timing | Define snapshot/live checks and whether any policy needs queue retention until validation |
| Approval expiry/revocation | Specify per-step validity and recovery rules in the grant contract |
| Idle reservation | Verify host capability; preserve documented race if no atomic reservation exists |
| Graceful close | Verify process-only shutdown versus terminal/workspace side effects |
| Dispatch authentication | Verify how recipient tools prove caller and submission identity |
| Idempotency retention | Define key scope, request hash, expiry and tombstones |
| Archive/access control | Define retention, brief redaction and principal-scoped inspection |
| Legacy transition | Choose separate coexistence or explicit import with exclusive queue ownership |

Out of scope until separately specified: automatic merging, remote mutations,
urgent interruption/steering, recurring instructions, arbitrary request editing,
automatic reassignment and an agent granting itself human approval.
