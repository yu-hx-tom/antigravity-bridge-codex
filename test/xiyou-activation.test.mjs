import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  computeNodeFingerprint,
  buildPlanFromSelectedNodes,
  selectSingaporeRelay,
  patchXiyouPreferences,
  inspectXiyouPreferences,
  createXiyouOverrideScript,
} from "../subscription.mjs";

test("Node Fingerprint Stability", () => {
  const nodeA = { protocol: "vmess", name: "新加坡 01 | IEPL专线", server: "sg1.example.com", port: 443 };
  const nodeB = { protocol: "vmess", name: "新加坡 01 | IEPL专线", server: "sg1.example.com", port: 443 };
  const nodeC = { protocol: "shadowsocks", name: "台湾 01 | 中华电信", server: "tw1.example.com", port: 8388 };

  const fpA = computeNodeFingerprint(nodeA);
  const fpB = computeNodeFingerprint(nodeB);
  const fpC = computeNodeFingerprint(nodeC);

  assert.equal(fpA, fpB, "相同节点的指纹必须完全相同");
  assert.notEqual(fpA, fpC, "不同节点的指纹必须不同");
  assert.equal(fpA.length, 16, "指纹长度为16位hex");
});

test("Stable Port Allocation Across Reorders and Edits", () => {
  const nodeSg = { protocol: "vmess", name: "新加坡 01 | IEPL专线", server: "sg1.example.com", port: 443, region: "新加坡" };
  const nodeTw = { protocol: "shadowsocks", name: "台湾 01 | 中华电信", server: "tw1.example.com", port: 8388, region: "台湾" };
  const nodeUs = { protocol: "trojan", name: "美国 01 | 硅谷", server: "us1.example.com", port: 443, region: "美国" };
  const nodeJp = { protocol: "trojan", name: "日本 01 | 东京", server: "jp1.example.com", port: 443, region: "日本" };

  // 初始计划：Sg, Tw, Us 分配 7892, 7893, 7894
  const plan1 = buildPlanFromSelectedNodes([nodeSg, nodeTw, nodeUs], 7892);
  assert.equal(plan1.length, 3);
  assert.equal(plan1[0].port, 7892); // SG
  assert.equal(plan1[1].port, 7893); // TW
  assert.equal(plan1[2].port, 7894); // US

  // 调整顺序并加入新节点 JP：Tw, Jp, Sg (去掉 Us)
  // 预期：Tw 保持 7893，Sg 保持 7892，新节点 Jp 分配下一个空闲端口 (7894 或 7895)
  const plan2 = buildPlanFromSelectedNodes([nodeTw, nodeJp, nodeSg], 7892, { previousPlan: plan1 });
  const twChannel = plan2.find((p) => p.name.includes("台湾"));
  const sgChannel = plan2.find((p) => p.name.includes("新加坡"));
  const jpChannel = plan2.find((p) => p.name.includes("日本"));

  assert.equal(twChannel.port, 7893, "台湾节点的端口必须稳定复用 7893");
  assert.equal(sgChannel.port, 7892, "新加坡节点的端口必须稳定复用 7892");
  assert.ok(jpChannel.port > 0 && jpChannel.port !== 7892 && jpChannel.port !== 7893, "日本新节点必须分配不冲突的独立端口");
});

test("Strict Singapore Relay Selection", () => {
  const nodesWithSg = [
    { name: "台湾 01 | 中华电信", isSupported: true },
    { name: "新加坡 01 | IEPL专线", isSupported: true },
    { name: "美国 01 | 洛杉矶", isSupported: true },
  ];
  const relay = selectSingaporeRelay(nodesWithSg);
  assert.ok(relay);
  assert.match(relay.name, /新加坡/);

  const nodesWithoutSg = [
    { name: "台湾 01 | 中华电信", isSupported: true },
    { name: "美国 01 | 洛杉矶", isSupported: true },
    { name: "日本 01 | 东京", isSupported: true },
  ];
  const relayNone = selectSingaporeRelay(nodesWithoutSg);
  assert.equal(relayNone, null, "没有新加坡节点时必须返回 null，绝不偷换为美国或其他国家");
});

test("Patch and Inspect Xiyouyun Preferences", () => {
  const dummyPrefs = JSON.stringify({
    "flutter.config": JSON.stringify({
      currentProfileName: "xiyouyun",
      scriptProps: {
        currentId: "old-script",
        scripts: [{ id: "old-script", label: "老脚本", content: "// old" }],
      },
    }),
  });

  const scriptCode = "function main(config) { return config; }";
  const expectedHash = crypto.createHash("sha256").update(scriptCode).digest("hex");

  const patched = patchXiyouPreferences(dummyPrefs, scriptCode);
  const inspect = inspectXiyouPreferences(patched);

  assert.equal(inspect.ok, true);
  assert.equal(inspect.currentId, "abc-multi-proxy-script");
  assert.equal(inspect.isActive, true);
  assert.equal(inspect.scriptHash, expectedHash);
});
