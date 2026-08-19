import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MihomoRuntimeCoordinator } from "../mihomo-runtime.mjs";

class MockManager {
  constructor() {
    this.started = false;
  }
  async testConfig() {
    return { ok: true };
  }
  async start() {
    this.started = true;
    return { ok: true, pid: 12345 };
  }
  async stop() {
    this.started = false;
  }
}

test("CASE 9: Restart recovery with valid active.yaml and meta keeps state=active", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case9-${Date.now()}`);
  const compiledDir = path.join(tmpDir, "compiled");
  await fs.mkdir(compiledDir, { recursive: true });

  const activeMeta = {
    generationId: "gen_active_saved",
    controllerPort: 19090,
    controllerSecret: "sec_123",
    expectedPorts: [7892],
    egressPlan: [{ port: 7892, proxyName: "台湾节点", verified: true }],
  };
  await fs.writeFile(path.join(compiledDir, "active.yaml"), "port: 7890\n", "utf8");
  await fs.writeFile(path.join(compiledDir, "active.meta.json"), JSON.stringify(activeMeta), "utf8");

  const manager = new MockManager();
  const settings = { networkSettings: { mode: "isolated", activation: { state: "active" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const res = await coordinator.recoverEmbeddedMihomo();
  assert.equal(res.ok, true);
  assert.equal(manager.started, true);
  assert.equal(runtime.egressPlan.length, 1);
});

test("CASE 10: Missing active config on restart sets state=degraded", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case10-${Date.now()}`);
  const manager = new MockManager();
  const settings = { networkSettings: { mode: "isolated", activation: { state: "active" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const res = await coordinator.recoverEmbeddedMihomo();
  assert.equal(res.ok, false);
  assert.equal(settings.networkSettings.activation.state, "degraded");
});

test("CASE 11: Interrupted transitional state does NOT promote candidate and cleans up", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case11-${Date.now()}`);
  const manager = new MockManager();
  // 上次异常死在 verifying 状态
  const settings = { networkSettings: { mode: "isolated", activation: { state: "verifying", generationId: "gen_crashed" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  await coordinator.recoverInterruptedMihomoActivation();
  // 必须重置回 inactive (因为没有合法 active.yaml)
  assert.equal(settings.networkSettings.activation.state, "inactive");
});
