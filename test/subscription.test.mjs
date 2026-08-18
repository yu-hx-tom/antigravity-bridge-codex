import test from "node:test";
import assert from "node:assert/strict";
import {
  identifyCountry,
  parseCustomIspText,
  isValidWorkingNode,
  parseClashYamlProxies,
  parseSubscriptionContent,
  tagAndScoreNode,
  pickRecommendedNodes,
  buildMultiPortEgressPlan,
  buildPlanFromSelectedNodes,
  createXiyouOverrideScript,
  extractSubscriptionUrlsFromPreferences,
  selectSingaporeRelay,
  findActivatedEgress,
} from "../subscription.mjs";

test("extractSubscriptionUrlsFromPreferences prefers the active Xiyou profile", () => {
  const inner = {
    currentProfileId: "active",
    profiles: [
      { id: "old", url: "https://example.com/old" },
      { id: "active", url: "https://example.com/current" },
      { id: "duplicate", url: "https://example.com/old" },
    ],
  };
  const raw = JSON.stringify({ "flutter.config": JSON.stringify(inner) });
  assert.deepEqual(extractSubscriptionUrlsFromPreferences(raw), [
    "https://example.com/current",
    "https://example.com/old",
  ]);
});

test("identifyCountry recognizes regions correctly and excludes Hong Kong", () => {
  assert.equal(identifyCountry("新加坡｜IEPL专线").region, "新加坡");
  assert.equal(identifyCountry("台湾｜高速-家宽").region, "台湾");
  assert.equal(identifyCountry("日本1｜高速").region, "日本");
  assert.equal(identifyCountry("美国｜精品专线").region, "美国");
  
  const hk = identifyCountry("香港｜IEPL专线");
  assert.equal(hk.region, "香港");
  assert.equal(hk.isSupported, false); // 香港受限
});

test("parseCustomIspText parses standard IP:Port:User:Pass text", () => {
  const isp = parseCustomIspText("203.0.113.10:443:test-user:test-pass");
  assert.ok(isp);
  assert.equal(isp.server, "203.0.113.10");
  assert.equal(isp.port, 443);
  assert.equal(isp.username, "test-user");
  assert.equal(isp.password, "test-pass");
  assert.equal(isp.type, "socks5");
});

test("isValidWorkingNode filters out traffic and expiration notices", () => {
  assert.equal(isValidWorkingNode("剩余流量：100G"), false);
  assert.equal(isValidWorkingNode("到期时间：2026-12-31"), false);
  assert.equal(isValidWorkingNode("台湾｜高速-家宽"), true);
});

test("parseClashYamlProxies parses both inline and multi-line indented YAML properly", () => {
  const yamlSample = `
port: 7890
proxies:
  - name: "新加坡｜IEPL专线"
    type: ss
    server: sg.example.com
    port: 443
  - name: 台湾｜高速-家宽
    type: trojan
    server: tw.example.com
    port: 443
  - name: 美国｜精品专线
    type: vmess
    server: us.example.com
    port: 8443
  - name: 香港｜IEPL专线
    type: ss
    server: hk.example.com
    port: 443
  - name: "到期时间：2026"
    type: ss
    server: 127.0.0.1
    port: 443
proxy-groups:
  - name: PROXY
`;
  const nodes = parseClashYamlProxies(yamlSample);
  assert.equal(nodes.length, 4); // 新加坡 + 台湾 + 美国 + 香港 (排除到期时间)
  assert.equal(nodes[0].name, "新加坡｜IEPL专线");
  assert.equal(nodes[0].server, "sg.example.com");
  assert.equal(nodes[0].port, 443);
  assert.equal(nodes[1].name, "台湾｜高速-家宽");
  assert.equal(nodes[2].name, "美国｜精品专线");
});

test("buildMultiPortEgressPlan creates structured port assignments with multiple custom nodes", () => {
  const customNodes = [
    { name: "美国住宅1", raw: "203.0.113.10:443:user1:pass1" },
    { name: "美国住宅2", raw: "203.0.113.11:443:user2:pass2" }
  ];
  const nodes = [
    { id: "1", name: "新加坡｜IEPL专线", protocol: "ANYTLS", country: "🇸🇬", region: "新加坡", isSupported: true },
    { id: "2", name: "台湾｜高速-家宽", protocol: "ANYTLS", country: "🇹🇼", region: "台湾", isSupported: true },
    { id: "3", name: "日本1｜高速", protocol: "ANYTLS", country: "🇯🇵", region: "日本", isSupported: true },
    { id: "4", name: "香港｜IEPL专线", protocol: "ANYTLS", country: "🇭🇰", region: "香港", isSupported: false },
  ];

  const plan = buildMultiPortEgressPlan({ customNodes, parsedNodes: nodes, startPort: 7892 });
  assert.equal(plan.length, 5); // 2个ISP + 新加坡 + 台湾 + 日本 (香港被排除)
  assert.equal(plan[0].port, 7892);
  assert.equal(plan[1].port, 7893);
  assert.equal(plan[2].port, 7894);
  assert.equal(plan[3].port, 7895);
  assert.equal(plan[4].port, 7896);
  assert.equal(plan[0].sourceProxy["dialer-proxy"], "新加坡｜IEPL专线");
});

test("Xiyou override script binds each Listener to a fixed proxy and chains ISP through Singapore", () => {
  const relay = {
    id: "sg",
    name: "新加坡｜IEPL专线",
    protocol: "ANYTLS",
    country: "🇸🇬",
    region: "新加坡",
    isSupported: true,
  };
  const residential = {
    id: "home-us",
    name: "美国住宅",
    type: "socks5",
    protocol: "SOCKS5",
    server: "203.0.113.10",
    port: 443,
    username: "test-user",
    password: "test-pass",
    country: "🇺🇸",
    region: "美国",
    isCustomIsp: true,
    isSupported: true,
  };

  assert.equal(selectSingaporeRelay([residential, relay]), relay);
  const plan = buildPlanFromSelectedNodes([residential, relay], 7892, { relayNodeName: relay.name });
  const script = createXiyouOverrideScript(plan);
  assert.equal(script.includes("DIRECT"), false);

  const main = new Function(`${script}; return main;`)();
  const config = main({
    proxies: [{ name: relay.name, type: "ss" }],
    listeners: [{ name: "keep-me", type: "mixed", port: 7888 }],
  });
  const customProxy = config.proxies.find((proxy) => proxy.name === "ABC · 美国住宅");
  assert.equal(customProxy["dialer-proxy"], relay.name);
  assert.deepEqual(config.listeners.map((listener) => [listener.name, listener.port, listener.proxy]), [
    ["keep-me", 7888, undefined],
    ["abc-egress-7892", 7892, "ABC · 美国住宅"],
    ["abc-egress-7893", 7893, relay.name],
  ]);
  assert.equal(findActivatedEgress(residential, plan).port, 7892);
  assert.equal(findActivatedEgress({ id: "missing", name: "未激活节点" }, plan), null);
});

test("tagAndScoreNode and pickRecommendedNodes prioritize IPLC and Residential across regions", () => {
  const rawNodes = [
    { id: "1", name: "新加坡｜普通节点", protocol: "ANYTLS", country: "🇸🇬", region: "新加坡", isSupported: true },
    { id: "2", name: "新加坡｜IEPL专线", protocol: "ANYTLS", country: "🇸🇬", region: "新加坡", isSupported: true },
    { id: "3", name: "台湾｜高速-家宽", protocol: "ANYTLS", country: "🇹🇼", region: "台湾", isSupported: true },
    { id: "4", name: "香港｜IEPL专线", protocol: "ANYTLS", country: "🇭🇰", region: "香港", isSupported: false },
    { id: "5", name: "美国｜原生住宅", protocol: "ANYTLS", country: "🇺🇸", region: "美国", isSupported: true },
    { id: "6", name: "日本1｜高速", protocol: "ANYTLS", country: "🇯🇵", region: "日本", isSupported: true },
  ];

  const tagged = rawNodes.map((n) => tagAndScoreNode(n));
  assert.ok(tagged[1].tags.includes("专线"));
  assert.ok(tagged[2].tags.includes("家宽/原生"));
  assert.ok(tagged[4].tags.includes("家宽/原生"));

  const recommended = pickRecommendedNodes(rawNodes, 4);
  const recPicked = recommended.filter((n) => n.recommended);
  assert.equal(recPicked.length, 4);
  // 确认前 4 个元素全为推荐节点（置顶排布）
  assert.equal(recommended[0].recommended, true);
  assert.equal(recommended[1].recommended, true);
  assert.equal(recommended[2].recommended, true);
  assert.equal(recommended[3].recommended, true);
  assert.equal(recommended[4].recommended, false);
  // 香港被排除
  assert.ok(!recPicked.some((n) => n.region === "香港"));
  // 包含台湾家宽与新加坡专线
  assert.ok(recPicked.some((n) => n.id === "2"));
  assert.ok(recPicked.some((n) => n.id === "3"));
});
