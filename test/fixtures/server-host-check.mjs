import assert from "node:assert/strict";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// This probe runs after dist/index.js in OpenCode's real config hook sequence.
export default async function ({ directory }) {
  const { SERVER_HOST_PROBE_MODE: mode, SERVER_HOST_PROBE_REPORT: report } = process.env;
  assert.ok(report && ["normal", "conflict"].includes(mode), "Isolated host probe environment required");
  return {
    async config(cfg) {
      let result;
      try {
        assert.deepEqual(Object.keys(process.env).filter((key) => key.startsWith("HERDR_")), []);
        const commandRegistered = Object.hasOwn(cfg.command ?? {}, "herdr");
        assert.equal(commandRegistered, mode === "normal", "Main plugin config hook must run before probe");
        if (commandRegistered) {
          assert.equal(cfg.command.herdr.description, "Coordinate Herdr agents");
          assert.match(cfg.command.herdr.template, /list_agents/);
          assert.match(cfg.command.herdr.template, /\$ARGUMENTS/);
        }

        // Check loader-created state before a direct instance could mask a load failure.
        const path = join(process.env.XDG_CONFIG_HOME, "opencode", "opencode-herdr", "coordination.sqlite");
        await access(path);
        const db = new Database(path, { readonly: true });
        try {
          const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
          assert.deepEqual(tables, ["agents", "audit_events", "deliveries", "generations", "metadata", "notifications", "operations", "questions", "requests", "results"]);
          const counts = Object.fromEntries(tables.map((table) => [table, db.query(`SELECT count(*) AS n FROM "${table}"`).get().n]));
          for (const table of tables) if (table !== "metadata") assert.equal(counts[table], 0, `${table} must be empty`);
          const schemaVersion = db.query("PRAGMA user_version").get().user_version;
          assert.equal(schemaVersion, 1);
          result = {
            mode, pid: process.pid, bun: Bun.version,
            sqlite: db.query("SELECT sqlite_version() AS version").get().version,
            databaseExists: true, schemaVersion, tables, counts, commandRegistered,
          };
        } finally {
          db.close();
        }

        if (mode === "conflict") {
          // OpenCode can swallow config-hook errors. Verify the tool guard directly
          // inside the host without starting another worker or using its SDK client.
          const { default: main } = await import("../../dist/index.js");
          const client = { session: { async create() { throw new Error("Probe must not call the host SDK"); } } };
          const hooks = await main({ client, directory });
          try {
            result.tools = Object.keys(hooks.tool).sort();
            assert.deepEqual(result.tools, [
              "ask_coordinator", "cancel_request", "close_agent", "hand_back", "inspect_request",
              "list_agents", "list_machines", "list_operations", "list_requests", "open_agent",
              "read_task", "reply_question", "request_agent", "resume_request",
            ]);
            for (const tool of Object.values(hooks.tool)) {
              assert.equal(typeof tool.execute, "function");
              assert.equal(typeof tool.description, "string");
              assert.equal(typeof tool.args, "object");
            }
            const conflict = { plugin: cfg.plugin };
            await assert.rejects(() => hooks.config(conflict), /Retire or disable the Envoy server plugin/);
            assert.equal(conflict.command?.herdr, undefined);
            const ctx = {
              sessionID: "ses_isolated_server_probe", messageID: "msg_isolated_server_probe",
              agent: "build", directory, worktree: directory,
              abort: new AbortController().signal,
              metadata() {}, async ask() { throw new Error("Probe must not request permission"); },
            };
            await assert.rejects(() => hooks.tool.list_requests.execute({}, ctx), /Coordination is disabled until configuration passes its Envoy conflict check/);
            result.disabled = true;
          } finally {
            await hooks.dispose();
          }
        }
      } catch (error) {
        // Report assertions explicitly because the host may swallow this hook's errors too.
        result = { mode, error: error.stack ?? String(error) };
      }
      await writeFile(`${report}.tmp`, JSON.stringify(result));
      await rename(`${report}.tmp`, report);
    },
  };
}
