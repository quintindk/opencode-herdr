# Herdr Sidebar

The server plugin publishes display-only metadata through `herdr pane report-metadata`
under source `opencode-herdr`, scoped to Herdr's `herdr:opencode` integration.
It never changes the reported agent lifecycle state. Reports expire after 30 seconds
and unchanged reports refresh after 10 seconds.

| Token | Meaning |
| --- | --- |
| `$herdr_inbox` | Highest-priority inbox state and total retained request count |
| `$herdr_outbox` | Highest-priority outbox state and total retained request count |
| `$herdr_wait` | Count of outgoing accepted tasks awaiting handback |

Counts include retained history. `blocked` includes unknown delivery, paused work,
failed tasks and completions needing review. Tokens contain no task briefs or secrets.

Add these cells as rows to your existing `[ui.sidebar.agents].rows` in Herdr's
`config.toml`. Preserve existing rows and other plugins' tokens. This example is
a complete rows value for a fresh installation, not a replacement for customised rows:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$herdr_inbox", rules = [
    { starts_with = "blocked", fg = "#e5c07b", bold = true },
    { starts_with = "active", fg = "#c678dd" },
    { starts_with = "queued", fg = "#61afef" },
    { starts_with = "done", fg = "#98c379" },
    { starts_with = "idle", fg = "#5c6370" }
  ] }],
  [{ token = "$herdr_outbox", rules = [
    { starts_with = "blocked", fg = "#e5c07b", bold = true },
    { starts_with = "active", fg = "#c678dd" },
    { starts_with = "queued", fg = "#61afef" },
    { starts_with = "done", fg = "#98c379" },
    { starts_with = "idle", fg = "#5c6370" }
  ] }]
]
```

Validate with `herdr config check`, then apply using `herdr server reload-config`.
Retain the official Herdr OpenCode session-reporting integration. Old Envoy metadata
expires naturally after its workers stop. Do not run both queue implementations.
