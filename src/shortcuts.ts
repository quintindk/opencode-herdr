import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export type Shortcut = { label: string; binding: string };
export type ShortcutGroup = { title: string; shortcuts: Shortcut[] };
export type Shortcuts = { prefix: string; groups: ShortcutGroup[] };

// Verified against `herdr --default-config` in Herdr 0.9.1.
const defaults = [
  ["Navigation", "workspace_picker", "Workspaces", "prefix+w"],
  ["Navigation", "goto", "Go to", "prefix+g"],
  ["Navigation", "cycle_pane_next", "Next pane", "prefix+tab"],
  ["Navigation", "previous_tab", "Previous tab", "prefix+p"],
  ["Navigation", "next_tab", "Next tab", "prefix+n"],
  ["Panes", "split_vertical", "Split right", "prefix+v"],
  ["Panes", "split_horizontal", "Split down", "prefix+minus"],
  ["Panes", "zoom", "Zoom pane", "prefix+z"],
  ["Panes", "resize_mode", "Resize panes", "prefix+r"],
  ["Panes", "close_pane", "Close pane", "prefix+x"],
  ["Workspaces", "new_workspace", "New workspace", "prefix+shift+n"],
  ["Workspaces", "new_worktree", "New worktree", "prefix+shift+g"],
  ["Workspaces", "new_tab", "New tab", "prefix+c"],
  ["Herdr", "toggle_sidebar", "Toggle sidebar", "prefix+b"],
  ["Herdr", "help", "All shortcuts", "prefix+?"],
  ["Herdr", "settings", "Settings", "prefix+s"],
  ["Herdr", "reload_config", "Reload config", "prefix+shift+r"],
  ["Herdr", "detach", "Detach", "prefix+q"],
] as const;

function table(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a TOML table");
  }
  return value as Record<string, unknown>;
}

function binding(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("Expected a string keybinding");
  return value.trim();
}

export function parseShortcuts(source: string): Shortcuts {
  const keys = table(parse(source).keys);
  const prefix = binding(keys.prefix, "ctrl+b");
  const groups: ShortcutGroup[] = [];
  const add = (title: string, label: string, key: string) => {
    if (!key) return;
    let group = groups.find((item) => item.title === title);
    if (!group) groups.push((group = { title, shortcuts: [] }));
    group.shortcuts.push({ label, binding: key });
  };
  for (const [group, action, label, fallback] of defaults) {
    add(group, label, binding(keys[action], fallback));
  }
  if (keys.command !== undefined) {
    if (!Array.isArray(keys.command)) throw new Error("Expected keys.command to be an array");
    for (const item of keys.command) {
      const command = table(item);
      const label = typeof command.description === "string" && command.description.trim()
        ? command.description.trim()
        : typeof command.command === "string" ? command.command : "Custom command";
      add("Custom", label, binding(command.key, ""));
    }
  }
  return { prefix, groups };
}

export function formatBinding(value: string): string {
  return value.replace(/^prefix\+/i, "then ").replace(/\bctrl\b/gi, "Ctrl")
    .replace(/\bshift\b/gi, "Shift").replace(/\balt\b/gi, "Alt")
    .replace(/\btab\b/gi, "Tab").replace(/\bminus\b/gi, "-");
}

export function configPath(env = process.env, home = homedir()): string {
  return env.HERDR_CONFIG_PATH || join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr", "config.toml");
}

export async function loadShortcuts(path: string): Promise<Shortcuts> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = "";
  }
  return parseShortcuts(source);
}
