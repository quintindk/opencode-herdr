# opencode-herdr

An OpenCode plugin integrating Herdr's terminal workspace controls with OpenCode.
SQLite-backed agent coordination, coloured inbox/outbox views and Herdr shortcut hints.
The replacement implementation is available for validation. Envoy is not automatically
uninstalled and its records are not imported.

## Current behaviour

- Shows common pane, workspace, tab, navigation, and Herdr controls.
- Includes custom `[[keys.command]]` entries, using their descriptions where available.
- Reads configured bindings and the prefix from Herdr's `config.toml`. Empty bindings hide the corresponding action.
- Uses Herdr 0.9.1 defaults for omitted bindings or a missing config file. An invalid or unreadable file displays a warning instead.
- Only appears when OpenCode runs inside Herdr (`HERDR_ENV=1`).
- Uses OpenCode's theme and existing session sidebar. All sections start collapsed. Click headings to expand or collapse them.
- Displays keyboard hints only. Herdr handles the keys. Clicking a shortcut does not execute it.
- Separate tasks with handback and instructions with acceptance-only receipts.
- Durable FIFO delivery, immutable generation results, pause/resume, correlated questions,
  cancellation, notification outbox and redacted audit events.
- Local pane/workspace/worktree provisioning without automatic permission approval.
- Explicitly configured SSH peers, pinned machine identities and idempotent remote delivery.
- Coloured Coordination inbox/outbox in OpenCode and display-only queue tokens in Herdr.

## Local Installation

Developed against OpenCode 1.18.27 and Herdr 0.9.1. Server and TUI entries are separate.
Read [Cutover and Limitations](docs/cutover.md) before enabling the server entry.

```sh
npm ci
npm run build
```

Add the built entry to the `plugin` array in your OpenCode `tui.json`, preserving existing entries:

Register the sidebar globally in `~/.config/opencode/tui.json` so it is available
across projects. The project-local `tui.json` only declares the schema:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-herdr/dist/tui.jsx"]
}
```

Quit and restart OpenCode after installation, rebuilding, or changing Herdr bindings.
Open a session with its sidebar visible. The section is not shown on the home screen.
Keep Herdr's existing OpenCode session-reporting integration installed. This plugin does not replace it.

After retiring the Envoy server loader, add `file:///absolute/path/to/opencode-herdr/dist/index.js`
to the `plugin` array in `opencode.json`. Keep other plugins. The project does not
auto-enable this server entry because the installed Envoy tools have conflicting names.
The server refuses to start its workers when its resolved plugin list contains Envoy.

The structured logging module is implemented and tested, but full worker/tool
instrumentation is still outstanding. See [Cutover and Limitations](docs/cutover.md)
for the other unfinished features before relying on this as a complete replacement.

See [Remote Delivery](docs/remote-delivery.md) for explicit peer configuration and
[Herdr Sidebar](docs/herdr-sidebar.md) for colour rules. All coordination headings
start collapsed. Blue indicates queued/submitted, the theme accent indicates accepted,
yellow indicates paused/unknown/review needed, green indicates completion and red failure.

Config resolution is `HERDR_CONFIG_PATH`, then `$XDG_CONFIG_HOME/herdr/config.toml`,
then `~/.config/herdr/config.toml`. Override the path through the TUI plugin options:

```json
{
  "plugin": [
    ["file:///absolute/path/to/opencode-herdr/dist/tui.jsx", { "configPath": "/absolute/path/to/config.toml" }]
  ]
}
```

The file is read once on plugin load. This is not a query of the running Herdr client's effective keymap.
Reload Herdr's configuration after editing it. When attaching remotely with client-local bindings,
the server-side file may differ. Point `configPath` at an accessible copy of the client's config.
Legacy key aliases/indexed configuration and duplicate-binding conflict resolution are not interpreted.
Use Herdr's **All shortcuts** help for the complete active keymap.

## Development

```sh
npm test
npm run typecheck
# Requires the installed OpenCode CLI, not a standalone Bun executable:
npm run test:sqlite-host
npm run test:server-host
# Requires Bun:
npm run test:coordination
# Requires Bun for the actual OpenTUI renderer:
npm run test:tui
```

TypeScript preserves JSX for OpenCode's TUI loader. Solid and OpenTUI are shared with the host,
not bundled into the plugin. The package is private until npm package loading is separately verified.

The production dependency audit is clean. The pinned OpenTUI development toolchain currently
pulls in a low-severity Babel advisory, reported across three packages by `npm audit`.
Do not use `npm audit fix --force`: its proposed downgrade removes the TUI API this plugin needs.

The coordination store uses `bun:sqlite`. See
[SQLite Driver Validation](docs/sqlite-validation.md) for host compatibility and
multi-process/crash-recovery evidence. State is stored at
`~/.config/opencode/opencode-herdr/coordination.sqlite`, or under `XDG_CONFIG_HOME`
when explicitly set. Do not sync the database with dotfiles.

## References

- OpenCode TUI schema: <https://opencode.ai/tui.json>
- Sidebar API: `@opencode-ai/plugin@1.18.27`, `TuiPluginModule` and `sidebar_content` in `dist/tui.d.ts`.
- Herdr bindings: `herdr --default-config` from Herdr 0.9.1.
