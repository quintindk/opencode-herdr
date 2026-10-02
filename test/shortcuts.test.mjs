import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, formatBinding, loadShortcuts, parseShortcuts } from "../dist/shortcuts.js";

const rows = (value) => value.groups.flatMap((group) => group.shortcuts);

test("default shortcuts match Herdr 0.9.1", () => {
  const value = parseShortcuts("");
  assert.equal(value.prefix, "ctrl+b");
  assert.equal(rows(value).length, 18);
  assert.deepEqual(rows(value).find((row) => row.label === "Split down"), { label: "Split down", binding: "prefix+minus" });
});

test("custom prefix, direct bindings, and disabled defaults are honoured", () => {
  const value = parseShortcuts('[keys]\nprefix = "ctrl+a"\nzoom = "alt+z"\nclose_pane = ""');
  assert.equal(value.prefix, "ctrl+a");
  assert.equal(rows(value).find((row) => row.label === "Zoom pane").binding, "alt+z");
  assert.equal(rows(value).some((row) => row.label === "Close pane"), false);
});

test("custom command descriptions and fallback labels are included without executing them", () => {
  const value = parseShortcuts(`
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr-projects.open-popup"
description = "Projects"
[[keys.command]]
key = "prefix+shift+b"
command = "browser.open"
[[keys.command]]
key = ""
command = "disabled"
`);
  assert.deepEqual(value.groups.find((group) => group.title === "Custom").shortcuts, [
    { label: "Projects", binding: "prefix+a" },
    { label: "browser.open", binding: "prefix+shift+b" },
  ]);
});

test("invalid config is rejected rather than silently replaced with defaults", () => {
  for (const source of ['[keys', 'keys = "bad"', '[keys]\nzoom = 12', '[keys]\ncommand = "bad"']) {
    assert.throws(() => parseShortcuts(source));
  }
});

test("prefix sequences are distinguished from direct chords", () => {
  assert.equal(formatBinding("prefix+shift+b"), "then Shift+b");
  assert.equal(formatBinding("prefix+minus"), "then -");
  assert.equal(formatBinding("ctrl+alt+tab"), "Ctrl+Alt+Tab");
});

test("config location respects explicit path and XDG config directory", () => {
  assert.equal(configPath({}, "/home/test"), "/home/test/.config/herdr/config.toml");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/config" }), "/config/herdr/config.toml");
  assert.equal(configPath({ HERDR_CONFIG_PATH: "/custom.toml", XDG_CONFIG_HOME: "/config" }), "/custom.toml");
});

test("load uses defaults only for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-herdr-"));
  try {
    const path = join(dir, "config.toml");
    assert.equal((await loadShortcuts(path)).prefix, "ctrl+b");
    await writeFile(path, '[keys]\nprefix = "f12"');
    assert.equal((await loadShortcuts(path)).prefix, "f12");
    await writeFile(path, "not valid toml");
    await assert.rejects(loadShortcuts(path));
    await assert.rejects(loadShortcuts(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
