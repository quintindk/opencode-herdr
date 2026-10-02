/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { requestPresentation, type QueueProjection, type Request } from "./sidebar.js";

export type { Request, QueueProjection } from "./sidebar.js";

export interface MailboxStore {
  list(sessionID: string): QueueProjection;
  history(id: string, sessionID: string): unknown;
}

export function Mailbox(props: { api: TuiPluginApi; sessionID: string; store: MailboxStore }) {
  const [expanded, setExpanded] = createSignal(false);
  const [projection, setProjection] = createSignal<QueueProjection>();
  const [unavailable, setUnavailable] = createSignal(false);
  const theme = () => props.api.theme.current;
  const { DialogAlert, DialogSelect } = props.api.ui;

  createEffect(() => {
    const sessionID = props.sessionID;
    const store = props.store;
    setProjection(undefined);
    setUnavailable(false);
    setExpanded(false);
    const poll = () => {
      try {
        const next = store.list(sessionID);
        const latest = (requests: Request[]) => [...requests].sort((a, b) => b.updatedAt - a.updatedAt || b.sequence - a.sequence);
        setProjection({ inbox: latest(next.inbox), outbox: latest(next.outbox) });
        setUnavailable(false);
      } catch {
        setUnavailable(true);
      }
    };
    // SQLite reads are synchronous, so interval callbacks cannot overlap.
    untrack(poll);
    const timer = setInterval(poll, 2_000);
    onCleanup(() => clearInterval(timer));
  });

  const details = (request: Request, sessionID: string) => {
    if (props.sessionID !== sessionID) return;
    let message: string;
    try {
      const history = props.store.history(request.id, sessionID);
      if (history === undefined || history === null) throw new Error("History unavailable");
      message = [
        `${request.kind === "task" ? "Task" : "Instruction"}: ${requestPresentation(request).label}`,
        request.mayContinue ? "Cancellation does not interrupt execution. Work may continue." : undefined,
        request.summary ? `Summary: ${request.summary}` : undefined,
        JSON.stringify(history, null, 2),
      ].filter(Boolean).join("\n\n");
    } catch {
      message = "Request details unavailable. Access may have changed. Try again later.";
    }
    props.api.ui.dialog.replace(() => <DialogAlert title="Request details" message={message} />);
  };

  const browse = (title: string, requests: Request[]) => {
    const sessionID = props.sessionID;
    props.api.ui.dialog.replace(() => <DialogSelect
      title={title}
      options={requests.map((request) => ({
        title: `${request.kind === "task" ? "Task" : "Instruction"} ${request.id}`,
        value: request,
        description: requestPresentation(request).label,
        footer: <text fg={theme()[requestPresentation(request).colour]}>{requestPresentation(request).label}</text>,
      }))}
      onSelect={(option) => details(option.value, sessionID)}
    />);
  };

  return <box flexDirection="column">
    <text fg={theme().text} onMouseUp={() => setExpanded((value) => !value)}>
      <b>{expanded() ? "\u25be" : "\u25b8"} Coordination</b>
    </text>
    <Show when={unavailable()}>
      <text fg={theme().warning}>Coordination unavailable. {projection() ? "Showing last known data." : "Try again later."}</text>
    </Show>
    <Show when={expanded()}>
      <For each={["inbox", "outbox"] as const}>{(group) => {
        const [open, setOpen] = createSignal(false);
        const title = group === "inbox" ? "Inbox" : "Outbox";
        const requests = () => projection()?.[group];
        return <box flexDirection="column">
          <text fg={theme().text} onMouseUp={() => setOpen((value) => !value)}>
            <b>{open() ? "\u25be" : "\u25b8"} {title} ({requests()?.length ?? "?"})</b>
          </text>
          <Show when={open()}>
            <Show when={requests()?.length === 0}><text fg={theme().textMuted}>No requests.</text></Show>
            <For each={requests()?.slice(0, 5)}>{(request) => <text
              fg={theme()[requestPresentation(request).colour]}
              onMouseUp={() => details(request, props.sessionID)}
            >{request.kind === "task" ? "Task" : "Instruction"} {request.id}: {requestPresentation(request).label}</text>}</For>
            <Show when={(requests()?.length ?? 0) > 5}>
              <text fg={theme().primary} onMouseUp={() => browse(title, requests()!)}>Browse all ({requests()!.length})</text>
            </Show>
          </Show>
        </box>;
      }}</For>
    </Show>
  </box>;
}
