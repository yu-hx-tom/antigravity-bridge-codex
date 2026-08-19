import test from "node:test";
import assert from "node:assert/strict";
import { MihomoManager } from "../mihomo-manager.mjs";

test("MihomoManager instance creates with default state", () => {
  const manager = new MihomoManager({ binDir: "bin", dataDir: ".data/mihomo" });
  assert.ok(manager);
  const status = manager.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});

test("MihomoManager detects binary path properly", () => {
  const manager = new MihomoManager();
  const binPath = manager.detectBinaryPath();
  assert.ok(binPath);
  assert.ok(binPath.toLowerCase().includes("mihomo"));
});

test("MihomoManager getVersion returns version info", async () => {
  const manager = new MihomoManager();
  const ver = await manager.getVersion();
  assert.equal(ver.ok, true);
  assert.ok(ver.versionText.includes("Mihomo"));
});
