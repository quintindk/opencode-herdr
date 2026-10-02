import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { testRender } from "@opentui/solid";
import { RGBA, TextRenderable, type BaseRenderable } from "@opentui/core";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";

ensureRuntimePluginSupport();

test("built sidebar renders persisted coordination alongside shortcuts without changing requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-sidebar-integration-"));
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HERDR_ENV: process.env.HERDR_ENV };
  process.env.XDG_CONFIG_HOME = dir;
  process.env.HERDR_ENV = "1";
  let store: Store | undefined;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, '[keys]\nprefix = "ctrl+a"\n');
    store = new Store();
    const binding = {
      socket: join(dir, "unused.sock"), paneId: "pane", terminalId: "terminal",
      workspaceId: "workspace", directory: dir, state: "idle", lastSeen: Date.now(),
    };
    const origin = store.observeAgent({ ...binding, sessionId: "origin", label: "Origin" });
    const worker = store.observeAgent({ ...binding, paneId: "worker-pane", sessionId: "worker", label: "Worker" });
    const completed = store.enqueue({
      originSessionId: origin.sessionId, originDirectory: dir, recipientId: worker.id,
      kind: "task", text: "Completed outgoing task", idempotencyKey: "completed",
    });
    // Persist the real lifecycle without starting a server or delivering over a socket.
    expect(store.attempt(completed.id, completed.generation, "fixture-message")).toBe(true);
    store.submitted(completed.id, "fixture-message");
    store.accept(completed.id, completed.generation, completed.deliveryId, worker.sessionId);
    store.finish(completed.id, completed.generation, worker.sessionId, {
      outcome: "completed", summary: "Fixture complete", checks: [], risks: [],
    });
    const queued = store.enqueue({
      originSessionId: origin.sessionId, originDirectory: dir, recipientId: worker.id,
      kind: "task", text: "Queued outgoing task", idempotencyKey: "queued",
    });
    const incoming = store.enqueue({
      originSessionId: worker.sessionId, originDirectory: dir, recipientId: origin.id,
      kind: "task", text: "Queued incoming task", idempotencyKey: "incoming",
    });
    const before = store.list(origin.sessionId);
    const histories = [incoming, queued, completed].map(request => store!.history(request.id, origin.sessionId));
    const machineId = store.machineId;
    store.close();
    store = undefined;
    const path = join(dir, "opencode", "opencode-herdr", "coordination.sqlite");
    expect((await stat(path)).isFile()).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const { default: plugin } = await import("../dist/tui.jsx");
    let slot;
    const theme = {
      text: "#ffffff", textMuted: "#808080", primary: "#00ffff",
      accent: "#ff00ff", warning: "#ffff00", success: "#00ff00", error: "#ff0000",
    };
    await plugin.tui({
      theme: { current: theme },
      ui: { DialogAlert: () => null, DialogSelect: () => null },
      slots: { register(value) { slot = value.slots.sidebar_content; } },
    }, { configPath });
    expect(slot).toBeFunction();
    view = await testRender(() => slot({}, { session_id: origin.sessionId }), { width: 80, height: 30 });
    const rendered = view;
    const click = async (label: string) => {
      const lines = rendered.captureCharFrame().split("\n");
      const y = lines.findIndex(line => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      await rendered.mockMouse.click(lines[y].indexOf(label), y);
      await rendered.renderOnce();
      expect(rendered.captureCharFrame()).not.toMatch(/unavailable|readonly|corrupt/i);
    };
    await view.renderOnce();
    const collapsed = view.captureCharFrame();
    expect(collapsed).toContain("\u25b8 Coordination");
    expect(collapsed).toContain("\u25b8 Herdr shortcuts");
    expect(collapsed).not.toMatch(/Inbox|Outbox|Ctrl\+a|unavailable|readonly|corrupt/i);
    await click("\u25b8 Coordination");
    expect(view.captureCharFrame()).toContain("\u25b8 Inbox (1)");
    expect(view.captureCharFrame()).toContain("\u25b8 Outbox (2)");
    expect(view.captureCharFrame()).not.toContain("Task ");
    await click("\u25b8 Inbox");
    expect(view.captureCharFrame()).toContain(`Task ${incoming.id}: Queued`);
    expect(view.captureCharFrame()).not.toContain(queued.id);
    await click("\u25b8 Outbox");
    const descendants = (node: BaseRenderable): BaseRenderable[] => [node, ...node.getChildren().flatMap(descendants)];
    for (const [request, label, colour] of [
      [incoming, "Queued", theme.primary], [queued, "Queued", theme.primary], [completed, "Completed", theme.success],
    ] as const) {
      const text = `Task ${request.id}: ${label}`;
      expect(view.captureCharFrame()).toContain(text);
      const row = descendants(view.renderer.root).find(node => node instanceof TextRenderable && node.plainText === text) as TextRenderable;
      expect(row).toBeDefined();
      expect(row.fg).toEqual(RGBA.fromHex(colour));
    }
    await click("\u25be Inbox");
    expect(view.captureCharFrame()).not.toContain(incoming.id);
    expect(view.captureCharFrame()).toContain(completed.id);
    await click("\u25be Outbox");
    expect(view.captureCharFrame()).not.toContain("Task ");
    await click("\u25be Coordination");
    expect(view.captureCharFrame()).toBe(collapsed);
    await click("\u25b8 Herdr shortcuts");
    expect(view.captureCharFrame()).toContain("Ctrl+a");
    expect(view.captureCharFrame()).toContain("\u25b8 Coordination");
    await click("\u25be Herdr shortcuts");
    expect(view.captureCharFrame()).toBe(collapsed);

    store = new Store();
    expect(store.machineId).toBe(machineId);
    expect(store.list(origin.sessionId)).toEqual(before);
    expect([incoming, queued, completed].map(request => store!.history(request.id, origin.sessionId))).toEqual(histories);
    // A write through a separate connection catches accidental read-only database handling.
    expect(store.observeAgent({ ...binding, sessionId: origin.sessionId, label: "Still writable" }).label).toBe("Still writable");
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    try {
      view?.renderer.destroy();
    } finally {
      try {
        store?.close();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
});
