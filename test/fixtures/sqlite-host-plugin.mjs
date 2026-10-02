import assert from "node:assert/strict";
import { writeFile, access } from "node:fs/promises";
import { Database } from "bun:sqlite";

// Loaded by OpenCode itself, never imported by the Node test runner.
export default async function () {
  const { SQLITE_PROBE_DATABASE: path, SQLITE_PROBE_REPORT: report, SQLITE_PROBE_MODE: mode } = process.env;
  assert.ok(path && report && mode, "SQLite probe requires an isolated test environment");
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  try {
    if (mode === "initialise") {
      assert.equal(db.query("PRAGMA journal_mode = WAL").get().journal_mode, "wal");
      db.exec(`
        CREATE TABLE requests (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE deliveries (
          request_id INTEGER PRIMARY KEY REFERENCES requests(id),
          claimed_by TEXT
        );
        CREATE TABLE results (request_id INTEGER PRIMARY KEY REFERENCES requests(id), body TEXT NOT NULL);
        CREATE TABLE outbox (request_id INTEGER PRIMARY KEY REFERENCES requests(id), body TEXT NOT NULL);
      `);
      db.transaction(() => {
        db.query("INSERT INTO requests VALUES (?, ?)").run(1, "queued");
        db.query("INSERT INTO deliveries VALUES (?, NULL)").run(1);
      }).immediate();
      assert.throws(() => db.query("INSERT INTO deliveries VALUES (?, NULL)").run(999));
      assert.throws(() => db.transaction(() => {
        db.query("INSERT INTO results VALUES (?, ?)").run(1, "rollback");
        db.query("INSERT INTO outbox VALUES (?, ?)").run(1, "rollback");
        throw new Error("injected failure");
      }).immediate(), /injected failure/);
      assert.equal(db.query("SELECT count(*) AS n FROM results").get().n, 0);
      assert.equal(db.query("SELECT count(*) AS n FROM outbox").get().n, 0);
    } else if (mode === "claim") {
      await writeFile(`${report}.ready`, "ready");
      const deadline = Date.now() + 20_000;
      while (true) {
        try { await access(process.env.SQLITE_PROBE_GATE); break; }
        catch { assert.ok(Date.now() < deadline, "claim barrier timed out"); }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const claimed = db.transaction(() => db.query(
        "UPDATE deliveries SET claimed_by = ? WHERE request_id = 1 AND claimed_by IS NULL RETURNING request_id",
      ).get(String(process.pid))).immediate();
      await writeFile(report, JSON.stringify({ pid: process.pid, claimed: !!claimed }));
      return {};
    } else if (mode === "crash") {
      db.exec("BEGIN IMMEDIATE");
      db.query("INSERT INTO results VALUES (?, ?)").run(1, "uncommitted");
      db.query("INSERT INTO outbox VALUES (?, ?)").run(1, "uncommitted");
      await writeFile(`${report}.ready`, "uncommitted transaction open");
      await new Promise(() => {});
    } else if (mode === "read-during-write") {
      assert.equal(db.query("SELECT count(*) AS n FROM results").get().n, 0);
      assert.equal(db.query("SELECT count(*) AS n FROM outbox").get().n, 0);
    } else if (mode === "recover") {
      assert.equal(db.query("SELECT count(*) AS n FROM results").get().n, 0);
      assert.equal(db.query("SELECT count(*) AS n FROM outbox").get().n, 0);
      assert.ok(db.query("SELECT claimed_by FROM deliveries WHERE request_id = 1").get().claimed_by);
      db.transaction(() => {
        db.query("INSERT INTO results VALUES (?, ?)").run(1, "committed");
        db.query("INSERT INTO outbox VALUES (?, ?)").run(1, "committed");
      }).immediate();
    } else if (mode === "verify") {
      assert.equal(db.query("SELECT body FROM results WHERE request_id = 1").get().body, "committed");
      assert.equal(db.query("SELECT body FROM outbox WHERE request_id = 1").get().body, "committed");
      assert.equal(db.query("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    } else {
      throw new Error(`Unknown probe mode: ${mode}`);
    }
    await writeFile(report, JSON.stringify({
      mode,
      pid: process.pid,
      bun: Bun.version,
      sqlite: db.query("SELECT sqlite_version() AS version").get().version,
      journal: db.query("PRAGMA journal_mode").get().journal_mode,
      foreignKeys: db.query("PRAGMA foreign_keys").get().foreign_keys,
      synchronous: db.query("PRAGMA synchronous").get().synchronous,
    }));
  } finally {
    db.close();
  }
  return {};
}
