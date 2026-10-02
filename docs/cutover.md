# Cutover and Limitations

## Status

Implemented: local SQLite coordination, task/instruction queues, delivery receipts,
immutable results, pause/resume, questions/replies, notification outbox, audit history,
SSH store RPCs, local provisioning and coloured OpenCode/Herdr projections.

Not yet a complete replacement for every Envoy operation:

- Owner-directed closure is disabled. `ctx.ask()` can auto-allow under an existing
  permission policy and does not prove ownership. A trusted, scoped approval path
  is required before enabling it. Use Herdr's user interface for closure.
- Automatic Git validation, commits, merges, discards, branch deletion and worktree
  cleanup are not implemented. Code-change results remain visibly `pending` review.
- Archive/retention and legacy record import are not implemented. State is retained.
- New tools deliberately require request/generation/delivery IDs. Old Envoy tool
  calls are not silently translated into the new ownership and lifecycle model.
- Provisioning sends a fixed readiness prompt, not an assignment, to establish the
  selected persona/model. This may incur a model turn. It pre-creates and pins the
  exact session before launch. Launch uncertainty never causes automatic relaunch.
- Herdr idle checks and OpenCode prompt submission are not atomic. Concurrent human
  input can still race submission. Unconfirmed submission is never blindly retried.
- Remote endpoints require explicit SSH and token configuration. Remote creation,
  closure, resource cleanup and arbitrary command execution are not RPC methods.
- Linux ARM64/OpenCode 1.18.27 host loading is verified. Other platforms are untested.

## Safe Cutover

1. Stop assigning new work through Envoy. Inventory its pending, paused and uncertain
   jobs using the old tools. Complete or explicitly resolve them before retirement.
2. Preserve the old runtime/durable records and worktrees. This plugin never imports,
   deletes or assumes ownership of them.
3. Quit all participating OpenCode sessions. Disable Envoy's server plugin entry and
   auto-discovered loader, and its TUI entry. Preserve unrelated plugins and the
   official Herdr OpenCode session-reporting integration.
4. Build this repository. Register `dist/index.js` in OpenCode `opencode.json` and
   `dist/tui.jsx` in `tui.json`. Do this for every participating machine/account.
5. Merge the Herdr sidebar rows from `herdr-sidebar.md`, validate and reload config.
6. Restart OpenCode. Verify `/herdr`, `list_agents`, `list_requests`, and collapsed
   Coordination headings. Send a harmless instruction, then an advisory task between
   two test conversations. Verify acceptance, handback and both sidebar projections.
7. Configure and verify remote peers separately before sending remote work.

The repository does not change global config automatically. The current running
Envoy session must not be removed underneath its own tools. A restart is required.

## Tool Mapping

| Previous workflow | Replacement |
| --- | --- |
| Discover peers | `list_agents`, optionally `peerId` |
| Delegate/create peer | `open_agent`, inspect `list_operations`, then `request_agent` |
| Existing-agent request | `request_agent` with explicit kind and idempotency key |
| Read/handback | `read_task` with delivery ID, then `hand_back` for tasks |
| Pause/resume | Hand back `paused`, then `resume_request` with current generation |
| Ask/reply | `ask_coordinator`, `reply_question`, `inspect_request` |
| Cancel | `cancel_request`, with possible continued execution explicitly reported |
| Reap/discard/commit | Not automated. Requires separate authorised user action |

## Verification

Validated on 2026-10-02: 7 Node shortcut tests, 165 Bun coordination/renderer tests,
and an additional built-sidebar integration test with 50 assertions. The isolated
real OpenCode loader tests, SQLite multi-process/crash probes and Herdr example
configuration validation all passed. No live remote SSH peer or model-to-model
handoff was exercised. Global configuration and legacy Envoy data were unchanged.

`npm test` covers shortcut parsing. `npm run test:coordination` runs the Bun domain,
delivery, provisioning, remote and renderer tests. `npm run test:server-host` loads
the built server plugin in isolated real OpenCode processes and checks normal and
Envoy-conflict paths. `npm run test:sqlite-host` tests real-host multi-process claims
and abrupt process-death recovery. Provisioning and network effects in domain tests
are mocked, not evidence of a live cross-machine or agent-to-agent model run.
