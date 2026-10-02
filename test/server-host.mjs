import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/server-host-check.mjs", import.meta.url));
await access(main); // Run npm run build first. Never fall back to source imports.
const root = await mkdtemp("/tmp/opencode/herdr-server-host-");
const children = new Map();

async function launch(mode) {
  const home = join(root, mode);
  const config = join(home, ".config", "opencode");
  await mkdir(config, { recursive: true });
  const plugins = [main, probe];
  if (mode === "conflict") {
    // Exercise only the conflict marker, never load the real Envoy plugin.
    const fake = join(home, "fake-herdr-envoy.mjs");
    await writeFile(fake, "export default async function () { return {}; }\n");
    plugins.push(fake);
  }
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: plugins,
    autoupdate: false,
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_|HERDR_|XDG_|SERVER_HOST_PROBE_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    SERVER_HOST_PROBE_MODE: mode,
    SERVER_HOST_PROBE_REPORT: join(home, "report.json"),
  });
  const child = spawn("opencode", ["debug", "config"], {
    cwd: home, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const finished = new Promise((resolve) => child.once("close", (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  children.set(child, finished);
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      let text;
      try { text = await readFile(env.SERVER_HOST_PROBE_REPORT, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (text !== undefined) {
        const report = JSON.parse(text);
        assert.equal(report.error, undefined, `${mode} probe failed: ${report.error}\n${output}`);
        assert.equal(report.mode, mode);
        assert.equal(report.databaseExists, true);
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.commandRegistered, mode === "normal");
        assert.equal(report.counts.requests, 0);
        if (mode === "conflict") assert.equal(report.disabled, true);
        console.log(`${mode} host:`, report);
        return;
      }
      if (spawnError) throw spawnError;
      assert.ok(children.has(child), `${mode} host exited before probe: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${mode} host probe timed out: ${output}`);
  } finally {
    // Debug config can retain background services. Signal only our own child.
    if (children.has(child)) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await finished; } finally { clearTimeout(kill); }
    }
  }
}

try {
  console.log("Testing built server plugin through isolated OpenCode loaders");
  await launch("normal");
  await launch("conflict");
  console.log("PASS: actual plugin loading, SQLite schema and empty queues, /herdr registration, tool surface and fail-closed Envoy conflict guard");
} finally {
  const pending = [...children.values()];
  for (const child of children.keys()) child.kill("SIGKILL");
  await Promise.all(pending);
  await rm(root, { recursive: true, force: true });
}
