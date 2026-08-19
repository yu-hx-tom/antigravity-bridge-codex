import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyMihomoConfig,
  parseMihomoSource,
  extractProxyCatalog,
  removePreviousAbcOverlay,
  validatePlanReferences,
  injectCustomProxies,
  injectListeners,
  compileMihomoConfig,
  computeConfigHash,
} from "../mihomo-config.mjs";

const sampleSourceYaml = `
port: 7890
socks-port: 7891
mode: rule
log-level: info
allow-lan: true
bind-address: "*"
external-controller: 127.0.0.1:9090

dns:
  enable: true
  listen: 127.0.0.1:53
  enhanced-mode: fake-ip
  nameserver:
    - 223.5.5.5
  proxy-server-nameserver:
    - https://154.26.184.249/dns-query

proxies:
  - name: "新加坡｜IEPL专线"
    type: anytls
    server: 1.2.3.4
    port: 443
  - name: "台湾｜高速-家宽"
    type: anytls
    server: 2.3.4.5
    port: 443
  - name: "日本｜专线"
    type: tuic
    server: 3.4.5.6
    port: 8443

proxy-groups:
  - name: "PROXIES"
    type: select
    proxies:
      - "新加坡｜IEPL专线"
      - "台湾｜高速-家宽"

rules:
  - GEOIP,CN,DIRECT
  - MATCH,PROXIES
`;

test("isLikelyMihomoConfig correctly identifies Clash/Mihomo YAML configs", () => {
  assert.equal(isLikelyMihomoConfig(sampleSourceYaml), true);
  assert.equal(isLikelyMihomoConfig("invalid text"), false);
  assert.equal(isLikelyMihomoConfig(""), false);
});

test("parseMihomoSource parses valid YAML into document", () => {
  const doc = parseMihomoSource(sampleSourceYaml);
  assert.ok(doc);
  assert.equal(doc.get("mode"), "rule");
  assert.equal(doc.get("proxies").items.length, 3);
});

test("extractProxyCatalog extracts node metadata for UI display", () => {
  const doc = parseMihomoSource(sampleSourceYaml);
  const catalog = extractProxyCatalog(doc);
  assert.equal(catalog.length, 3);
  assert.equal(catalog[0].name, "新加坡｜IEPL专线");
  assert.equal(catalog[1].name, "台湾｜高速-家宽");
  assert.equal(catalog[2].name, "日本｜专线");
});

test("validatePlanReferences strictly rejects missing nodes without fuzzy fallback", () => {
  const doc = parseMihomoSource(sampleSourceYaml);
  const validPlan = [
    { port: 7892, proxyName: "新加坡｜IEPL专线" },
    { port: 7893, proxyName: "台湾｜高速-家宽" },
  ];
  assert.doesNotThrow(() => validatePlanReferences(doc, validPlan));

  const invalidPlan = [
    { port: 7892, proxyName: "不存在的节点" },
  ];
  assert.throws(() => validatePlanReferences(doc, invalidPlan), /严格安全拦截/);
});

test("compileMihomoConfig produces valid overlay config with preserved source rules & DNS", () => {
  const egressPlan = [
    { port: 7892, proxyName: "台湾｜高速-家宽" },
    { port: 7893, proxyName: "新加坡｜IEPL专线" },
    {
      port: 7894,
      proxyName: "ABC · 专属单节点 #1",
      sourceProxy: {
        name: "ABC · 专属单节点 #1",
        type: "socks5",
        server: "149.119.169.69",
        port: 443,
        username: "user1",
        password: "pass1",
        "dialer-proxy": "新加坡｜IEPL专线",
      },
    },
  ];

  const result = compileMihomoConfig({
    sourceText: sampleSourceYaml,
    egressPlan,
    controllerPort: 19090,
    secret: "test-secret-456",
    singaporeRelayName: "新加坡｜IEPL专线",
  });

  assert.ok(result.compiledText);
  assert.ok(result.configHash);
  assert.deepEqual(result.expectedPorts, [7892, 7893, 7894]);

  // 验证重新解析后的结构
  const compiledDoc = parseMihomoSource(result.compiledText);
  assert.equal(compiledDoc.get("external-controller"), "127.0.0.1:19090");
  assert.equal(compiledDoc.get("secret"), "test-secret-456");
  assert.equal(compiledDoc.get("allow-lan"), false);
  assert.equal(compiledDoc.get("bind-address"), "127.0.0.1");

  // 验证 DNS 和 rules 依然完整保留
  assert.ok(compiledDoc.get("dns"));
  assert.ok(compiledDoc.get("rules"));
  assert.equal(compiledDoc.get("rules").items.length, 2);

  // 验证 listeners 注入
  const listeners = compiledDoc.get("listeners").toJSON();
  assert.equal(listeners.length, 3);
  assert.equal(listeners[0].port, 7892);
  assert.equal(listeners[0].proxy, "台湾｜高速-家宽");
  assert.equal(listeners[1].port, 7893);
  assert.equal(listeners[1].proxy, "新加坡｜IEPL专线");
  assert.equal(listeners[2].port, 7894);
  assert.equal(listeners[2].proxy, "ABC · 专属单节点 #1");

  // 验证自定义代理注入
  const proxies = compiledDoc.get("proxies").toJSON();
  const custom = proxies.find((p) => p.name === "ABC · 专属单节点 #1");
  assert.ok(custom);
  assert.equal(custom["dialer-proxy"], "新加坡｜IEPL专线");
});
