import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { MihomoRuntimeCoordinator, EgressVerificationError, MihomoActivationRollbackError } from "../mihomo-runtime.mjs";

const sampleSourceYaml = `
port: 7890
mode: rule
proxies:
  - name: "台湾｜高速-家宽"
    type: anytls
    server: 1.1.1.1
    port: 443
  - name: "新加坡｜IEPL专线"
    type: anytls
    server: 2.2.2.2
    port: 443
  - name: "日本｜专线"
    type: tuic
    server: 3.3.3.3
    port: 8443
rules:
  - MATCH,DIRECT
`;

class MockManager {
  constructor({ testConfigOk = true, startOk = true } = {}) {
    this.testConfigOk = testConfigOk;
    this.startOk = startOk;
    this.activeConfigPath = null;
    this.stopped = false;
    this.started = false;
  }
  async testConfig(cfgPath) {
    if (!this.testConfigOk) return { ok: false, error: "Mock syntax error" };
    return { ok: true, output: "Configuration test is successful" };
  }
  async start({ configPath }) {
    if (!this.startOk) throw new Error("Mock spawn failed");
    this.started = true;
    this.stopped = false;
    this.activeConfigPath = configPath;
    return { ok: true, pid: 99999 };
  }
  async stop() {
    this.stopped = true;
    this.started = false;
  }
  getStatus() {
    return { running: this.started, pid: this.started ? 99999 : null };
  }
}

test("CASE 1: 4/4 Ready & Geo probe success -> candidate promoted to active", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case1-${Date.now()}`);
  const manager = new MockManager();
  const mockProbe = async (port) => ({
    ok: true,
    countryCode: port === 7892 ? "TW" : "SG",
    country: port === 7892 ? "Taiwan" : "Singapore",
    ip: "1.2.3.4",
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    probeGeoFn: mockProbe,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
    { port: 7893, proxyName: "新加坡｜IEPL专线", region: "新加坡" },
  ];

  const result = await coordinator.activateTransaction({
    sourceText: sampleSourceYaml,
    egressPlan,
  });

  assert.equal(result.ok, true);
  assert.equal(settings.networkSettings.activation.state, "active");
  assert.equal(runtime.egressPlan.length, 2);
  assert.ok(runtime.egressPlan.every((p) => p.verified === true));

  // 验证 active.yaml 确实生成
  const activeContent = await fs.readFile(path.join(tmpDir, "compiled", "active.yaml"), "utf8");
  assert.ok(activeContent.includes("abc-egress-7892"));
});

test("CASE 2: One probe fails out of two -> partial success and candidate IS promoted", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case2-${Date.now()}`);
  const manager = new MockManager();
  // 端口 7893 失败，端口 7892 成功
  const mockProbe = async (port) => {
    if (port === 7893) return { ok: false, error: "Connection timed out" };
    return { ok: true, countryCode: "TW", country: "Taiwan", ip: "1.2.3.4" };
  };

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    probeGeoFn: mockProbe,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
    { port: 7893, proxyName: "新加坡｜IEPL专线", region: "新加坡" },
  ];

  const result = await coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan });

  assert.equal(result.ok, true);
  assert.equal(result.state, "partial");
  assert.equal(settings.networkSettings.activation.state, "partial");
  assert.equal(result.summary.active, 1);
  assert.equal(result.summary.failed, 1);

  // 验证 active.yaml 确实生成并保留
  const activeExists = fsSync.existsSync(path.join(tmpDir, "compiled", "active.yaml"));
  assert.ok(activeExists);
});

test("CASE 3: ALL egress probes fail (0/1) -> triggers full rollback and state=failed", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case3-${Date.now()}`);
  const manager = new MockManager();
  // 全部端口探测失败
  const mockProbe = async () => ({
    ok: false,
    error: "Connection refused",
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    probeGeoFn: mockProbe,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
  ];

  await assert.rejects(
    async () => coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan }),
    EgressVerificationError
  );

  assert.equal(settings.networkSettings.activation.state, "failed");
});

test("CASE 6: Candidate start fails -> restores previous stable active", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case6-${Date.now()}`);
  const compiledDir = path.join(tmpDir, "compiled");
  await fs.mkdir(compiledDir, { recursive: true });

  // 预先写入 previous 稳定配置
  const prevMeta = {
    generationId: "gen_stable",
    controllerPort: 19090,
    controllerSecret: "sec_stable",
    expectedPorts: [7892],
    egressPlan: [{ port: 7892, proxyName: "台湾｜高速-家宽", verified: true }],
  };
  await fs.writeFile(path.join(compiledDir, "previous.yaml"), sampleSourceYaml, "utf8");
  await fs.writeFile(path.join(compiledDir, "previous.meta.json"), JSON.stringify(prevMeta), "utf8");

  // 让 candidate 启动失败，但在回滚时恢复
  const manager = new MockManager({ startOk: false });
  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    probeGeoFn: async () => ({ ok: true, countryCode: "TW" }),
    saveSettingsFn: async () => {},
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
  ];

  // 此时 start 失败，但在回滚时设置 startOk = true
  let firstCall = true;
  manager.start = async () => {
    if (firstCall) {
      firstCall = false;
      throw new Error("Candidate crashed on launch");
    }
    return { ok: true, pid: 8888 };
  };

  await assert.rejects(
    async () => coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan }),
    /Candidate crashed on launch/
  );

  // 状态应成功回滚到 active (gen_stable)
  assert.equal(settings.networkSettings.activation.state, "active");
  assert.equal(settings.networkSettings.activation.generationId, "gen_stable");
});

test("CASE A: Geo probe returns 429 rate limit -> state is active_geo_unknown and candidate IS promoted", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case-geo429-${Date.now()}`);
  const manager = new MockManager();
  const mockProbe = async (port) => ({
    ok: false,
    stage: "geo_unknown",
    isRateLimited: true,
    countryCode: "GLOBAL",
    country: "全球节点 (Geo限流待确认)",
    error: "Geo 查询服务触发频次限制 (HTTP 429)",
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    probeGeoFn: mockProbe,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
  ];

  const result = await coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan });

  assert.equal(result.ok, true);
  assert.equal(result.egressPlan[0].verified, true);
  assert.equal(result.egressPlan[0].state, "active_geo_unknown");
  assert.equal(settings.networkSettings.activation.state, "active");
});

test("CASE B: Primary 204 endpoint fails (HTTP 502) but Fallback endpoint succeeds -> verified=true & active", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case-502-${Date.now()}`);
  const manager = new MockManager();

  // 模拟 verifyEgressFn：主目标 502，备用 204 成功
  const mockVerifyEgress = async (item) => ({
    ...item,
    listenerOk: true,
    proxyCoreOk: true,
    internetOk: true,
    geoOk: true,
    state: "active",
    verified: true,
    latencyMs: 145,
    diagnostics: {
      internet: {
        ok: true,
        target: "fallback",
        attempts: [
          { target: "primary", httpStatus: 502, ok: false },
          { target: "fallback", httpStatus: 204, ok: true },
        ],
      },
    },
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    verifyEgressFn: mockVerifyEgress,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
  ];

  const result = await coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan });

  assert.equal(result.ok, true);
  assert.equal(result.state, "active");
  assert.equal(result.egressPlan[0].verified, true);
  assert.equal(result.egressPlan[0].diagnostics.internet.target, "fallback");
});

test("CASE C: Both 204 endpoints fail but Geo API returns public IP -> fallback recovery succeeds", async () => {
  const tmpDir = path.join(os.tmpdir(), `mihomo-test-case-geofallback-${Date.now()}`);
  const manager = new MockManager();

  // 模拟 verifyEgressFn：标准 204 失败，但 Geo 明确拿到出口公网 IP
  const mockVerifyEgress = async (item) => ({
    ...item,
    listenerOk: true,
    proxyCoreOk: true,
    internetOk: true,
    geoOk: true,
    state: "active",
    verified: true,
    realGeo: { ip: "203.0.113.5", countryCode: "TW", country: "Taiwan" },
    diagnostics: {
      internet: {
        ok: true,
        recoveredBy: "geo_probe",
        warning: "标准公网探测目标响应异常，但已通过 Geo 出口成功确认公网通达",
      },
    },
  });

  const settings = { networkSettings: { activation: { state: "inactive" } } };
  const runtime = { egressPlan: [] };

  const coordinator = new MihomoRuntimeCoordinator({
    dataDir: tmpDir,
    manager,
    verifyEgressFn: mockVerifyEgress,
    saveSettingsFn: async () => {},
  });
  coordinator.init({ runtime, settings });

  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽", region: "台湾" },
  ];

  const result = await coordinator.activateTransaction({ sourceText: sampleSourceYaml, egressPlan });

  assert.equal(result.ok, true);
  assert.equal(result.egressPlan[0].verified, true);
  assert.equal(result.egressPlan[0].diagnostics.internet.recoveredBy, "geo_probe");
});
