# SQLite Driver Validation

Date: 2026-10-02

Decision: use `bun:sqlite` for the OpenCode server plugin's transactional storage
layer. No native npm SQLite dependency or separate database service is needed on
the validated host. The production storage layer is not implemented yet.

## Environment

| Component | Validated version |
| --- | --- |
| Platform | Linux ARM64 |
| OpenCode | 1.18.27 |
| Embedded Bun, reported from inside the plugin | 1.3.14 |
| SQLite, queried through that plugin | 3.53.0 |

## Reproduction

```sh
npm run test:sqlite-host
```

Requires `opencode` on PATH and an existing `/tmp/opencode` directory. The Node
harness launches real `opencode debug config` processes with isolated HOME/XDG
directories and a test-only plugin. Each plugin imports `bun:sqlite` directly.
It does not use standalone Bun as a substitute for the plugin runtime.

All probes share one temporary database. The harness removes its temporary
directories and terminates its own processes afterwards. It does not install a
global plugin, contact a model, migrate Envoy records or create the production
coordination database.

## Checks

- Plugin import and execution inside OpenCode's server plugin loader.
- WAL mode, foreign-key enforcement and `synchronous=FULL` read back successfully.
- Prepared statements and `transaction(...).immediate()` execute successfully.
- A thrown exception rolls back both result and outbox inserts.
- Four separate OpenCode processes wait at a barrier and then compete for one
  conditional queue claim. Exactly one claims it.
- A separate reader sees only committed data while a writer holds an open
  transaction with uncommitted result and outbox inserts.
- SIGKILL of that writer does not commit either insert or strand its database lock.
- A fresh host process commits result and outbox together after crash recovery.
- Another fresh host process reads both committed records and passes
  `integrity_check` and `foreign_key_check`.

These are driver acceptance probes, not the complete workflow test suite.
They do not simulate power loss, disk-full errors, long-running contention,
migration races, TUI responsiveness, or remote delivery. Windows, macOS and other
OpenCode versions remain unvalidated. Future storage tests must cover those
failure modes and the actual domain constraints.
