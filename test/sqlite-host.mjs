import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp("/tmp/opencode/herdr-sqlite-host-");
const children = new Set();
const fixture = fileURLToPath(new URL("./fixtures/sqlite-host-plugin.mjs", import.meta.url));
const database = join(root, "coordination.sqlite");
const gate = join(root, "claim-gate");

async function launch(mode, name = mode) {
  const home = join(root, name);
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [fixture],
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_|HERDR_|XDG_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    SQLITE_PROBE_DATABASE: database,
    SQLITE_PROBE_REPORT: join(home, "report.json"),
    SQLITE_PROBE_MODE: mode,
    SQLITE_PROBE_GATE: gate,
  });
  const child = spawn("opencode", ["debug", "config"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  const report = env.SQLITE_PROBE_REPORT;
  return { child, finished, report, output: () => output };
}

async function waitFor(path, process) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch {}
    if (!children.has(process.child)) throw new Error(`Host exited before probe: ${process.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Host probe timed out: ${process.output()}`);
}

async function result(process) {
  await waitFor(process.report, process);
  const data = JSON.parse(await readFile(process.report, "utf8"));
  // Some OpenCode debug commands keep background services alive after printing.
  process.child.kill("SIGTERM");
  await process.finished;
  return data;
}

try {
  console.log("Testing bun:sqlite inside isolated OpenCode plugin processes");
  const initial = await result(await launch("initialise"));
  console.log("Host and database:", initial);
  assert.equal(initial.journal, "wal");
  assert.equal(initial.foreignKeys, 1);
  assert.equal(initial.synchronous, 2);

  const workers = await Promise.all(Array.from({ length: 4 }, (_, i) => launch("claim", `claim-${i}`)));
  await Promise.all(workers.map((worker) => waitFor(`${worker.report}.ready`, worker)));
  await writeFile(gate, "go");
  const claims = await Promise.all(workers.map(result));
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(new Set(claims.map((claim) => claim.pid)).size, 4);
  console.log("Four concurrent host processes, exactly one claim:", claims);

  const crashing = await launch("crash");
  await waitFor(`${crashing.report}.ready`, crashing);
  await result(await launch("read-during-write"));
  crashing.child.kill("SIGKILL");
  const exit = await crashing.finished;
  assert.equal(exit.signal, "SIGKILL");
  await result(await launch("recover"));
  await result(await launch("verify"));
  console.log("PASS: exception rollback, foreign keys, atomic claim, concurrent reader isolation, SIGKILL rollback, persisted result/outbox and integrity check");
} finally {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => new Promise((resolve) => child.once("close", resolve))));
  await rm(root, { recursive: true, force: true });
}
