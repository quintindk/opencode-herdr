/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show, onCleanup } from "solid-js";
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { configPath, formatBinding, loadShortcuts, type Shortcuts } from "./shortcuts.js";
import { Store } from "./store.js";
import { Mailbox } from "./mailbox.jsx";
import { remoteOutbox } from "./remote.js";

function Coordination(props: { api: TuiPluginApi; sessionID: string }) {
  let store: Store;
  try { store = new Store(); }
  catch { return <text fg={props.api.theme.current.warning}>Coordination store unavailable</text>; }
  onCleanup(() => store.close());
  return <Mailbox api={props.api} sessionID={props.sessionID} store={{
    list: sessionID => { const local = store.list(sessionID); return { ...local, outbox: [...local.outbox, ...remoteOutbox(store, sessionID)] }; },
    history: (id, sessionID) => {
      const op = store.operations(sessionID).find(op => op.kind === "remote.request" && (op.result?.request as { id?: string } | undefined)?.id === id);
      return op ? { peerId: op.payload.peerId, state: op.state, request: op.result?.request, note: "Remote receipt. Use inspect_request with peerId for full live history." } : store.history(id, sessionID);
    },
  }} />;
}

function Sidebar(props: { api: TuiPluginApi; shortcuts?: Shortcuts }) {
  const [expanded, setExpanded] = createSignal(false);
  const theme = () => props.api.theme.current;
  return <box flexDirection="column">
    <text fg={theme().text} onMouseUp={() => setExpanded((value) => !value)}>
      <b>{expanded() ? "\u25be" : "\u25b8"} Herdr shortcuts</b>
    </text>
    <Show when={expanded()}>
      <Show when={props.shortcuts} fallback={<text fg={theme().warning}>Cannot read Herdr config. Check config.toml and restart OpenCode.</text>}>
        {(shortcuts) => <>
          <text fg={theme().textMuted}>Prefix: <b>{formatBinding(shortcuts().prefix)}</b></text>
          <For each={shortcuts().groups}>{(group) => {
            const [open, setOpen] = createSignal(false);
            return <box flexDirection="column">
              <text fg={theme().text} onMouseUp={() => setOpen((value) => !value)}>
                <b>{open() ? "\u25be" : "\u25b8"} {group.title}</b>
              </text>
              <Show when={open()}>
                <For each={group.shortcuts}>{(shortcut) => <text fg={theme().textMuted}>
                  <span style={{ fg: theme().primary }}>{formatBinding(shortcut.binding)}</span>{":\t"}{shortcut.label}
                </text>}</For>
              </Show>
            </box>;
          }}</For>
        </>}
      </Show>
    </Show>
  </box>;
}

export default {
  id: "opencode-herdr.shortcuts",
  tui: async (api, options) => {
    if (process.env.HERDR_ENV !== "1") return;
    if (options?.configPath !== undefined && (typeof options.configPath !== "string" || !options.configPath)) {
      throw new Error("opencode-herdr: configPath must be a non-empty string");
    }
    let shortcuts: Shortcuts | undefined;
    try {
      shortcuts = await loadShortcuts((options?.configPath as string | undefined) ?? configPath());
    } catch {
      // A broken/unreadable config must not present defaults as the user's keys.
    }
    api.slots.register({ order: 600, slots: {
      sidebar_content: (_ctx, value) => <box flexDirection="column" gap={1}>
        <Show when={options?.coordination !== false}><Coordination api={api} sessionID={value.session_id} /></Show>
        <Sidebar api={api} shortcuts={shortcuts} />
      </box>,
    } });
  },
} satisfies TuiPluginModule;
