import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readHistoryInventory } from "../history.mjs";

test("history inventory is read-only and preserves original providers", async (context) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    context.skip("node:sqlite is unavailable");
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ag-history-"));
  const databasePath = path.join(home, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT, title TEXT, model_provider TEXT, model TEXT, archived INTEGER,
      created_at INTEGER, updated_at INTEGER, history_mode TEXT
    );
    INSERT INTO threads VALUES
      ('official', 'Official task', 'openai', 'gpt-test', 0, 1, 2, 'legacy'),
      ('local', 'Local task', 'antigravity_local', 'gemini-test', 0, 2, 3, 'legacy');
  `);
  database.close();
  try {
    const inventory = await readHistoryInventory(home);
    assert.equal(inventory.total, 2);
    const official = inventory.tasks.find((task) => task.id === "official");
    const local = inventory.tasks.find((task) => task.id === "local");
    assert.equal(official.readOnly, true);
    assert.equal(official.provider, "openai");
    assert.equal(official.model, "gpt-test");
    assert.equal(local.canContinue, true);
    assert.equal(inventory.migration.enabled, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
