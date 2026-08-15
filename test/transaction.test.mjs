import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyFiles,
  atomicWriteJson,
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../transaction.mjs";

test("Codex takeover snapshot restores changed and originally missing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ag-transaction-"));
  const liveHome = path.join(root, "live");
  const backupDir = path.join(root, "backup");
  await fs.mkdir(liveHome, { recursive: true });
  await fs.writeFile(path.join(liveHome, "config.toml"), "official\n");

  try {
    const manifest = await createSnapshot(liveHome, backupDir, ["config.toml", "auth.json"]);
    await atomicWriteJson(path.join(backupDir, "manifest.json"), manifest);
    await verifySnapshot(backupDir, manifest);
    await applyFiles([
      { path: path.join(liveHome, "config.toml"), data: "antigravity\n" },
      { path: path.join(liveHome, "auth.json"), data: "{}\n" },
    ]);

    await restoreSnapshot(backupDir, manifest);
    assert.equal(await fs.readFile(path.join(liveHome, "config.toml"), "utf8"), "official\n");
    await assert.rejects(fs.stat(path.join(liveHome, "auth.json")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex takeover refuses a damaged backup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ag-transaction-"));
  const liveHome = path.join(root, "live");
  const backupDir = path.join(root, "backup");
  await fs.mkdir(liveHome, { recursive: true });
  await fs.writeFile(path.join(liveHome, "config.toml"), "official\n");

  try {
    const manifest = await createSnapshot(liveHome, backupDir, ["config.toml"]);
    await fs.writeFile(path.join(backupDir, "config.toml"), "damaged\n");
    await assert.rejects(verifySnapshot(backupDir, manifest), /Backup verification failed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
