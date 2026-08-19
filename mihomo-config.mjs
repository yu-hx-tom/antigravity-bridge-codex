import YAML from "yaml";
import crypto from "node:crypto";

/**
 * 识别是否是合法的 Mihomo/Clash 配置文本
 */
export function isLikelyMihomoConfig(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.includes("proxies:") || (trimmed.includes("proxy-groups:") && trimmed.includes("rules:"));
}

/**
 * 解析源配置文本为 YAML Document
 */
export function parseMihomoSource(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Mihomo source text is empty or not a string");
  }
  try {
    const doc = YAML.parseDocument(rawText);
    if (!doc || doc.errors.length > 0) {
      const errMsgs = doc?.errors?.map((e) => e.message).join("; ") || "Unknown YAML parse error";
      throw new Error(`YAML Document parse error: ${errMsgs}`);
    }
    return doc;
  } catch (err) {
    throw new Error(`Failed to parse Mihomo source config: ${err.message}`);
  }
}

/**
 * 从 YAML Document 中提取用于 UI 展示的节点列表元数据
 */
export function extractProxyCatalog(doc, identifyCountryFn = null) {
  if (!doc) return [];
  const proxiesNode = doc.get("proxies");
  if (!proxiesNode || !Array.isArray(proxiesNode.items || proxiesNode)) return [];

  const rawList = proxiesNode.toJSON ? proxiesNode.toJSON() : (Array.isArray(proxiesNode) ? proxiesNode : proxiesNode.items);
  if (!Array.isArray(rawList)) return [];

  return rawList
    .filter((p) => p && typeof p === "object" && p.name)
    .map((p, idx) => {
      const name = String(p.name || "").trim();
      const type = String(p.type || "unknown").toUpperCase();
      const server = String(p.server || "");
      const port = Number(p.port) || 0;
      const countryInfo = identifyCountryFn ? identifyCountryFn(name) : { flag: "🌐", region: "其他地区", isSupported: true };

      return {
        id: `proxy-${idx + 1}-${crypto.createHash("md5").update(name).digest("hex").slice(0, 8)}`,
        name,
        type: p.type || "unknown",
        protocol: type,
        server,
        port,
        country: countryInfo.flag,
        region: countryInfo.region,
        isSupported: countryInfo.isSupported !== false,
        note: countryInfo.note || "",
      };
    });
}

/**
 * 清除之前由 ABC 注入的受控覆盖项 (abc-egress-* listeners 与 ABC · * custom proxies)
 */
export function removePreviousAbcOverlay(doc) {
  if (!doc) return;

  // 1. 清理 ABC listeners
  const listenersNode = doc.get("listeners");
  if (listenersNode) {
    const rawListeners = listenersNode.toJSON ? listenersNode.toJSON() : (Array.isArray(listenersNode) ? listenersNode : []);
    if (Array.isArray(rawListeners)) {
      const filtered = rawListeners.filter((l) => {
        const name = String(l?.name || "");
        return !name.startsWith("abc-egress-");
      });
      if (filtered.length > 0) {
        doc.set("listeners", filtered);
      } else {
        doc.delete("listeners");
      }
    }
  }

  // 2. 清理 ABC 自定义代理
  const proxiesNode = doc.get("proxies");
  if (proxiesNode) {
    const rawProxies = proxiesNode.toJSON ? proxiesNode.toJSON() : (Array.isArray(proxiesNode) ? proxiesNode : []);
    if (Array.isArray(rawProxies)) {
      const filtered = rawProxies.filter((p) => {
        const name = String(p?.name || "");
        return !name.startsWith("ABC · ") && !name.startsWith("abc-");
      });
      doc.set("proxies", filtered);
    }
  }
}

/**
 * 校验 Egress Plan 中引用的代理节点是否在 Document 中精确存在 (取消模糊与地区回退)
 */
export function validatePlanReferences(doc, egressPlan = []) {
  if (!doc) throw new Error("Document is required for validation");
  const proxiesNode = doc.get("proxies");
  const rawProxies = proxiesNode ? (proxiesNode.toJSON ? proxiesNode.toJSON() : proxiesNode) : [];
  const existingNames = new Set(
    (Array.isArray(rawProxies) ? rawProxies : []).map((p) => p && typeof p === "object" && p.name).filter(Boolean)
  );

  // 也允许 proxy-groups
  const groupsNode = doc.get("proxy-groups");
  const rawGroups = groupsNode ? (groupsNode.toJSON ? groupsNode.toJSON() : groupsNode) : [];
  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (g && g.name) existingNames.add(g.name);
    }
  }

  for (const item of egressPlan) {
    const targetProxy = item.proxyName || item.proxy;
    if (!targetProxy) {
      throw new Error(`端口 ${item.port} 的出口目标节点名称为空`);
    }
    // 如果是自定义住宅节点，它将在下一步注入，允许通过
    if (item.sourceProxy || targetProxy.startsWith("ABC · ")) {
      continue;
    }
    if (!existingNames.has(targetProxy)) {
      throw new Error(
        `[严格安全拦截] 计划中的目标节点 "${targetProxy}" (端口 ${item.port}) 在源配置中不存在。系统已严格禁止模糊替换，请重新选择节点。`
      );
    }
  }
}

/**
 * 注入自定义住宅代理与新加坡链式跳板 (dialer-proxy)
 */
export function injectCustomProxies(doc, customProxies = [], singaporeRelayName = "") {
  if (!doc || !Array.isArray(customProxies) || customProxies.length === 0) return;

  const proxiesNode = doc.get("proxies");
  let list = proxiesNode ? (proxiesNode.toJSON ? proxiesNode.toJSON() : proxiesNode) : [];
  if (!Array.isArray(list)) list = [];

  for (const p of customProxies) {
    if (!p || !p.server || !p.port) continue;
    const name = p.name || `ABC · 专属住宅 (${p.server}:${p.port})`;
    const proxyObj = {
      name,
      type: p.type || "socks5",
      server: p.server,
      port: Number(p.port),
      udp: p.udp !== undefined ? Boolean(p.udp) : true,
      "skip-cert-verify": true,
    };
    if (p.username) proxyObj.username = p.username;
    if (p.password) proxyObj.password = p.password;

    // 挂载跳板
    const relay = p["dialer-proxy"] || singaporeRelayName;
    if (relay) {
      proxyObj["dialer-proxy"] = relay;
    }

    list.push(proxyObj);
  }

  doc.set("proxies", list);

  // 也注入到 proxy-groups 确保客户端兼容
  const groupsNode = doc.get("proxy-groups");
  if (groupsNode) {
    const groups = groupsNode.toJSON ? groupsNode.toJSON() : groupsNode;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (g && Array.isArray(g.proxies)) {
          for (const cp of customProxies) {
            const cpName = cp.name || `ABC · 专属住宅 (${cp.server}:${cp.port})`;
            if (!g.proxies.includes(cpName)) {
              g.proxies.push(cpName);
            }
          }
        }
      }
      doc.set("proxy-groups", groups);
    }
  }
}

/**
 * 注入 ABC 专属 Listeners
 */
export function injectListeners(doc, egressPlan = []) {
  if (!doc || !Array.isArray(egressPlan)) return;

  const existingListenersNode = doc.get("listeners");
  let listeners = existingListenersNode ? (existingListenersNode.toJSON ? existingListenersNode.toJSON() : existingListenersNode) : [];
  if (!Array.isArray(listeners)) listeners = [];

  // 清除旧的 abc-egress-*
  listeners = listeners.filter((l) => !String(l?.name || "").startsWith("abc-egress-"));

  for (const item of egressPlan) {
    const port = Number(item.port);
    const proxyName = item.proxyName || item.proxy;
    if (!port || !proxyName) continue;

    listeners.push({
      name: `abc-egress-${port}`,
      type: "mixed",
      port,
      listen: "127.0.0.1",
      udp: false,
      proxy: proxyName,
    });
  }

  doc.set("listeners", listeners);
}

/**
 * 注入安全运行时配置 (只在 127.0.0.1 监听，关闭 tun，配置 controller)
 */
export function injectRuntimeSecurity(doc, { controllerPort = 19090, secret = "" } = {}) {
  if (!doc) return;

  doc.set("allow-lan", false);
  doc.set("bind-address", "127.0.0.1");
  doc.set("external-controller", `127.0.0.1:${controllerPort}`);
  doc.set("secret", String(secret || ""));

  // 保证 tun 绝对关闭
  const tunObj = { enable: false };
  doc.set("tun", tunObj);

  // 保证 mode 存在
  if (!doc.has("mode")) doc.set("mode", "rule");
  if (!doc.has("log-level")) doc.set("log-level", "info");
}

/**
 * 计算配置内容的 SHA-256 Hash
 */
export function computeConfigHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

/**
 * 主编译函数：以完整源配置为 Source of Truth，注入 ABC 受控 Overlay
 */
export function compileMihomoConfig({
  sourceText,
  egressPlan = [],
  controllerPort = 19090,
  secret = "",
  customProxies = [],
  singaporeRelayName = "",
} = {}) {
  if (!sourceText || typeof sourceText !== "string") {
    throw new Error("Cannot compile Mihomo config: sourceText is missing");
  }

  const doc = parseMihomoSource(sourceText);

  // 1. 清理旧的 ABC 覆盖项
  removePreviousAbcOverlay(doc);

  // 2. 注入自定义住宅代理
  const allCustomProxies = [...customProxies];
  for (const item of egressPlan) {
    if (item.sourceProxy && !allCustomProxies.some((p) => p.name === item.sourceProxy.name)) {
      allCustomProxies.push(item.sourceProxy);
    }
  }
  injectCustomProxies(doc, allCustomProxies, singaporeRelayName);

  // 3. 校验所有 Plan 节点引用是否存在（精确匹配，禁止模糊与地区回退）
  validatePlanReferences(doc, egressPlan);

  // 4. 注入 ABC Listeners
  injectListeners(doc, egressPlan);

  // 5. 注入安全隔离与 Controller
  injectRuntimeSecurity(doc, { controllerPort, secret });

  const compiledText = doc.toString();
  const configHash = computeConfigHash(compiledText);

  return {
    compiledText,
    configHash,
    expectedPorts: egressPlan.map((p) => Number(p.port)),
  };
}
