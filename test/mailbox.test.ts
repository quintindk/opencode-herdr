import { expect, setSystemTime, spyOn, test } from "bun:test";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { testRender } from "@opentui/solid";
import { RGBA, TextRenderable, type BaseRenderable } from "@opentui/core";
import { createSignal, getOwner, runWithOwner } from "solid-js";
import { createSidebarPublisher, queueTokens, requestPresentation, type Request } from "../src/sidebar.js";

ensureRuntimePluginSupport();

const request = (overrides: Partial<Request> = {}): Request => ({
  id: "request-1", originSessionId: "origin", originDirectory: "/private/project", recipientId: "recipient",
  kind: "task", text: "PRIVATE TASK BODY", generation: 1, sequence: 1, deliveryId: "delivery",
  state: "queued", createdAt: 1, updatedAt: 1, summary: "PRIVATE SUMMARY", ...overrides,
});

test("request labels and theme keys distinguish receipts, results and validation", () => {
  const cases = [
    [request(), "Queued", "primary"],
    [request({ state: "submitted" }), "Submitted", "primary"],
    [request({ state: "unknown" }), "Delivery unknown", "warning"],
    [request({ state: "paused" }), "Paused", "warning"],
    [request({ state: "failed" }), "Failed", "error"],
    [request({ state: "cancelled" }), "Cancelled", "textMuted"],
    [request({ state: "accepted" }), "Awaiting result", "accent"],
    [request({ state: "accepted", kind: "instruction" }), "Acknowledged", "accent"],
    [request({ state: "completed" }), "Completed", "success"],
    [request({ state: "completed", validation: { status: "pending" } }), "Needs review", "warning"],
    [request({ state: "completed", validation: "rejected" }), "Validation rejected", "error"],
  ] as const;
  for (const [value, label, colour] of cases) expect(requestPresentation(value)).toMatchObject({ label, colour });
});

test("mailbox collapses sections, limits latest rows and opens authorised read-only details", async () => {
  const { Mailbox } = await import("../dist/mailbox.jsx");
  let selected: any;
  let alert: any;
  let owner: ReturnType<typeof getOwner>;
  const historyCalls: string[][] = [];
  let denied = false;
  const [primary, setPrimary] = createSignal("#00ffff");
  const inbox = Array.from({ length: 7 }, (_, index) => request({ id: `req-${index}`, sequence: index, updatedAt: index }));
  const outbox = [
    request({ id: "instruction", state: "accepted", kind: "instruction" }),
    request({ id: "task", state: "accepted" }),
    request({ id: "review", state: "completed", validation: { status: "pending" } }),
  ];
  const api = {
    theme: { current: { text: "white", textMuted: "gray", warning: "yellow", get primary() { return primary(); }, accent: "magenta", success: "green", error: "red" } },
    ui: {
      dialog: { replace(render: () => unknown) { runWithOwner(owner!, render); } },
      DialogSelect(props: any) { selected = { ...props }; return null; },
      DialogAlert(props: unknown) { alert = props; return null; },
    },
  };
  const store = {
    list(sessionID: string) { expect(sessionID).toBe("origin"); return { inbox, outbox }; },
    history(id: string, sessionID: string) {
      historyCalls.push([id, sessionID]);
      if (denied) throw new Error("PRIVATE DATABASE ERROR");
      return { events: ["authorised-history"], text: "authorised-body" };
    },
  };
  const view = await testRender(() => {
    owner = getOwner();
    return Mailbox({ api, sessionID: "origin", store });
  }, { width: 72, height: 35 });
  const click = async (label: string) => {
    const lines = view.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    await view.mockMouse.click(lines[y].indexOf(label), y);
    await view.renderOnce();
  };
  try {
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("\u25b8 Coordination");
    expect(view.captureCharFrame()).not.toContain("Inbox");
    await click("\u25b8 Coordination");
    expect(view.captureCharFrame()).toContain("\u25b8 Inbox (7)");
    expect(view.captureCharFrame()).toContain("\u25b8 Outbox (3)");
    expect(view.captureCharFrame()).not.toContain("req-6");
    await click("\u25b8 Inbox");
    let frame = view.captureCharFrame();
    expect(frame).toContain("req-6: Queued");
    expect(frame).toContain("req-2: Queued");
    expect(frame).not.toContain("req-1:");
    expect(frame.indexOf("req-6:")).toBeLessThan(frame.indexOf("req-2:"));
    const descendants = (node: BaseRenderable): BaseRenderable[] => [node, ...node.getChildren().flatMap(descendants)];
    const row = descendants(view.renderer.root).find((node) => node instanceof TextRenderable && node.plainText.includes("req-6:")) as TextRenderable;
    expect(row.fg).toEqual(RGBA.fromHex("#00ffff"));
    setPrimary("#ff00ff");
    await view.renderOnce();
    expect(row.fg).toEqual(RGBA.fromHex("#ff00ff"));
    expect(historyCalls).toEqual([]);
    await click("req-6:");
    expect(historyCalls).toEqual([["req-6", "origin"]]);
    expect(alert.message).toContain("authorised-history");
    expect(alert.message).toContain("Summary: PRIVATE SUMMARY");
    await click("Browse all (7)");
    expect(selected.options).toHaveLength(7);
    expect(selected.options[6].value.id).toBe("req-0");
    selected.onSelect(selected.options[6]);
    expect(historyCalls[1]).toEqual(["req-0", "origin"]);
    denied = true;
    selected.onSelect(selected.options[0]);
    expect(alert.message).toContain("details unavailable");
    expect(alert.message).not.toContain("PRIVATE");
    await click("\u25b8 Outbox");
    frame = view.captureCharFrame();
    for (const label of ["Acknowledged", "Awaiting result", "Needs review"]) expect(frame).toContain(label);
    expect(frame).not.toContain("PRIVATE");
    await click("\u25be Coordination");
    expect(view.captureCharFrame()).not.toContain("Inbox");
  } finally {
    view.renderer.destroy();
  }
});

test("poll failures preserve data, stay visible when collapsed, recover and clean up", async () => {
  const { Mailbox } = await import("../dist/mailbox.jsx");
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let poll: (() => void) | undefined;
  let cleared = 0;
  const timer = { mailbox: true };
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms !== 2_000) return originalInterval(fn, ms, ...args);
    poll = fn;
    return timer;
  }) as any);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((id: any) => {
    if (id === timer) { cleared++; return; }
    return originalClear(id);
  }) as any);
  const [sessionID, setSessionID] = createSignal("origin");
  let fail = false;
  let reads = 0;
  const api = { theme: { current: { text: "white", warning: "yellow" } }, ui: {} };
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    view = await testRender(() => Mailbox({
      api, get sessionID() { return sessionID(); },
      store: { list() { reads++; if (fail) throw new Error("private"); return { inbox: [request()], outbox: [] }; }, history() {} },
    }), { width: 80, height: 12 });
    await view.renderOnce();
    expect(reads).toBe(1);
    fail = true;
    poll!();
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Coordination unavailable. Showing last known data.");
    await view.mockMouse.click(2, 0);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Inbox (1)");
    fail = false;
    poll!();
    await view.renderOnce();
    expect(view.captureCharFrame()).not.toContain("unavailable");
    fail = true;
    setSessionID("different-session");
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Coordination unavailable. Try again later.");
    expect(view.captureCharFrame()).not.toContain("last known");
    await view.mockMouse.click(2, 0);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Inbox (?)");
    expect(view.captureCharFrame()).not.toContain("No requests");
    expect(cleared).toBe(1);
    view.renderer.destroy();
    view = undefined;
    expect(cleared).toBe(2);
  } finally {
    view?.renderer.destroy();
    interval.mockRestore();
    clear.mockRestore();
  }
});

test("Herdr tokens contain only namespaced counts and status prefixes", () => {
  expect(queueTokens({ inbox: [], outbox: [] })).toEqual({ herdr_inbox: "idle 0", herdr_outbox: "idle 0", herdr_wait: "idle 0" });
  expect(queueTokens({ inbox: [request({ state: "unknown" })], outbox: [request({ kind: "instruction", state: "accepted" })] }))
    .toEqual({ herdr_inbox: "blocked 1", herdr_outbox: "done 1", herdr_wait: "idle 0" });
  const tokens = queueTokens({ inbox: [request()], outbox: [request({ state: "accepted" }), request({ state: "completed", validation: "pending" })] });
  expect(tokens).toEqual({ herdr_inbox: "queued 1", herdr_outbox: "blocked 2", herdr_wait: "active 1" });
  expect(JSON.stringify(tokens)).not.toContain("PRIVATE");
});

test("metadata publishes display-only arguments, caches success, refreshes TTL and retries failures", async () => {
  const calls: any[][] = [];
  let fail = false;
  const publish = createSidebarPublisher(async (...args) => { calls.push(args); if (fail) throw new Error("offline"); });
  const projection = { inbox: [request()], outbox: [] };
  try {
    setSystemTime(new Date("2026-10-02T00:00:00Z"));
    expect(await publish("pane-1", "session-1", projection)).toBe(true);
    expect(calls[0]).toEqual(["herdr", [
      "pane", "report-metadata", "pane-1", "--source", "opencode-herdr", "--agent", "opencode",
      "--applies-to-source", "herdr:opencode", "--ttl-ms", "30000",
      "--token", "herdr_inbox=queued 1", "--token", "herdr_outbox=idle 0", "--token", "herdr_wait=idle 0",
    ], { timeout: 2_000 }]);
    expect(JSON.stringify(calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(calls)).not.toContain("/private");
    await publish("pane-1", "session-1", projection);
    expect(calls).toHaveLength(1);
    setSystemTime(new Date("2026-10-02T00:00:10Z"));
    await publish("pane-1", "session-1", projection);
    expect(calls).toHaveLength(2);
    await publish("pane-1", "session-2", projection);
    expect(calls).toHaveLength(3);
    const changed = { inbox: [], outbox: [] };
    fail = true;
    expect(await publish("pane-1", "session-2", changed)).toBe(false);
    fail = false;
    expect(await publish("pane-1", "session-2", changed)).toBe(true);
    expect(calls).toHaveLength(5);
    await publish("pane-2", "session-2", changed);
    expect(calls).toHaveLength(6);
  } finally {
    setSystemTime();
  }
});

test("metadata suppresses overlapping writes to the same pane without touching lifecycle", async () => {
  let release!: () => void;
  let calls = 0;
  const publish = createSidebarPublisher(async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
  const projection = { inbox: [], outbox: [] };
  const first = publish("pane", "session", projection);
  expect(await publish("pane", "session", projection)).toBe(false);
  expect(calls).toBe(1);
  release();
  expect(await first).toBe(true);
});
