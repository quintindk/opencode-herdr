import { test, expect } from "bun:test";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { testRender } from "@opentui/solid";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

ensureRuntimePluginSupport();

test("sidebar renders real OpenTUI content, wraps narrow rows, and collapses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-herdr-tui-"));
  const old = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  let renderer;
  try {
    const path = join(dir, "config.toml");
    await writeFile(path, '[keys]\nprefix = "ctrl+a"\n[[keys.command]]\nkey = "prefix+f"\ndescription = "Projects"\ncommand = "never-execute-this"');
    const { default: plugin } = await import("../dist/tui.jsx");
    let slot;
    const api = {
      theme: { current: { text: "white", textMuted: "gray", warning: "yellow", primary: "cyan" } },
      slots: { register(value) { slot = value.slots.sidebar_content; } },
    };
    await plugin.tui(api, { configPath: path, coordination: false });
    const view = await testRender(() => slot({}, { session_id: "test" }), { width: 28, height: 50 });
    renderer = view.renderer;
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("\u25b8 Herdr shortcuts");
    expect(view.captureCharFrame()).not.toContain("Ctrl+a");
    const click = async (label: string) => {
      const lines = view.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      await view.mockMouse.click(lines[y].indexOf(label), y);
      await view.renderOnce();
    };
    await click("\u25b8 Herdr shortcuts");
    expect(view.captureCharFrame()).toContain("Ctrl+a");
    for (const group of ["Navigation", "Panes", "Workspaces", "Herdr", "Custom"]) {
      expect(view.captureCharFrame()).toContain(`\u25b8 ${group}`);
    }
    expect(view.captureCharFrame()).not.toContain("Projects");
    expect(view.captureCharFrame()).not.toContain("Split right");
    await click("\u25b8 Custom");
    await click("\u25b8 Panes");
    const frame = view.captureCharFrame();
    expect(frame).toContain("Projects");
    expect(frame).toContain("then f");
    expect(frame).toContain("Split right");
    expect(frame).toMatch(/then v:\s+Split right/);
    expect(frame).toMatch(/then f:\s+Projects/);
    const lines = frame.split("\n").map(line => line.trimEnd());
    const titleLine = lines.findIndex(line => line.includes("Herdr shortcuts"));
    const customLine = lines.findIndex(line => line.includes("Projects"));
    expect(lines.slice(titleLine, customLine + 1).every(line => line.trim().length > 0)).toBe(true);
    expect(frame).not.toContain("never-execute-this");
    await click("\u25be Panes");
    expect(view.captureCharFrame()).not.toContain("Split right");
    await click("\u25be Herdr shortcuts");
    expect(view.captureCharFrame()).not.toContain("Projects");
    await click("\u25b8 Herdr shortcuts");
    await click("\u25b8 Custom");
    expect(view.captureCharFrame()).toContain("Projects");
  } finally {
    renderer?.destroy();
    if (old === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("no sidebar registration outside Herdr", async () => {
  const old = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    const { default: plugin } = await import("../dist/tui.jsx");
    let registered = false;
    await plugin.tui({ slots: { register() { registered = true; } } });
    expect(registered).toBe(false);
  } finally {
    if (old !== undefined) process.env.HERDR_ENV = old;
  }
});

test("unreadable config renders a warning, not misleading default shortcuts", async () => {
  const old = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  let renderer;
  try {
    const { default: plugin } = await import("../dist/tui.jsx");
    let slot;
    await plugin.tui({
      theme: { current: { text: "white", textMuted: "gray", warning: "yellow", primary: "cyan" } },
      slots: { register(value) { slot = value.slots.sidebar_content; } },
    }, { configPath: tmpdir(), coordination: false });
    const view = await testRender(() => slot({}, { session_id: "test" }), { width: 32, height: 12 });
    renderer = view.renderer;
    await view.renderOnce();
    await view.mockMouse.click(2, 0);
    await view.renderOnce();
    expect(view.captureCharFrame()).toContain("Cannot read Herdr config");
    expect(view.captureCharFrame()).not.toContain("Ctrl+b");
  } finally {
    renderer?.destroy();
    if (old === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = old;
  }
});
