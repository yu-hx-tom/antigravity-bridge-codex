import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * 国家国旗与地区名称识别（精准匹配地区与排除受限地区）
 */
export function identifyCountry(nodeName) {
  const name = String(nodeName || "").toUpperCase();

  // 1. 优先检测受限制地区（香港、中国大陆、俄罗斯、伊朗）
  if (name.includes("香港") || name.includes("HONG KONG") || /\bHK\b/.test(name) || name.includes("HK-") || name.includes("HK_") || name.includes("HK｜")) {
    return { flag: "🇭🇰", region: "香港", isSupported: false, note: "Google AI 官方受限地区" };
  }
  if (name.includes("中国") || name.includes("大陆") || name.includes("CHINA") || /\bCN\b/.test(name) || name.includes("国内")) {
    return { flag: "🇨🇳", region: "中国大陆", isSupported: false, note: "国内直连节点" };
  }
  if (name.includes("俄罗斯") || name.includes("RUSSIA") || /\bRU\b/.test(name)) {
    return { flag: "🇷🇺", region: "俄罗斯", isSupported: false, note: "受限地区" };
  }

  // 2. 支持的国家与地区匹配
  if (name.includes("新加坡") || name.includes("SINGAPORE") || /\bSG\b/.test(name) || name.includes("狮城")) {
    return { flag: "🇸🇬", region: "新加坡", isSupported: true };
  }
  if (name.includes("台湾") || name.includes("TAIWAN") || /\bTW\b/.test(name) || name.includes("台北") || name.includes("新北")) {
    return { flag: "🇹🇼", region: "台湾", isSupported: true };
  }
  if (name.includes("日本") || name.includes("JAPAN") || /\bJP\b/.test(name) || name.includes("东京") || name.includes("大阪")) {
    return { flag: "🇯🇵", region: "日本", isSupported: true };
  }
  if (name.includes("美国") || name.includes("UNITED STATES") || /\bUS\b/.test(name) || name.includes("USA") || name.includes("纽约") || name.includes("洛杉矶") || name.includes("硅谷")) {
    return { flag: "🇺🇸", region: "美国", isSupported: true };
  }
  if (name.includes("韩国") || name.includes("KOREA") || /\bKR\b/.test(name) || name.includes("首尔")) {
    return { flag: "🇰🇷", region: "韩国", isSupported: true };
  }
  if (name.includes("英国") || name.includes("UNITED KINGDOM") || /\bUK\b/.test(name) || /\bGB\b/.test(name) || name.includes("伦敦")) {
    return { flag: "🇬🇧", region: "英国", isSupported: true };
  }
  if (name.includes("德国") || name.includes("GERMANY") || /\bDE\b/.test(name) || name.includes("法兰克福") || name.includes("柏林")) {
    return { flag: "🇩🇪", region: "德国", isSupported: true };
  }
  if (name.includes("法国") || name.includes("FRANCE") || /\bFR\b/.test(name) || name.includes("巴黎")) {
    return { flag: "🇫🇷", region: "法国", isSupported: true };
  }
  if (name.includes("加拿大") || name.includes("CANADA") || /\bCA\b/.test(name)) {
    return { flag: "🇨🇦", region: "加拿大", isSupported: true };
  }
  if (name.includes("澳大利亚") || name.includes("澳洲") || name.includes("AUSTRALIA") || /\bAU\b/.test(name) || name.includes("悉尼")) {
    return { flag: "🇦🇺", region: "澳大利亚", isSupported: true };
  }

  return { flag: "🌐", region: "其他地区", isSupported: true };
}

/**
 * 扫描本地所有 Clash / Follow / 西游云 / Clash Verge 的 profile 配置文件
 */
export function scanLocalClashProfiles() {
  const dirs = [
    path.join(os.homedir(), "AppData", "Roaming", "com.follow", "clash", "profiles"),
    path.join(os.homedir(), "AppData", "Roaming", "com.appshub", "XiyouYun", "profiles"),
    path.join(os.homedir(), "AppData", "Roaming", "Clash for Windows", "profiles"),
    path.join(os.homedir(), "AppData", "Roaming", "Clash Verge", "profiles"),
    path.join(os.homedir(), "AppData", "Roaming", "clash-verge", "profiles"),
    path.join(os.homedir(), "AppData", "Roaming", "clash-nyanpasu", "profiles"),
    path.join(os.homedir(), ".config", "clash", "profiles"),
  ];

  let bestNodes = [];

  for (const d of dirs) {
    if (fsSync.existsSync(d)) {
      try {
        const files = fsSync.readdirSync(d);
        for (const f of files) {
          if (f.endsWith(".yaml")) {
            try {
              const content = fsSync.readFileSync(path.join(d, f), "utf8");
              const parsed = parseSubscriptionContent(content);
              if (parsed.length > bestNodes.length) {
                bestNodes = parsed;
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  return bestNodes;
}

export function extractSubscriptionUrlsFromPreferences(rawText) {
  try {
    const outer = JSON.parse(String(rawText || ""));
    const innerRaw = outer["flutter.config"];
    const inner = typeof innerRaw === "string" ? JSON.parse(innerRaw) : innerRaw;
    const profiles = [...(inner?.profiles || [])];
    const currentProfileId = String(inner?.currentProfileId || inner?.currentProfile || "");
    profiles.sort((a, b) => Number(String(b?.id || "") === currentProfileId) - Number(String(a?.id || "") === currentProfileId));
    const urls = profiles
      .map((profile) => String(profile?.url || "").trim())
      .filter((url) => /^https?:\/\//i.test(url));
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

export function scanLocalSubscriptionUrls() {
  const files = [
    path.join(os.homedir(), "AppData", "Roaming", "com.appshub", "XiyouYun", "shared_preferences.json"),
    path.join(os.homedir(), "AppData", "Roaming", "com.follow", "clash", "shared_preferences.json"),
  ];
  const urls = [];
  for (const file of files) {
    try {
      urls.push(...extractSubscriptionUrlsFromPreferences(fsSync.readFileSync(file, "utf8")));
    } catch {}
  }
  return [...new Set(urls)];
}

/**
 * 解析单个自定义节点（支持 IP:Port:User:Pass、IP:Port 以及标准 URL 格式）
 */
export function parseSingleCustomNode(rawText, customName = "") {
  if (!rawText) return null;
  const text = String(rawText).trim();

  // 1. 如果是 URL 格式 (socks5://..., http://..., trojan://..., ss://...)
  if (/^[a-zA-Z0-9_-]+:\/\//.test(text)) {
    try {
      const url = new URL(text);
      const protocol = url.protocol.replace(":", "").toLowerCase();
      const server = url.hostname;
      const port = parseInt(url.port, 10) || (protocol === "http" ? 80 : 1080);
      const username = decodeURIComponent(url.username || "");
      const password = decodeURIComponent(url.password || "");
      const name = customName || decodeURIComponent(url.hash.replace(/^#/, "")) || `自定义节点 (${server}:${port})`;
      const country = identifyCountry(name);

      return {
        id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        name,
        type: protocol,
        protocol: protocol.toUpperCase(),
        server,
        port,
        username,
        password,
        country: country.flag,
        region: country.region,
        udp: true,
        "skip-cert-verify": true,
        isCustomIsp: true,
        isSupported: true,
      };
    } catch {}
  }

  // 2. 如果是标准的 IP:Port:User:Pass 或 IP:Port
  const parts = text.split(":");
  if (parts.length >= 2) {
    const server = parts[0].trim();
    const port = parseInt(parts[1].trim(), 10);
    if (!server || isNaN(port) || port <= 0 || port > 65535) return null;

    const username = parts[2]?.trim() || "";
    const password = parts[3]?.trim() || "";
    const name = customName || `专属静态住宅 (${server}:${port})`;
    const country = identifyCountry(name);

    return {
      id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name,
      type: "socks5",
      protocol: "SOCKS5",
      server,
      port,
      username,
      password,
      country: country.flag,
      region: country.region,
      udp: true,
      "skip-cert-verify": true,
      isCustomIsp: true,
      isSupported: true,
    };
  }
  return null;
}

/**
 * 解析多个自定义单节点输入
 */
export function parseCustomNodesList(customNodesOrText) {
  const result = [];
  if (!customNodesOrText) return result;

  if (Array.isArray(customNodesOrText)) {
    for (const item of customNodesOrText) {
      if (!item) continue;
      if (typeof item === "object") {
        if (item.server && item.port) {
          const name = item.name || `自定义节点 (${item.server}:${item.port})`;
          const country = identifyCountry(name);
          result.push({
            id: item.id || `custom-${result.length + 1}`,
            name,
            type: item.type || "socks5",
            protocol: (item.type || "SOCKS5").toUpperCase(),
            server: item.server,
            port: Number(item.port),
            username: item.username || "",
            password: item.password || "",
            country: country.flag,
            region: country.region,
            udp: true,
            "skip-cert-verify": true,
            isCustomIsp: true,
            isSupported: true,
          });
        } else if (item.raw) {
          const parsed = parseSingleCustomNode(item.raw, item.name);
          if (parsed) result.push(parsed);
        }
      } else if (typeof item === "string") {
        const parsed = parseSingleCustomNode(item);
        if (parsed) result.push(parsed);
      }
    }
    return result;
  }

  const lines = String(customNodesOrText).split(/[\r\n,]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      const parsed = parseSingleCustomNode(trimmed);
      if (parsed) result.push(parsed);
    }
  }
  return result;
}

/**
 * 兼容旧版的单行住宅 ISP 解析
 */
export function parseCustomIspText(rawText) {
  const list = parseCustomNodesList(rawText);
  return list.length > 0 ? list[0] : null;
}

/**
 * 过滤无效的宣传/流量节点
 */
export function isValidWorkingNode(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  const invalidKeywords = [
    "流量", "到期", "官网", "网址", "重置", "通知", "群", "公告",
    "expire", "traffic", "reset", "channel", "group", "website"
  ];
  return !invalidKeywords.some((k) => lower.includes(k));
}

/**
 * 从 YAML 文本中解析 Clash proxies 列表 (支持标准多行缩进 YAML 以及单行 JSON 风格 YAML)
 */
export function parseClashYamlProxies(yamlContent) {
  const nodes = [];
  if (!yamlContent) return nodes;

  // 1. 尝试基于 '  - ' 分割 proxies 块进行健壮的多行解析
  const lines = yamlContent.split(/\r?\n/);
  let inProxies = false;
  let currentBlock = null;

  const flushBlock = (blk) => {
    if (!blk) return;
    let name = "";
    const quotedName = blk.match(/name:\s*['"]([^'"]+)['"]/i);
    if (quotedName) {
      name = quotedName[1].trim();
    } else {
      const unquotedName = blk.match(/name:\s*([^,'"\r\n{}]+)/i);
      if (unquotedName) name = unquotedName[1].trim();
    }

    const typeMatch = blk.match(/type:\s*['"]?([^,'"\r\n\s{}]+)['"]?/i);
    const serverMatch = blk.match(/server:\s*['"]?([^,'"\r\n\s{}]+)['"]?/i);
    const portMatch = blk.match(/port:\s*['"]?(\d+)['"]?/i);

    if (name) {
      const protocol = (typeMatch ? typeMatch[1].trim() : "HTTP").toUpperCase();
      const server = serverMatch ? serverMatch[1].trim() : "";
      const port = portMatch ? parseInt(portMatch[1].trim(), 10) : 443;

      if (isValidWorkingNode(name) && !nodes.some((n) => n.name === name)) {
        const country = identifyCountry(name);
        nodes.push({
          id: `node-${nodes.length + 1}`,
          name,
          protocol,
          server,
          port,
          country: country.flag,
          region: country.region,
          isSupported: country.isSupported,
          note: country.note || "",
        });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (/^proxies\s*:/i.test(trimmed)) {
      inProxies = true;
      continue;
    }

    if (inProxies) {
      // 如果遇到顶级的其他 key (如 proxy-groups:, rules: 等)，退出 proxies 解析
      if (/^[a-zA-Z0-9_-]+\s*:/i.test(trimmed) && !trimmed.startsWith("-") && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        inProxies = false;
        if (currentBlock) { flushBlock(currentBlock); currentBlock = null; }
        continue;
      }

      if (trimmed.startsWith("-")) {
        if (currentBlock) {
          flushBlock(currentBlock);
        }
        currentBlock = trimmed.substring(1).trim();
      } else if (currentBlock) {
        currentBlock += "\n" + trimmed;
      }
    }
  }
  if (currentBlock) {
    flushBlock(currentBlock);
  }

  // 2. 如果多行解析未抓取到（例如没有 proxies: 顶层标签），使用正则全局扫捕
  if (nodes.length === 0) {
    const matches = [...yamlContent.matchAll(/name:\s*['"]?([^,'"\n]+)['"]?/gm)];
    for (const m of matches) {
      const name = m[1].trim();
      if (isValidWorkingNode(name) && !nodes.some((n) => n.name === name)) {
        const country = identifyCountry(name);
        nodes.push({
          id: `node-${nodes.length + 1}`,
          name,
          protocol: "ANYTLS",
          country: country.flag,
          region: country.region,
          isSupported: country.isSupported,
          note: country.note || "",
        });
      }
    }
  }

  return nodes;
}

/**
 * 从 Base64 订阅文本中解析节点 (支持 vmess://, vless://, trojan://, ss://, hysteria2://, tuic://)
 */
export function parseBase64Subscription(rawText) {
  const nodes = [];
  try {
    let decoded = "";
    try {
      decoded = Buffer.from(rawText.trim(), "base64").toString("utf8");
    } catch {
      decoded = rawText;
    }

    const lines = decoded.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        if (line.startsWith("vmess://")) {
          const jsonStr = Buffer.from(line.slice(8), "base64").toString("utf8");
          const v = JSON.parse(jsonStr);
          const name = v.ps || v.add || "VMess节点";
          const server = v.add || "";
          const port = parseInt(v.port, 10) || 443;
          if (isValidWorkingNode(name) && !nodes.some((n) => n.name === name)) {
            const country = identifyCountry(name);
            nodes.push({ id: `node-${nodes.length + 1}`, name, protocol: "VMESS", server, port, country: country.flag, region: country.region, isSupported: country.isSupported });
          }
        } else if (line.startsWith("vless://") || line.startsWith("trojan://") || line.startsWith("ss://") || line.startsWith("hysteria2://") || line.startsWith("hy2://") || line.startsWith("tuic://")) {
          const url = new URL(line);
          const name = decodeURIComponent(url.hash?.replace(/^#/, "") || url.hostname || "专线节点");
          const protocol = line.split("://")[0].toUpperCase();
          const server = url.hostname || "";
          const port = parseInt(url.port, 10) || 443;
          if (isValidWorkingNode(name) && !nodes.some((n) => n.name === name)) {
            const country = identifyCountry(name);
            nodes.push({ id: `node-${nodes.length + 1}`, name, protocol, server, port, country: country.flag, region: country.region, isSupported: country.isSupported });
          }
        }
      } catch {}
    }
  } catch {}
  return nodes;
}

/**
 * 从订阅 URL 拉取并自动识别解析节点
 */
export function parseSubscriptionContent(content) {
  if (!content) return [];
  // 先尝试作为 Clash YAML 解析
  if (content.includes("proxies:") || content.includes("name:") || content.includes("server:")) {
    const yamlNodes = parseClashYamlProxies(content);
    if (yamlNodes.length > 0) return yamlNodes;
  }
  // 再尝试作为 Base64 订阅解析
  return parseBase64Subscription(content);
}

/**
 * 为节点打上质量标签（专线、家宽、高速等）并计算推荐权重
 */
export function tagAndScoreNode(node) {
  const name = String(node.name || "").toUpperCase();
  const tags = [];
  let score = 50;

  if (node.isCustomIsp) {
    tags.push("静态住宅");
    score += 1000;
  }
  if (name.includes("IPLC") || name.includes("IEPL") || name.includes("专线") || name.includes("DIRECT")) {
    tags.push("专线");
    score += 100;
  }
  if (name.includes("家宽") || name.includes("住宅") || name.includes("RESIDENTIAL") || name.includes("原生") || name.includes("ISP")) {
    tags.push("家宽/原生");
    score += 80;
  }
  if (name.includes("BGP") || name.includes("高速") || name.includes("HYPER") || name.includes("PRO")) {
    tags.push("高速");
    score += 40;
  }
  if (name.includes("0.1X") || name.includes("0.2X") || name.includes("0.5X")) {
    tags.push("低倍率");
  }

  if (node.region === "台湾" || node.region === "新加坡") score += 30;
  else if (node.region === "日本" || node.region === "美国") score += 20;

  return {
    ...node,
    tags: tags.length > 0 ? tags : ["标准节点"],
    score,
  };
}

/**
 * 智能筛选并优选 Top 5 节点 (排除不支持地区，跨地区分散挑选)
 */
export function pickRecommendedNodes(nodes, maxCount = 5) {
  const supported = nodes.filter((n) => n.isSupported !== false);
  const scored = supported.map((n) => tagAndScoreNode(n));

  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  const pickedRegions = new Map();

  for (const n of scored) {
    if (n.isCustomIsp && picked.length < maxCount) {
      picked.push(n);
      pickedRegions.set(n.region, (pickedRegions.get(n.region) || 0) + 1);
    }
  }

  for (const n of scored) {
    if (picked.length >= maxCount) break;
    if (picked.some((p) => p.id === n.id)) continue;
    const countInRegion = pickedRegions.get(n.region) || 0;
    if (countInRegion === 0) {
      picked.push(n);
      pickedRegions.set(n.region, countInRegion + 1);
    }
  }

  for (const n of scored) {
    if (picked.length >= maxCount) break;
    if (!picked.some((p) => p.id === n.id)) {
      picked.push(n);
    }
  }

  const pickedIds = new Set(picked.map((p) => p.id));
  const recList = picked.map((n) => ({ ...n, recommended: true }));
  const otherList = scored
    .filter((n) => !pickedIds.has(n.id))
    .map((n) => ({ ...n, recommended: false }));

  return [...recList, ...otherList];
}

/**
 * 计算节点的唯一稳定身份指纹 (SHA-256 截断前 16 位)
 */
export function computeNodeFingerprint(node) {
  const proto = String(node?.protocol || node?.type || "").trim().toLowerCase();
  const name = String(node?.name || "").trim().toLowerCase();
  const server = String(node?.server || "").trim().toLowerCase();
  const port = Number(node?.port) || 0;
  const raw = `${proto}:${name}:${server}:${port}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * 严格寻找新加坡 IEPL/专线 跳板节点 (找不到时返回 null，绝不偷偷替换为其他国家)
 */
export function selectSingaporeRelay(nodes = []) {
  const candidates = nodes.filter((node) => !node.isCustomIsp && node.isSupported !== false);
  return candidates.find((node) => /新加坡|SINGAPORE|\bSG\b/i.test(node.name || "") && /IEPL|IPLC|专线/i.test(node.name || ""))
    || candidates.find((node) => /新加坡|SINGAPORE|\bSG\b/i.test(node.name || ""))
    || null;
}

/**
 * 根据选中的节点构建独立端口通道表 (支持稳定端口复用)
 */
export function buildPlanFromSelectedNodes(selectedNodes = [], startPort = 7892, { relayNodeName = "", previousPlan = [] } = {}) {
  const prevPortByFp = new Map();
  for (const prev of previousPlan) {
    if (prev && prev.fingerprint && prev.port) {
      prevPortByFp.set(prev.fingerprint, Number(prev.port));
    }
  }

  const usedPorts = new Set();
  const usedProxyNames = new Map();

  // 1. 第一轮：已存在稳定指纹的节点优先复用原来的端口
  const portAssignments = new Array(selectedNodes.length).fill(0);
  for (let i = 0; i < selectedNodes.length; i++) {
    const node = selectedNodes[i];
    const fp = computeNodeFingerprint(node);
    if (prevPortByFp.has(fp)) {
      const p = prevPortByFp.get(fp);
      if (!usedPorts.has(p)) {
        portAssignments[i] = p;
        usedPorts.add(p);
      }
    }
  }

  // 2. 第二轮：新节点分配下一个空闲端口
  let candidatePort = startPort;
  for (let i = 0; i < selectedNodes.length; i++) {
    if (portAssignments[i] === 0) {
      while (usedPorts.has(candidatePort)) {
        candidatePort++;
      }
      portAssignments[i] = candidatePort;
      usedPorts.add(candidatePort);
    }
  }

  // 3. 构建完整的 Egress Channel 对象
  return selectedNodes.map((n, idx) => {
    const listenerPort = portAssignments[idx];
    const isCustomIsp = Boolean(n.isCustomIsp);
    const fingerprint = computeNodeFingerprint(n);
    const baseName = String(n.name || `节点 ${listenerPort}`).trim();
    const duplicateIndex = (usedProxyNames.get(baseName) || 0) + 1;
    usedProxyNames.set(baseName, duplicateIndex);
    const uniqueName = duplicateIndex === 1 ? baseName : `${baseName} #${duplicateIndex}`;
    const proxyName = isCustomIsp ? `ABC · ${uniqueName}` : uniqueName;
    const remotePort = Number(n.port) || 0;

    return {
      id: `egress-${n.id || fingerprint || listenerPort}`,
      egressId: fingerprint,
      fingerprint,
      name: uniqueName,
      proxyName,
      protocol: n.protocol || String(n.type || "HTTP").toUpperCase(),
      country: n.country || "🌐",
      region: n.region || "其他地区",
      port: listenerPort,
      entryHost: n.server || "",
      entryPort: remotePort,
      relayNodeName: isCustomIsp ? relayNodeName : "",
      desc: isCustomIsp
        ? `${n.region || ""}住宅落地 · 经 ${relayNodeName || "未配置跳板"} 中转`
        : `${n.region || ""}${n.tags && n.tags.length ? ` (${n.tags.join("/")})` : "专线出口"}`,
      display: `[${n.protocol || "HTTP"}] ${n.country || "🌐"} ${uniqueName} [端口 ${listenerPort}]`,
      isCustomIsp,
      isSupported: true,
      sourceProxy: isCustomIsp ? {
        name: proxyName,
        type: String(n.type || "socks5").toLowerCase(),
        server: String(n.server || ""),
        port: remotePort,
        username: String(n.username || ""),
        password: String(n.password || ""),
        udp: Boolean(n.udp),
        "skip-cert-verify": Boolean(n["skip-cert-verify"]),
        "dialer-proxy": relayNodeName || undefined,
      } : null,
    };
  });
}

export function findActivatedEgress(node, egressPlan = []) {
  const nodeId = String(node?.id || "");
  const nodeName = String(node?.name || "");
  const fp = node ? computeNodeFingerprint(node) : "";
  return egressPlan.find((item) => Number(item?.port) > 0 && (
    (fp && (item.fingerprint === fp || item.egressId === fp))
    || (nodeId && (item.id === nodeId || item.id === `egress-${nodeId}`))
    || (nodeName && (item.name === nodeName || item.proxyName === nodeName))
  )) || null;
}

/**
 * 严格按照西游云 (FlClash) 现有格式生成覆写脚本
 */
export function createXiyouOverrideScript(egressPlan = []) {
  const customProxies = egressPlan.map((item) => item.sourceProxy).filter(Boolean);
  const listeners = egressPlan.map((item) => ({
    name: `abc-egress-${item.port}`,
    type: "mixed",
    port: Number(item.port),
    listen: "127.0.0.1",
    udp: false,
    proxy: item.proxyName,
    region: item.region || "",
  }));

  return `function main(config) {
  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.listeners = Array.isArray(config.listeners) ? config.listeners : [];

  const customProxies = ${JSON.stringify(customProxies)};
  const desiredListeners = ${JSON.stringify(listeners)};
  const managedProxyNames = new Set(customProxies.map(proxy => proxy.name));

  // 1. 注入自定义代理 (如带严格新加坡专线链式中转的静态 ISP)
  config.proxies = config.proxies.filter(proxy => !proxy || !managedProxyNames.has(proxy.name));
  const baseProxyNames = new Set(config.proxies.map(proxy => proxy && proxy.name).filter(Boolean));
  for (const proxy of customProxies) {
    if (proxy["dialer-proxy"] && !baseProxyNames.has(proxy["dialer-proxy"])) {
      // 严格检查：必须能匹配到明确的新加坡跳板节点
      const matchedSg = config.proxies.find(p => p && p.name && (p.name.includes("新加坡") || p.name.includes("IEPL")));
      if (matchedSg) proxy["dialer-proxy"] = matchedSg.name;
    }
    config.proxies.push(proxy);
  }

  // 2. 辅助函数：智能精准匹配目标节点名称
  function matchProxyName(targetName, targetRegion) {
    if (!targetName) return null;
    const exact = config.proxies.find(p => p && p.name === targetName);
    if (exact) return exact.name;

    const trimmed = targetName.trim().toLowerCase();
    const matchTrimmed = config.proxies.find(p => p && p.name && p.name.trim().toLowerCase() === trimmed);
    if (matchTrimmed) return matchTrimmed.name;

    const normTarget = targetName.replace(/[\\s\\-_｜|#\\d]/g, "");
    const matchFuzzy = config.proxies.find(p => {
      if (!p || !p.name) return false;
      const normP = p.name.replace(/[\\s\\-_｜|#\\d]/g, "");
      return normP.includes(normTarget) || normTarget.includes(normP);
    });
    if (matchFuzzy) return matchFuzzy.name;

    if (targetRegion) {
      const matchRegion = config.proxies.find(p => p && p.name && p.name.includes(targetRegion));
      if (matchRegion) return matchRegion.name;
    }

    return null;
  }

  // 3. 清除所有历史遗留 Listener (包括 abc-egress-*, mixed-*, port-*)
  config.listeners = config.listeners.filter(listener => {
    const lName = String(listener && listener.name || "");
    return !lName.startsWith("abc-egress-") && !lName.startsWith("mixed-") && !lName.startsWith("port-");
  });

  // 4. 为每个独立端口精准绑定对应的节点出口！
  for (const item of desiredListeners) {
    const boundProxy = matchProxyName(item.proxy, item.region);
    if (boundProxy) {
      config.listeners.push({
        name: item.name,
        type: "mixed",
        port: Number(item.port),
        listen: "127.0.0.1",
        udp: false,
        proxy: boundProxy
      });
    }
  }

  return config;
}`;
}

/**
 * 纯函数：检查西游云配置中的脚本状态
 */
export function inspectXiyouPreferences(rawText) {
  try {
    const rawObj = JSON.parse(rawText || "{}");
    const flutterConfig = JSON.parse(rawObj["flutter.config"] || "{}");
    const scriptProps = flutterConfig.scriptProps || {};
    const scripts = Array.isArray(scriptProps.scripts) ? scriptProps.scripts : [];
    const currentId = scriptProps.currentId || null;
    const activeScript = scripts.find((s) => s.id === currentId || s.id === "abc-multi-proxy-script") || null;
    const content = activeScript?.content || activeScript?.code || "";
    const scriptHash = content ? crypto.createHash("sha256").update(content).digest("hex") : "";

    return {
      ok: true,
      currentId,
      scriptCount: scripts.length,
      hasAbcScript: Boolean(activeScript),
      isActive: currentId === "abc-multi-proxy-script",
      scriptHash,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 纯函数：将标准格式的脚本补丁写入西游云 JSON 文本中
 */
export function patchXiyouPreferences(rawText, scriptCode) {
  const rawObj = JSON.parse(rawText || "{}");
  const flutterConfig = JSON.parse(rawObj["flutter.config"] || "{}");

  const scriptId = "abc-multi-proxy-script";
  const scriptItem = {
    id: scriptId,
    label: "Antigravity多端口并发代理脚本",
    content: scriptCode,
    url: null,
  };

  if (!flutterConfig.scriptProps) {
    flutterConfig.scriptProps = { currentId: scriptId, scripts: [scriptItem] };
  } else {
    flutterConfig.scriptProps.currentId = scriptId;
    if (!Array.isArray(flutterConfig.scriptProps.scripts)) flutterConfig.scriptProps.scripts = [];
    const existingIdx = flutterConfig.scriptProps.scripts.findIndex((s) => s.id === scriptId || s.label === scriptItem.label);
    if (existingIdx >= 0) {
      flutterConfig.scriptProps.scripts[existingIdx] = scriptItem;
    } else {
      flutterConfig.scriptProps.scripts.push(scriptItem);
    }
  }

  rawObj["flutter.config"] = JSON.stringify(flutterConfig);
  return JSON.stringify(rawObj);
}

/**
 * 组装多端口分配表 (自动分配 7892, 7893, 7894, 7895...)
 */
export function buildMultiPortEgressPlan({ customIsp = null, customNodes = [], parsedNodes = [], startPort = 7892, previousPlan = [] } = {}) {
  const allCandidates = [];
  const customList = parseCustomNodesList(customNodes || customIsp);
  for (const cNode of customList) {
    allCandidates.push(cNode);
  }
  allCandidates.push(...parsedNodes);

  const recommendedNodes = pickRecommendedNodes(allCandidates, 5).filter((n) => n.recommended);
  const relay = selectSingaporeRelay(recommendedNodes);
  return buildPlanFromSelectedNodes(recommendedNodes, startPort, { relayNodeName: relay?.name || "", previousPlan });
}
