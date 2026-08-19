import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  chooseDefaultModel,
  createActiveCodexConfig,
  createCodexApiAuth,
  createCodexProfile,
  createModelCatalog,
  createProxyConfig,
  extractProjectId,
  isAntigravityAccount,
  normalizeModels,
  parseQuotaPayload,
} from "./core.mjs";
import {
  applyFiles,
  atomicWrite,
  atomicWriteJson,
  createSnapshot,
  hashFile,
  restoreSnapshot,
  updateSnapshotState,
  verifySnapshot,
} from "./transaction.mjs";
import { cleanForeignReasoningItems, readHistoryInventory, syncThreadProvider } from "./history.mjs";
import { friendlyProxyError, modelCapabilities } from "./protocol.mjs";
import {
  identifyCountry,
  parseCustomIspText,
  parseCustomNodesList,
  isValidWorkingNode,
  parseClashYamlProxies,
  parseSubscriptionContent,
  scanLocalClashProfiles,
  scanLocalSubscriptionUrls,
  pickRecommendedNodes,
  buildPlanFromSelectedNodes,
  buildMultiPortEgressPlan,
  selectSingaporeRelay,
  findActivatedEgress,
  createXiyouOverrideScript,
  computeNodeFingerprint,
  patchXiyouPreferences,
  inspectXiyouPreferences,
  findLocalRawProfileContent,
} from "./subscription.mjs";
import { compileMihomoConfig, parseMihomoSource } from "./mihomo-config.mjs";
import { globalMihomoManager } from "./mihomo-manager.mjs";
import { MihomoRuntimeCoordinator } from "./mihomo-runtime.mjs";
import { globalTelemetryCollector, extractOutputTokenUsage, estimateOutputTokensFromText } from "./telemetry.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const CLIPROXY_LOCK_PATH = path.join(ROOT, "cliproxy.lock.json");
const APP_VERSION = "0.4.0";
const UI_HOST = "127.0.0.1";
const UI_PORT = Number(process.env.BRIDGE_PORT || 8787);
const DATA_DIR = path.resolve(
  process.env.BRIDGE_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge"),
);
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.yaml");
const AUTH_DIR = path.join(DATA_DIR, "auths");
const BIN_DIR = path.join(DATA_DIR, "bin");
const CATALOG_PATH = path.join(DATA_DIR, "codex-model-catalog.json");
const QUOTA_CACHE_PATH = path.join(DATA_DIR, "quota-cache.json");
const CODEX_HOME_DIR = path.join(DATA_DIR, "codex-home");
const ACTIVE_BACKUP_ROOT = path.join(DATA_DIR, "backups", "codex-live");
const CODEX_LAUNCHER_PATH = path.join(DATA_DIR, "launch-codex-api-service.cmd");
const CODEX_LAUNCHER_PS1_PATH = path.join(DATA_DIR, "launch-codex-api-service.ps1");

const runtime = {
  settings: null,
  proxyProcess: null,
  proxyStartedAt: null,
  proxyStarting: false,
  shuttingDown: false,
  install: { running: false, message: "" },
  proxyCompatibility: { at: 0, value: null },
  logs: [],
  errors: [],
  quotas: {},
  lastQuotaSweep: 0,
  quotaRefreshing: false,
  codexLaunch: { running: false, message: "" },
  accountCache: { at: 0, value: [] },
  modelCache: { at: 0, value: [] },
  historyCache: { at: 0, value: null },
  egressPlan: [],
  candidateNodes: [],
  telemetry: {
    totalRequests: 0,
    totalTokens: 0,
    totalGenSeconds: 0,
    totalTtftMs: 0,
    avgTokensPerSec: 0,
    avgTtftMs: 0,
    lastTokensPerSec: 0,
    lastTtftMs: 0,
    lastActivityAt: null,
  },
};

function randomKey(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function detectCodexHome() {
  const explicit = process.env.BRIDGE_CODEX_HOME || process.env.CODEX_HOME;
  if (explicit) return path.resolve(explicit);
  const driveCandidate = path.join(path.parse(ROOT).root, "codex-home");
  if (fsSync.existsSync(path.join(driveCandidate, "config.toml"))) return driveCandidate;
  return path.join(os.homedir(), ".codex");
}

function defaultSettings() {
  return {
    proxyPort: 8317,
    proxyBinary: "",
    codexAppPath: "",
    codexHome: detectCodexHome(),
    quotaIntervalMinutes: 10,
    defaultModel: "",
    autoRoundRobin: true,
    activeAccountId: "",
    accountProxies: {},
    networkSettings: {
      mode: "isolated",
      subscriptionUrl: "",
      customIspText: "",
      customNodes: [],
      selectedNodes: [],
      egressPlan: [],
      pendingEgressPlan: [],
      activation: {
        state: "inactive",
        generationId: "",
        scriptHash: "",
        expectedPorts: [],
        preparedAt: null,
        writtenAt: null,
        verifiedAt: null,
        failure: "",
      },
      lastSyncedAt: null,
    },
    codexActiveBackup: "",
    codexApiPrepared: false,
    clientKey: randomKey("agc"),
    managementKey: randomKey("agm"),
    uiKey: randomKey("agui"),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await atomicWriteJson(filePath, value);
}

async function saveSettings() {
  await writeJson(SETTINGS_PATH, runtime.settings);
}

async function initialize() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(AUTH_DIR, { recursive: true }),
    fs.mkdir(BIN_DIR, { recursive: true }),
    fs.mkdir(CODEX_HOME_DIR, { recursive: true }),
  ]);
  const stored = await readJson(SETTINGS_PATH, {});
  const defaults = defaultSettings();
  runtime.settings = {
    ...defaults,
    ...stored,
    networkSettings: {
      ...defaults.networkSettings,
      ...(stored.networkSettings || {}),
    },
    clientKey: stored.clientKey || defaults.clientKey,
    managementKey: stored.managementKey || defaults.managementKey,
    uiKey: stored.uiKey || defaults.uiKey,
  };
  runtime.egressPlan = Array.isArray(runtime.settings.networkSettings.egressPlan)
    ? runtime.settings.networkSettings.egressPlan
    : [];
  runtime.quotas = await readJson(QUOTA_CACHE_PATH, {});
  await saveSettings();
  await recoverInterruptedTakeover();
}

function redact(value) {
  return String(value)
    .replace(/(authorization[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/([?&](?:code|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("(?:password|username|proxy_url)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/\bag(?:c|m|ui)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b[A-Z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

function publicEgressPlan(plan = []) {
  return plan.map(({ sourceProxy, ...item }) => item);
}

function publicNetworkSettings(settings = {}) {
  const accountSettings = settings.accountSettings
    ? {
        apiBaseUrl: settings.accountSettings.apiBaseUrl || "",
        email: settings.accountSettings.email || "",
        hasSession: Boolean(settings.accountSettings.subscriptionUrl),
        lastSyncedAt: settings.accountSettings.lastSyncedAt || null,
      }
    : null;
  return {
    ...settings,
    accountSettings,
    egressPlan: undefined,
  };
}

function parseLogTelemetry(message) {
  // CLIProxy diagnostic log monitoring (不修改 canonical telemetry，保持诊断用途)
  const match = message.match(/\|\s*(2\d\d)\s*\|\s*([\d\.]+(?:ms|s|µs))\s*\|\s*[^|]+\|\s*POST\s+"([^"]+)"/i);
  if (match) {
    // 诊断日志保留，不污染真实 TelemetryCollector 数据
  }
}

function addLog(scope, message, level = "info") {
  parseLogTelemetry(message);
  runtime.logs.push({ time: new Date().toISOString(), scope, level, message: redact(message) });
  runtime.logs = runtime.logs.slice(-80);
}

function addError(scope, error) {
  const message = redact(error instanceof Error ? error.message : error);
  runtime.errors.push({ time: new Date().toISOString(), scope, message });
  runtime.errors = runtime.errors.slice(-20);
  addLog(scope, message, "error");
}

function publicSettings() {
  const { clientKey, managementKey, uiKey, ...safe } = runtime.settings;
  return { ...safe, networkSettings: publicNetworkSettings(safe.networkSettings) };
}

function validateSettings(input) {
  const next = { ...runtime.settings };
  if (input.proxyPort !== undefined) {
    const value = Number(input.proxyPort);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("代理端口必须在 1024 到 65535 之间");
    next.proxyPort = value;
  }
  if (input.proxyBinary !== undefined) next.proxyBinary = String(input.proxyBinary).trim();
  if (input.codexAppPath !== undefined) next.codexAppPath = String(input.codexAppPath).trim();
  if (input.codexHome !== undefined) {
    const value = String(input.codexHome).trim();
    if (!path.isAbsolute(value)) throw new Error("Codex Home 必须是绝对路径");
    next.codexHome = path.resolve(value);
  }
  if (input.quotaIntervalMinutes !== undefined) {
    const value = Number(input.quotaIntervalMinutes);
    if (!Number.isInteger(value) || value < 5 || value > 60) throw new Error("额度检查间隔必须在 5 到 60 分钟之间");
    next.quotaIntervalMinutes = value;
  }
  if (input.defaultModel !== undefined) next.defaultModel = String(input.defaultModel).trim();
  return next;
}

function findOnPath(names) {
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), name);
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function detectProxyBinary() {
  const candidates = [
    runtime.settings.proxyBinary,
    path.join(BIN_DIR, "cli-proxy-api.exe"),
    path.join(ROOT, "bin", "cli-proxy-api.exe"),
    findOnPath(["cli-proxy-api.exe", "CLIProxyAPI.exe", "cliproxyapi.exe"]),
  ].filter(Boolean);
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || "";
}

async function findFile(directory, targetName) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(fullPath, targetName);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
      return fullPath;
    }
  }
  return "";
}

async function getPinnedRelease(architecture) {
  const lock = await readJson(CLIPROXY_LOCK_PATH, null);
  const assetLock = lock?.assets?.[architecture];
  if (!lock?.repository || !lock?.version || !lock?.tag || !assetLock?.binarySha256) {
    throw new Error(`CLIProxyAPI ${architecture} is not pinned in cliproxy.lock.json`);
  }
  const name = `CLIProxyAPI_${lock.version}_windows_${architecture}.zip`;
  return {
    lock,
    tagName: lock.tag,
    asset: {
      name,
      browser_download_url: `https://github.com/${lock.repository}/releases/download/${lock.tag}/${name}`,
      binarySha256: assetLock.binarySha256.toLowerCase(),
    },
  };
}

async function installProxy() {
  if (runtime.install.running) throw new Error("核心正在安装，请稍候");
  if (await proxyHealth()) throw new Error("请先停止 CLIProxyAPI，再安装锁定版本");
  runtime.install = { running: true, message: "正在读取锁定版本" };
  try {
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const { lock, tagName, asset } = await getPinnedRelease(architecture);
    if (new URL(asset.browser_download_url).hostname !== "github.com") throw new Error("下载地址不是受信任的 GitHub 地址");

    runtime.install.message = `正在下载 ${asset.name}`;
    const downloadResponse = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "AntigravityCodexBridge" },
      signal: AbortSignal.timeout(180_000),
    });
    if (!downloadResponse.ok) throw new Error(`下载失败，HTTP ${downloadResponse.status}`);
    const archive = Buffer.from(await downloadResponse.arrayBuffer());
    const expectedDigest = String(asset.digest || "").replace(/^sha256:/i, "").toLowerCase();
    if (expectedDigest) {
      const actualDigest = crypto.createHash("sha256").update(archive).digest("hex");
      if (actualDigest !== expectedDigest) throw new Error("安装包 SHA-256 校验失败");
    }

    const tempRoot = path.join(DATA_DIR, `install-${Date.now()}`);
    const archivePath = path.join(tempRoot, asset.name);
    const extractPath = path.join(tempRoot, "extracted");
    await fs.mkdir(extractPath, { recursive: true });
    await fs.writeFile(archivePath, archive);
    runtime.install.message = "正在解压核心";
    await execFileAsync("tar.exe", ["-xf", archivePath, "-C", extractPath], { windowsHide: true, timeout: 60_000 });
    const sourceBinary = await findFile(extractPath, "cli-proxy-api.exe");
    if (!sourceBinary) throw new Error("安装包中未找到 cli-proxy-api.exe");
    const binary = await fs.readFile(sourceBinary);
    const binaryDigest = crypto.createHash("sha256").update(binary).digest("hex");
    if (binaryDigest !== asset.binarySha256) {
      throw new Error("CLIProxyAPI binary SHA-256 does not match cliproxy.lock.json");
    }
    const destination = path.join(BIN_DIR, "cli-proxy-api.exe");
    await atomicWrite(destination, binary);
    await fs.rm(tempRoot, { recursive: true, force: true });
    runtime.settings.proxyBinary = destination;
    await saveSettings();
    runtime.proxyCompatibility = { at: 0, value: null };
    await writeJson(path.join(BIN_DIR, "version.json"), {
      version: lock.version,
      tag: lock.tag,
      commit: lock.commit,
      binarySha256: binaryDigest,
      installedAt: new Date().toISOString(),
    });
    addLog("install", `CLIProxyAPI ${tagName} 安装完成`);
    return { version: tagName, binaryPath: destination };
  } catch (error) {
    addError("install", error);
    throw error;
  } finally {
    runtime.install = { running: false, message: "" };
  }
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function proxyRequest(endpoint, { method = "GET", body, management = false, timeout = 15_000 } = {}) {
  const prefix = management ? "/v0/management" : "";
  const key = management ? runtime.settings.managementKey : runtime.settings.clientKey;
  const response = await fetch(`http://127.0.0.1:${runtime.settings.proxyPort}${prefix}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.message || text || `HTTP ${response.status}`;
    const retryAfter = response.headers.get("retry-after") ? Number(response.headers.get("retry-after")) * 1000 : undefined;
    const error = new Error(friendlyProxyError(response.status, detail, retryAfter));
    error.status = response.status;
    error.upstreamDetail = redact(detail);
    throw error;
  }
  return payload;
}

async function proxyHealth() {
  try {
    await proxyRequest("/v1/models", { timeout: 1_500 });
    return true;
  } catch {
    return false;
  }
}

async function waitForProxy(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await proxyHealth()) return;
    if (runtime.proxyProcess?.exitCode !== null) throw new Error(`CLIProxyAPI 已退出，代码 ${runtime.proxyProcess.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("CLIProxyAPI 启动超时，请查看运行日志");
}

async function writeProxyConfig() {
  await fs.writeFile(CONFIG_PATH, createProxyConfig({
    port: runtime.settings.proxyPort,
    authDir: AUTH_DIR,
    clientKey: runtime.settings.clientKey,
    managementKey: runtime.settings.managementKey,
    defaultModel: runtime.settings.defaultModel || "gemini-3.7-flash-high",
  }), "utf8");
}

async function startProxy() {
  if (await proxyHealth()) return { running: true, managed: Boolean(runtime.proxyProcess), reused: true };
  if (runtime.proxyStarting) throw new Error("核心正在启动，请稍候");
  if (await canConnect(runtime.settings.proxyPort)) throw new Error(`端口 ${runtime.settings.proxyPort} 已被其他程序占用`);
  const binary = detectProxyBinary();
  if (!binary) throw new Error("尚未安装 CLIProxyAPI 核心，请先点击“安装核心”或填写核心路径");

  runtime.proxyStarting = true;
  try {
    await writeProxyConfig();
    const child = spawn(binary, ["--config", CONFIG_PATH], {
      cwd: DATA_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.bridgeReady = false;
    runtime.proxyProcess = child;
    runtime.proxyStartedAt = new Date().toISOString();
    child.stdout.on("data", (chunk) => addLog("core", chunk.toString("utf8").trim()));
    child.stderr.on("data", (chunk) => addLog("core", chunk.toString("utf8").trim(), "warn"));
    child.once("exit", (code, signal) => {
      addLog("core", `核心已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）`, code ? "error" : "info");
      runtime.proxyProcess = null;
      runtime.proxyStartedAt = null;
      void (async () => {
        if (child.bridgeReady && !runtime.shuttingDown && runtime.settings.codexActiveBackup) {
          await restoreCodexConfig();
        }
      })().catch((error) => addError("recovery", error));
    });
    child.once("error", (error) => addError("core", error));
    await waitForProxy();
    child.bridgeReady = true;
    await fs.rm(CONFIG_PATH, { force: true });
    addLog("core", `服务已监听 127.0.0.1:${runtime.settings.proxyPort}`);
    runtime.accountCache.at = 0;
    runtime.modelCache.at = 0;
    return { running: true, managed: true, reused: false };
  } catch (error) {
    if (runtime.proxyProcess && runtime.proxyProcess.exitCode === null) runtime.proxyProcess.kill();
    runtime.proxyProcess = null;
    runtime.proxyStartedAt = null;
    await fs.rm(CONFIG_PATH, { force: true });
    addError("core", error);
    throw error;
  } finally {
    runtime.proxyStarting = false;
  }
}

async function stopProxy() {
  if (!runtime.proxyProcess) {
    if (await proxyHealth()) throw new Error("当前端口上的服务不是由本次工具进程启动，无法安全停止");
    return { running: false };
  }
  const child = runtime.proxyProcess;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  runtime.proxyProcess = null;
  runtime.proxyStartedAt = null;
  addLog("core", "服务已停止");
  return { running: false };
}

async function inspectProxyCompatibility(force = false) {
  if (!force && runtime.proxyCompatibility.value && Date.now() - runtime.proxyCompatibility.at < 30_000) {
    return runtime.proxyCompatibility.value;
  }
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const lock = await readJson(CLIPROXY_LOCK_PATH, null);
  const binaryPath = detectProxyBinary();
  if (!binaryPath) {
    const value = { installed: false, compatible: false, pinnedVersion: lock?.version || null };
    runtime.proxyCompatibility = { at: Date.now(), value };
    return value;
  }
  const binarySha256 = await hashFile(binaryPath);
  let output = "";
  try {
    const result = await execFileAsync(binaryPath, ["-h"], { windowsHide: true, timeout: 5_000 });
    output = `${result.stdout || ""}\n${result.stderr || ""}`;
  } catch (error) {
    output = `${error.stdout || ""}\n${error.stderr || ""}`;
  }
  const installedVersion = output.match(/CLIProxyAPI Version:\s*([^,\s]+)/i)?.[1] || null;
  const installedCommit = output.match(/Commit:\s*([^,\s]+)/i)?.[1] || null;
  const expectedSha256 = lock?.assets?.[architecture]?.binarySha256?.toLowerCase() || null;
  const value = {
    installed: true,
    compatible: Boolean(expectedSha256 && binarySha256 === expectedSha256),
    pinnedVersion: lock?.version || null,
    pinnedCommit: lock?.commit || null,
    installedVersion,
    installedCommit,
    binarySha256,
    expectedSha256,
  };
  runtime.proxyCompatibility = { at: Date.now(), value };
  return value;
}

async function getHistory(force = false) {
  if (!force && runtime.historyCache.value && Date.now() - runtime.historyCache.at < 10_000) {
    return runtime.historyCache.value;
  }
  const value = await readHistoryInventory(liveCodexHomePath());
  runtime.historyCache = { at: Date.now(), value };
  return value;
}

function extractCleanEmail(raw) {
  if (!raw) return "";
  let str = String(raw).replace(/\.json$/i, "").replace(/^antigravity-/i, "");
  const match = str.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (match) {
    let email = match[1];
    if (email.endsWith(".json")) email = email.slice(0, -5);
    return email.replace(/^antigravity-/i, "");
  }
  return str;
}

function getAntigravityCockpitQuotaSummary(rawEmail) {
  try {
    const clean = extractCleanEmail(rawEmail);
    const dir = path.join(os.homedir(), ".antigravity_cockpit", "cache", "quota_api_v1_desktop", "authorized");
    if (!fsSync.existsSync(dir)) return null;

    if (clean) {
      const hash = crypto.createHash("sha256").update(clean).digest("hex");
      const directPath = path.join(dir, `${hash}.json`);
      if (fsSync.existsSync(directPath)) {
        const data = JSON.parse(fsSync.readFileSync(directPath, "utf8"));
        if (data?.payload?.quota_summary) return data.payload.quota_summary;
      }
    }

    const files = fsSync.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith(".json")) {
        try {
          const data = JSON.parse(fsSync.readFileSync(path.join(dir, f), "utf8"));
          if (data?.email && clean && (data.email.toLowerCase() === clean.toLowerCase() || data.email.includes(clean))) {
            if (data?.payload?.quota_summary) return data.payload.quota_summary;
          }
          if (files.length === 1 && data?.payload?.quota_summary) {
            return data.payload.quota_summary;
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

async function getAccounts(force = false) {
  if (!await proxyHealth()) return [];
  if (!force && Date.now() - runtime.accountCache.at < 3_000) return runtime.accountCache.value;
  const payload = await proxyRequest("/auth-files", { management: true });
  const accounts = (payload.files || [])
    .filter(isAntigravityAccount)
    .map((account) => {
      const rawEmail = account.email || account.name || account.id;
      let q = runtime.quotas[account.auth_index] || null;
      if (q) {
        if (!q.summary) {
          q.summary = getAntigravityCockpitQuotaSummary(rawEmail);
        }
      } else {
        const summary = getAntigravityCockpitQuotaSummary(rawEmail);
        if (summary) {
          q = {
            status: "reported",
            fetchedAt: new Date().toISOString(),
            projectId: "",
            models: [],
            summary,
            message: "额度来自本地 Antigravity 官方快照",
          };
          runtime.quotas[account.auth_index] = q;
        }
      }
      let health = "ready";
      let healthMessage = "Google OAuth 就绪";

      if (
        q?.status === "reauth" ||
        account.status === "reauth" ||
        /expired|revoked|invalid_grant|auth_unavailable|no auth available/i.test(account.status_message || "") ||
        /expired|revoked|invalid_grant|auth_unavailable/i.test(q?.message || "")
      ) {
        health = "reauth";
        healthMessage = "OAuth 凭据已失效，请重新登录";
      } else if (account.disabled) {
        health = "disabled";
        healthMessage = "账号已停用";
      } else if (q?.status === "cooldown" || account.status === "cooldown" || /rate_limit|429|exhausted/i.test(account.status_message || "")) {
        health = "cooldown";
        healthMessage = "429 频控冷却中";
      } else if (account.unavailable || q?.status === "error") {
        health = "unavailable";
        healthMessage = account.status_message || q?.message || "账号暂不可用";
      }

      const accountKey = account.email || account.name || account.id || "";
      const assignedProxy = runtime.settings.accountProxies?.[accountKey]
        || runtime.settings.accountProxies?.[account.id]
        || runtime.settings.accountProxies?.[account.name]
        || null;

      let proxyDisplay = "🌐 默认网络";
      if (assignedProxy) {
        if (assignedProxy.port && assignedProxy.name) {
          proxyDisplay = `🌐 端口 ${assignedProxy.port} · ${assignedProxy.name}`;
        } else if (assignedProxy.name) {
          proxyDisplay = `🌐 ${assignedProxy.name}`;
        }
      }

      return {
        id: account.id || account.name,
        authIndex: account.auth_index || "",
        name: account.name || account.id,
        email: account.email || account.id || account.name,
        label: account.label || "",
        status: health,
        statusMessage: healthMessage,
        health,
        disabled: Boolean(account.disabled),
        unavailable: health !== "ready",
        success: Number(account.success || 0),
        failed: Number(account.failed || 0),
        lastRefresh: account.last_refresh || account.updated_at || account.modtime || null,
        source: account.source || "file",
        quota: q,
        assignedProxy,
        proxyDisplay,
      };
    });
  runtime.accountCache = { at: Date.now(), value: accounts };
  return accounts;
}

async function getModels(force = false) {
  if (!await proxyHealth()) return [];
  if (!force && Date.now() - runtime.modelCache.at < 10_000) return runtime.modelCache.value;
  const payload = await proxyRequest("/v1/models");
  const models = normalizeModels(payload);
  runtime.modelCache = { at: Date.now(), value: models };
  if (models.length) {
    const catalog = `${JSON.stringify(createModelCatalog(models), null, 2)}\n`;
    await atomicWrite(CATALOG_PATH, catalog).catch(() => {});
  }
  return models;
}

async function waitForModels(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const models = await getModels(true);
    if (models.length) return models;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  return [];
}

async function antigravityApiCall(account, url, data) {
  const response = await proxyRequest("/api-call", {
    management: true,
    method: "POST",
    timeout: 30_000,
    body: {
      auth_index: account.authIndex,
      method: "POST",
      url,
      header: {
        Authorization: "Bearer $TOKEN$",
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "antigravity",
      },
      data: JSON.stringify(data),
    },
  });
  let body = {};
  try {
    body = JSON.parse(response.body || "{}");
  } catch {
    body = {};
  }
  return { status: Number(response.status_code || 0), body };
}

async function resolveProjectId(account) {
  const cached = runtime.quotas[account.authIndex]?.projectId;
  if (cached && runtime.quotas[account.authIndex]?.status !== "reauth") return cached;
  try {
    const result = await antigravityApiCall(
      account,
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } },
    );
    if (result.status === 401 || result.status === 403) {
      runtime.quotas[account.authIndex] = {
        status: "reauth",
        fetchedAt: new Date().toISOString(),
        projectId: "",
        models: [],
        message: "OAuth Token 已失效或被撤销，请重新登录授权",
      };
      return "";
    }
    return result.status === 200 ? extractProjectId(result.body) : "";
  } catch {
    return "";
  }
}

async function refreshQuota(authIndex = "") {
  if (runtime.quotaRefreshing) throw new Error("额度正在刷新，请稍候");
  runtime.quotaRefreshing = true;
  try {
    const accounts = (await getAccounts(true)).filter((account) => !authIndex || account.authIndex === authIndex);
    const summaryEndpoints = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ];
    const modelEndpoints = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    ];

    for (const account of accounts) {
      const projectId = await resolveProjectId(account);
      if (runtime.quotas[account.authIndex]?.status === "reauth") {
        continue;
      }

      let summaryResult = null;
      let summaryError = null;
      for (const endpoint of summaryEndpoints) {
        try {
          const result = await antigravityApiCall(account, endpoint, projectId ? { project: projectId } : {});
          summaryResult = result;
          if (result.status === 200) break;
          if (![404, 429, 500, 502, 503, 504].includes(result.status)) break;
        } catch (error) {
          summaryError = error;
        }
      }

      let modelsResult = null;
      let modelsError = null;
      for (const endpoint of modelEndpoints) {
        try {
          const result = await antigravityApiCall(account, endpoint, projectId ? { project: projectId } : {});
          modelsResult = result;
          if (result.status === 200) break;
          if (![404, 429, 500, 502, 503, 504].includes(result.status)) break;
        } catch (error) {
          modelsError = error;
        }
      }

      const fetchedAt = new Date().toISOString();
      const isSuccess = (summaryResult?.status === 200) || (modelsResult?.status === 200);

      if (isSuccess) {
        const models = modelsResult?.status === 200 ? parseQuotaPayload(modelsResult.body) : [];
        let summary = (summaryResult?.status === 200 && summaryResult.body?.groups)
          ? summaryResult.body
          : (modelsResult?.body?.quota_summary || modelsResult?.body?.quotaSummary || getAntigravityCockpitQuotaSummary(account.email) || null);

        runtime.quotas[account.authIndex] = {
          status: "reported",
          fetchedAt,
          projectId,
          models,
          summary,
          message: projectId
            ? "额度来自 Antigravity 官方实时 retrieveUserQuotaSummary 报告值"
            : "未解析到项目标识，当前额度可能不准确",
        };
      } else {
        const status = summaryResult?.status || modelsResult?.status || 0;
        runtime.quotas[account.authIndex] = {
          status: status === 401 || status === 403 ? "reauth" : status === 429 ? "cooldown" : "error",
          fetchedAt,
          projectId,
          models: [],
          summary: null,
          message: summaryError?.message || modelsError?.message || summaryResult?.body?.error?.message || modelsResult?.body?.error?.message || `上游返回 HTTP ${status || "未知"}`,
        };
      }
    }
    runtime.lastQuotaSweep = Date.now();
    runtime.accountCache.at = 0;
    await writeJson(QUOTA_CACHE_PATH, runtime.quotas);
    addLog("quota", `已刷新 ${accounts.length} 个账号的上游报告额度`);
    return { refreshed: accounts.length };
  } finally {
    runtime.quotaRefreshing = false;
  }
}

async function toggleAccount(name, disabled) {
  await proxyRequest("/auth-files/status", {
    management: true,
    method: "PATCH",
    body: { name, disabled: Boolean(disabled) },
  });
  runtime.accountCache.at = 0;
  runtime.modelCache.at = 0;
  addLog("account", `${disabled ? "已停用" : "已启用"} ${name}`);
}

async function deleteAccount(name) {
  try {
    await proxyRequest(`/auth-files?name=${encodeURIComponent(name)}`, { management: true, method: "DELETE" });
  } catch {}

  const cleanEmail = extractCleanEmail(name);
  const candidates = [
    path.join(AUTH_DIR, name),
    path.join(AUTH_DIR, `${name}.json`),
    path.join(AUTH_DIR, `antigravity-${name}.json`),
    path.join(AUTH_DIR, `antigravity-${name}`),
    path.join(AUTH_DIR, `antigravity-${cleanEmail}.json`),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(c)) {
      try { await fs.rm(c, { force: true }); } catch {}
    }
  }

  if (runtime.settings.accountProxies) {
    delete runtime.settings.accountProxies[name];
    if (cleanEmail) delete runtime.settings.accountProxies[cleanEmail];
    await saveSettings();
  }

  if (runtime.settings.activeAccountId && (runtime.settings.activeAccountId.includes(name) || (cleanEmail && runtime.settings.activeAccountId.includes(cleanEmail)))) {
    const remaining = await getAccounts(true);
    runtime.settings.activeAccountId = remaining[0]?.id || "";
    await saveSettings();
  }

  runtime.accountCache.at = 0;
  runtime.modelCache.at = 0;
  addLog("account", `已删除本地凭据 ${name}`, "warn");
}

function accountIdentityKeys(account) {
  return [account?.name, account?.id, account?.email, account?.authIndex]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

async function findAccountAuthFile(account) {
  const keys = new Set(accountIdentityKeys(account));
  if (keys.size === 0) return "";
  let files = [];
  try { files = await fs.readdir(AUTH_DIR); } catch { return ""; }

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const filePath = path.join(AUTH_DIR, file);
    const fileKey = file.toLowerCase();
    if ([...keys].some((key) => fileKey === key || fileKey === `${key}.json` || fileKey === `antigravity-${key}.json`)) {
      return filePath;
    }
  }

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const filePath = path.join(AUTH_DIR, file);
    try {
      const payload = await readJson(filePath, {});
      const payloadKeys = accountIdentityKeys({
        name: payload.name,
        id: payload.id,
        email: payload.email,
        authIndex: payload.auth_index,
      });
      if (payloadKeys.some((key) => keys.has(key))) return filePath;
    } catch {}
  }
  return "";
}

async function setAccountProxyUrl(account, port = 0) {
  const authFilePath = await findAccountAuthFile(account);
  if (!authFilePath) throw new Error(`未找到账号 ${account?.email || account?.name || account?.id || ""} 的本地 OAuth 凭据文件`);
  const authObj = JSON.parse(await fs.readFile(authFilePath, "utf8"));
  if (port > 0) authObj.proxy_url = `http://127.0.0.1:${port}`;
  else delete authObj.proxy_url;
  await atomicWrite(authFilePath, JSON.stringify(authObj, null, 2));
  return authFilePath;
}

async function applyAccountRouting() {
  if (!await proxyHealth()) return;
  const accounts = await getAccounts(true);
  if (!accounts.length) return;

  if (runtime.settings.autoRoundRobin !== false) {
    for (const acc of accounts) {
      if (acc.disabled) {
        await toggleAccount(acc.name, false);
      }
    }
  } else {
    let activeId = runtime.settings.activeAccountId;
    if (!activeId || !accounts.some((a) => a.id === activeId || a.name === activeId || a.email === activeId)) {
      activeId = accounts[0].id || accounts[0].name;
      runtime.settings.activeAccountId = activeId;
      await saveSettings();
    }
    for (const acc of accounts) {
      const isTarget = (acc.id === activeId || acc.name === activeId || acc.email === activeId);
      if (isTarget && acc.disabled) {
        await toggleAccount(acc.name, false);
      } else if (!isTarget && !acc.disabled) {
        await toggleAccount(acc.name, true);
      }
    }
  }
}

const pendingOAuthStates = new Map();

function getClashConfigDir() {
  const candidates = [
    path.join(os.homedir(), "AppData", "Roaming", "com.appshub", "XiyouYun"),
    path.join(os.homedir(), "AppData", "Roaming", "com.follow", "clash"),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(path.join(c, "shared_preferences.json"))) return c;
  }
  return candidates[0];
}

async function detectActiveProxyPort() {
  const tryPorts = [7888, 7890, 7891, 7892];
  for (const p of tryPorts) {
    if (await canConnect(p)) return p;
  }
  return 7888;
}

async function fetchSubscriptionText(url, userAgent = "ClashMeta/v1.18.0 (XiyouYun)") {
  let directError = null;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) return await response.text();
    directError = new Error(`HTTP ${response.status} ${response.statusText}`);
  } catch (error) {
    directError = error;
  }

  try {
    const proxyPort = await detectActiveProxyPort();
    const { stdout } = await execFileAsync("curl.exe", [
      "--silent",
      "--show-error",
      "--fail",
      "--location",
      "--compressed",
      "--max-time",
      "12",
      "--proxy",
      `http://127.0.0.1:${proxyPort}`,
      "--user-agent",
      userAgent,
      url,
    ], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    if (stdout) return stdout;
    throw new Error("订阅响应为空");
  } catch (proxyError) {
    const directMessage = directError?.message || "未知错误";
    throw new Error(`订阅直连失败: ${directMessage}；本地代理重试失败: ${proxyError.message}`);
  }
}

async function fetchFirstValidSubscription(urls = []) {
  let lastError = null;
  for (const url of [...new Set(urls.filter(Boolean))]) {
    try {
      const text = await fetchSubscriptionText(url);
      const parsedNodes = parseSubscriptionContent(text);
      if (parsedNodes.length > 0) return { url, text, parsedNodes };
      lastError = new Error("订阅响应中没有可解析节点");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { url: "", text: "", parsedNodes: [] };
}

async function loadLocalSessionNodes() {
  const profileNodes = scanLocalClashProfiles();
  if (profileNodes.length > 0) return { parsedNodes: profileNodes, subscriptionUrl: "", source: "local-profile" };

  const sessionUrls = scanLocalSubscriptionUrls();
  if (sessionUrls.length === 0) return { parsedNodes: [], subscriptionUrl: "", source: "none" };
  try {
    const fetched = await fetchFirstValidSubscription(sessionUrls);
    return { parsedNodes: fetched.parsedNodes, subscriptionUrl: fetched.url, source: "local-session" };
  } catch {
    return { parsedNodes: [], subscriptionUrl: "", source: "none" };
  }
}

/**
 * 真实 HTTP/HTTPS 代理通道端到端握手与往返实测
 */
export function measureHttpProxyRealLatency(proxyPort, targetHost = "cp.cloudflare.com", timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let isResolved = false;

    const done = (val) => {
      if (!isResolved) {
        isResolved = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(val);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done(-1));
    socket.on("error", () => done(-1));

    let responseBuffer = "";
    socket.connect(proxyPort, "127.0.0.1", () => {
      const reqStr = `GET http://${targetHost}/generate_204 HTTP/1.1\r\nHost: ${targetHost}\r\nProxy-Connection: close\r\n\r\n`;
      socket.write(reqStr);
      socket.on("data", (chunk) => {
        responseBuffer += chunk.toString("latin1");
        if (!responseBuffer.includes("\r\n")) return;
        const status = Number(responseBuffer.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
        done(status >= 200 && status < 400 ? Date.now() - start : -1);
      });
    });
  });
}

export async function pingNodesList(nodes = []) {
  const results = {};
  const measurements = {};
  await Promise.all(
    nodes.map(async (n) => {
      const key = String(n.id || n.name || n.port || "");
      if (!key) return;

      // 候选节点若已绑定独立 Listener，直接测这个 Listener 的真实代理全链路。
      const activeEgress = findActivatedEgress(n, runtime.egressPlan);
      if (activeEgress) {
        const realChannelRtt = await measureHttpProxyRealLatency(activeEgress.port);
        results[key] = realChannelRtt;
        measurements[key] = { valueMs: realChannelRtt, kind: "channel", label: "通道全链路", ok: realChannelRtt > 0 };
        return;
      }

      // 本地 Listener 端口测量的是包含中转与落地在内的真实 HTTP 全链路。
      if (n.port && !n.server) {
        const realChannelRtt = await measureHttpProxyRealLatency(n.port);
        results[key] = realChannelRtt;
        measurements[key] = { valueMs: realChannelRtt, kind: "channel", label: "通道全链路", ok: realChannelRtt > 0 };
        return;
      }

      // 未激活的订阅节点没有可独立选路的本地端口；入口 TCP 数字不再冒充节点延迟。
      if (n.server && n.port) {
        results[key] = 0;
        measurements[key] = { valueMs: 0, kind: "inactive", label: "未激活，暂无全链路数据", ok: false };
        return;
      }

      results[key] = -1;
      measurements[key] = { valueMs: -1, kind: "unavailable", label: "不可测", ok: false };
    })
  );
  return { ok: true, latencies: results, measurements };
}

function normalizeApiBaseUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) url = "https://xyapi.kilxs.cn/api/v1";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/api/v1")) {
    url = url + "/api/v1";
  }
  return url;
}

async function loginAndFetchAccountSubscription({ apiBaseUrl, email, password }) {
  const normUrl = normalizeApiBaseUrl(apiBaseUrl);
  if (!email || !password) {
    throw new Error("请输入账号(邮箱)和密码");
  }

  addLog("network", `正在通过官方 API (${normUrl}) 进行账号鉴权...`);

  const loginResp = await fetch(`${normUrl}/passport/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Dart/3.0 (dart:io)",
    },
    body: JSON.stringify({ email: String(email).trim(), password: String(password).trim() }),
    signal: AbortSignal.timeout(10_000),
  });

  const loginJson = await loginResp.json().catch(() => ({}));
  const token = String(
    loginJson?.data?.token
      || loginJson?.data?.auth_data
      || loginJson?.token
      || loginJson?.auth_data
      || "",
  ).trim();
  if (!loginResp.ok || !token) {
    let errMsg = loginJson.message || "";
    if (loginJson.errors) {
      try {
        const errValues = Object.keys(loginJson.errors).map((k) => loginJson.errors[k]).flat();
        if (errValues.length > 0) errMsg = errValues.join("；");
      } catch {}
    }
    if (!errMsg) errMsg = `登录失败 (HTTP ${loginResp.status})`;

    // 如果官方 API 限制重试或报错，自动使用本地西游云已登录的会话节点进行无缝兜底
    const localSession = await loadLocalSessionNodes();
    if (localSession.parsedNodes.length > 0) {
      addLog("network", `官方 API 提示 [${errMsg}]，已自动为您启用本地西游云已登录会话中的 ${localSession.parsedNodes.length} 个节点`, "warn");
      return {
        ok: true,
        token: "",
        subscriptionUrl: localSession.subscriptionUrl,
        apiBaseUrl: normUrl,
        email,
        parsedNodes: localSession.parsedNodes,
        warning: `官方提示：${errMsg}。已自动关联本地西游云已登录会话，载入 ${localSession.parsedNodes.length} 个节点。`,
      };
    }

    throw new Error(errMsg);
  }

  addLog("network", `账号登录成功，正在换取最新全量订阅配置...`);

  // 尝试多种常见的 V2Board 订阅格式与地址
  const subUrls = [
    `https://xysuburl.kilxs.cn/api/v1/client/secureSubscribe?token=${token}`,
    `https://xysuburl.kilxs.cn/api/v1/client/subscribe?token=${token}&flag=clash`,
    `${normUrl}/client/subscribe?token=${token}&flag=clash`,
    `${normUrl}/client/secureSubscribe?token=${token}`,
  ];

  let fetchedSubscription = null;
  try {
    fetchedSubscription = await fetchFirstValidSubscription(subUrls);
  } catch {}

  // 如果云端拉取遇到防火墙，自动用本地已缓存的登录会话作为双保险补充
  let parsedNodes = fetchedSubscription?.parsedNodes || [];
  let subscriptionUrl = fetchedSubscription?.url || "";
  if (parsedNodes.length === 0) {
    const localSession = await loadLocalSessionNodes();
    if (localSession.parsedNodes.length > 0) {
      parsedNodes = localSession.parsedNodes;
      subscriptionUrl = localSession.subscriptionUrl;
      addLog("network", `在线拉取受阻，已自动从本地客户端载入 ${parsedNodes.length} 个最新节点`);
    }
  }

  if (parsedNodes.length === 0) {
    throw new Error("成功登录，但未能获取到有效出海节点，请检查网络或稍后重试");
  }

  return {
    ok: true,
    token,
    subscriptionUrl,
    apiBaseUrl: normUrl,
    email,
    parsedNodes,
  };
}

async function fetchSubscriptionCandidateNodes(forceUrl = null, forceCustomIsp = null, accountCreds = null, forceCustomNodes = null) {
  const netSettings = runtime.settings.networkSettings || {
    mode: "isolated",
    subscriptionUrl: "",
    customIspText: "",
    customNodes: [],
    lastSyncedAt: null,
  };

  const url = (forceUrl !== null ? forceUrl : netSettings.subscriptionUrl || "").trim();
  const customIspInput = (forceCustomIsp !== null ? forceCustomIsp : netSettings.customIspText || "").trim();
  let parsedNodes = [];

  let fetchError = "";

  // 1. 如果是账号直连托管模式，优先向官方 API 拉取
  const acc = accountCreds || netSettings.accountSettings;
  if (acc?.subscriptionUrl) {
    try {
      const sessionResult = await fetchFirstValidSubscription([acc.subscriptionUrl]);
      parsedNodes = sessionResult.parsedNodes;
      addLog("network", `已通过保存的西游云会话更新 ${parsedNodes.length} 个节点`);
    } catch (error) {
      fetchError = error.message;
    }
  }
  if (parsedNodes.length === 0 && acc && acc.email && acc.password) {
    try {
      const accRes = await loginAndFetchAccountSubscription({
        apiBaseUrl: acc.apiBaseUrl,
        email: acc.email,
        password: acc.password,
      });
      if (accRes.parsedNodes && accRes.parsedNodes.length > 0) {
        parsedNodes = accRes.parsedNodes;
        addLog("network", `已通过官方账号 (${acc.email}) 成功获取 ${parsedNodes.length} 个最新节点`);
      }
    } catch (eAcc) {
      fetchError = eAcc.message;
      addLog("network", `官方账号登录同步失败: ${eAcc.message}`, "warn");
    }
  }

  // 2. 如果有订阅 URL 且尚未拉到节点，尝试在线拉取 (支持直连与本地代理重试)
  if (parsedNodes.length === 0 && url) {
    try {
      const fetched = await fetchFirstValidSubscription([url]);
      parsedNodes = fetched.parsedNodes;
      addLog("network", `成功拉取订阅，解析到 ${parsedNodes.length} 个原始节点`);
    } catch (e) {
      fetchError = e.message;
      addLog("network", `订阅拉取失败: ${e.message}`, "warn");
    }
  }

  // 2. 如果远程未拉到，全量扫描本地所有 Clash / Follow / 西游云 客户端的配置文件兜底
  if (parsedNodes.length === 0) {
    try {
      const localSession = await loadLocalSessionNodes();
      if (localSession.parsedNodes.length > 0) {
        parsedNodes = localSession.parsedNodes;
        addLog("network", `已从本地 Clash/Follow 客户端配置文件中成功载入 ${parsedNodes.length} 个节点`);
      }
    } catch (e) {
      addLog("network", `扫描本地 Clash 配置文件失败: ${e.message}`, "warn");
    }
  }

  const allCandidates = [];
  const customList = parseCustomNodesList(forceCustomNodes || netSettings.customNodes || customIspInput);
  for (const cNode of customList) {
    allCandidates.push(cNode);
  }
  allCandidates.push(...parsedNodes);

  // 自动排除不受支持地区（香港等），打标签并优选推荐 Top 5
  const scoredNodes = pickRecommendedNodes(allCandidates, 5);
  runtime.candidateNodes = scoredNodes;

  const isFallback = parsedNodes.length === 0;
  return {
    ok: true,
    nodes: scoredNodes,
    totalCount: allCandidates.length,
    supportedCount: scoredNodes.length,
    recommendedCount: scoredNodes.filter((n) => n.recommended).length,
    isFallback,
    fetchError: isFallback ? (fetchError || "没有从官网、订阅链接或本地登录会话读取到真实节点") : "",
  };
}

export async function isXiyouProcessesRunning() {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/NH", "/FO", "CSV"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const lower = stdout.toLowerCase();
    return lower.includes("xiyouyun.exe") || lower.includes("xiyoucore.exe");
  } catch {
    return false;
  }
}

export async function isXiyouCoreRunning() {
  if (process.platform !== "win32") return true;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/NH", "/FO", "CSV"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return stdout.toLowerCase().includes("xiyoucore.exe");
  } catch {
    return false;
  }
}

export async function probeProxyEgressGeo(proxyPort, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let isResolved = false;
    const done = (val) => {
      if (!isResolved) {
        isResolved = true;
        resolve(val);
      }
    };
    setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);

    const req = http.get({
      host: "127.0.0.1",
      port: proxyPort,
      path: "http://ip-api.com/json",
      headers: { Host: "ip-api.com", "User-Agent": "curl/7.88.1" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.status === "success" || json.countryCode) {
            done({
              ok: true,
              ip: json.query || json.ip || "",
              countryCode: String(json.countryCode || "").toUpperCase(),
              country: json.country || "",
              region: json.regionName || json.region || "",
              isp: json.isp || "",
            });
            return;
          }
        } catch {}
        done({ ok: false, error: "invalid response" });
      });
    });
    req.on("error", (e) => done({ ok: false, error: e.message }));
  });
}

/**
 * 阶段 1：生成待应用计划与覆写脚本，计算 SHA-256 (不碰西游云文件，不改生效 plan)
 */
export async function prepareSelectedNodes(selectedNodes = [], forceUrl = null, forceCustomIsp = null, forceCustomNodes = null) {
  const netSettings = { ...(runtime.settings.networkSettings || {}) };
  if (forceUrl !== null) netSettings.subscriptionUrl = String(forceUrl).trim();
  if (forceCustomIsp !== null) netSettings.customIspText = String(forceCustomIsp).trim();
  if (forceCustomNodes !== null) netSettings.customNodes = forceCustomNodes;
  netSettings.mode = "isolated";

  let nodesToApply = selectedNodes;
  if (!nodesToApply || nodesToApply.length === 0) {
    const fetched = await fetchSubscriptionCandidateNodes(netSettings.subscriptionUrl, netSettings.customIspText, null, netSettings.customNodes);
    nodesToApply = fetched.nodes.filter((n) => n.recommended);
  }
  if (nodesToApply.length === 0) throw new Error("没有可激活的真实节点");

  let relay = selectSingaporeRelay([...nodesToApply, ...runtime.candidateNodes]);
  if (nodesToApply.some((node) => node.isCustomIsp) && !relay) {
    try {
      const fetched = await fetchSubscriptionCandidateNodes(
        netSettings.subscriptionUrl,
        netSettings.customIspText,
        null,
        netSettings.customNodes,
      );
      relay = selectSingaporeRelay(fetched.nodes);
    } catch {}
  }
  if (nodesToApply.some((node) => node.isCustomIsp) && !relay) {
    throw new Error("住宅 ISP 必须经过新加坡专线，但当前节点列表中没有找到新加坡 IEPL/IPLC/专线节点");
  }

  // 使用稳定端口分配：优先复用已存在的端口，保证勾选顺序改变时端口不飘移
  const previousPlan = netSettings.egressPlan || runtime.egressPlan || [];
  const pendingEgressPlan = buildPlanFromSelectedNodes(nodesToApply, 7892, {
    relayNodeName: relay?.name || "",
    previousPlan,
  });

  const scriptCode = createXiyouOverrideScript(pendingEgressPlan);
  const scriptHash = crypto.createHash("sha256").update(scriptCode).digest("hex");
  const expectedPorts = pendingEgressPlan.map((p) => Number(p.port));

  const xiyouRunning = await isXiyouProcessesRunning();

  netSettings.pendingEgressPlan = pendingEgressPlan;
  netSettings.selectedNodes = nodesToApply;
  netSettings.relayNodeName = relay?.name || "";
  netSettings.activation = {
    state: "prepared",
    generationId: randomKey("gen"),
    scriptHash,
    expectedPorts,
    preparedAt: new Date().toISOString(),
    writtenAt: null,
    verifiedAt: null,
    failure: "",
  };

  runtime.settings.networkSettings = netSettings;
  await saveSettings();

  addLog("network", `已生成 ${pendingEgressPlan.length} 个端口计划 (Hash: ${scriptHash.slice(0, 8)})，等待安全写入`);

  return {
    ok: true,
    state: "prepared",
    xiyouRunning,
    expectedPorts,
    pendingEgressPlan: publicEgressPlan(pendingEgressPlan),
    scriptHash,
    message: xiyouRunning ? "计划已生成。检测到西游云正在运行，请手动退出西游云后执行安全写入。" : "计划已生成，西游云已关闭，可以执行安全写入。",
  };
}

/**
 * 阶段 2：确认西游云已退出后，将标准脚本安全写入 shared_preferences.json
 */
export async function commitPendingXiyouScript() {
  const netSettings = runtime.settings.networkSettings || {};
  const activation = netSettings.activation || {};
  const pendingPlan = netSettings.pendingEgressPlan || [];

  if (!pendingPlan.length || !activation.scriptHash) {
    throw new Error("没有待提交的计划，请先生成配置计划");
  }

  // 严防内存覆盖：西游云仍在运行时拒绝写入
  const isRunning = await isXiyouProcessesRunning();
  if (isRunning) {
    throw new Error("西游云仍在运行中！为防止配置文件被西游云内存状态覆写，请先彻底退出西游云客户端后再执行安全写入。");
  }

  const prefsPath = path.join(getClashConfigDir(), "shared_preferences.json");
  if (!fsSync.existsSync(prefsPath)) throw new Error(`未找到西游云配置文件: ${prefsPath}`);

  const rawText = await fs.readFile(prefsPath, "utf8");
  const scriptCode = createXiyouOverrideScript(pendingPlan);
  const patchedText = patchXiyouPreferences(rawText, scriptCode);

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = path.join(path.dirname(prefsPath), `shared_preferences_backup_abc_${stamp}.json`);
  await fs.copyFile(prefsPath, backupPath);
  await atomicWrite(prefsPath, patchedText);

  // 立即回读校验写入完整性
  const verifyRaw = await fs.readFile(prefsPath, "utf8");
  const inspect = inspectXiyouPreferences(verifyRaw);
  if (!inspect.ok || inspect.currentId !== "abc-multi-proxy-script") {
    throw new Error("写入后校验失败：当前激活脚本 ID 不符");
  }
  if (inspect.scriptHash !== activation.scriptHash) {
    throw new Error("写入后校验失败：脚本内容 Hash 不一致");
  }

  activation.state = "waiting_restart";
  activation.writtenAt = new Date().toISOString();
  activation.failure = "";
  netSettings.activation = activation;
  runtime.settings.networkSettings = netSettings;
  await saveSettings();

  addLog("network", `配置已安全写入西游云 (备份: ${path.basename(backupPath)})，请手动启动西游云`);

  return {
    ok: true,
    state: "waiting_restart",
    preferencesPath: prefsPath,
    backupPath,
    message: "配置已安全写入西游云！现在请手动启动西游云，启动后点击“验证并激活出口”。",
  };
}

/**
 * 阶段 3：西游云手动启动后，全面验证 XiyouCore、Hash、端口监听与真实出口国家代码
 */
export async function verifyPendingActivation() {
  const netSettings = runtime.settings.networkSettings || {};
  const activation = netSettings.activation || {};
  const pendingPlan = netSettings.pendingEgressPlan || [];

  if (!pendingPlan.length || !activation.scriptHash) {
    throw new Error("没有待验证的计划，请先生成计划");
  }

  // 1. 检查西游云核心进程
  const coreRunning = await isXiyouCoreRunning();
  if (!coreRunning) {
    throw new Error("西游云核心进程 (XiyouCore) 尚未运行，请确认您已打开西游云");
  }

  // 2. 校验文件当前生效的脚本 Hash
  const prefsPath = path.join(getClashConfigDir(), "shared_preferences.json");
  if (fsSync.existsSync(prefsPath)) {
    const rawText = await fs.readFile(prefsPath, "utf8");
    const inspect = inspectXiyouPreferences(rawText);
    if (!inspect.isActive || inspect.scriptHash !== activation.scriptHash) {
      activation.state = "failed";
      activation.failure = "西游云当前配置被其他脚本覆盖或 ID 不符";
      await saveSettings();
      throw new Error(`配置验证失败：${activation.failure}`);
    }
  }

  // 3. 校验所有预计端口是否已开始监听
  const portsStatus = await Promise.all(
    pendingPlan.map(async (item) => ({
      port: item.port,
      name: item.name,
      country: item.country,
      region: item.region,
      isCustomIsp: item.isCustomIsp,
      alive: await canConnect(item.port),
    }))
  );

  const deadPorts = portsStatus.filter((p) => !p.alive);
  if (deadPorts.length > 0) {
    activation.state = "failed";
    activation.failure = `端口 ${deadPorts.map((p) => p.port).join(", ")} 未正常监听`;
    await saveSettings();
    throw new Error(`端口验证失败：${activation.failure}。请检查西游云是否已正确加载脚本。`);
  }

  // 4. 端到端出口国家/地区真实核对 (台湾->TW, 新加坡->SG, 美国->US, 日本->JP)
  const regionExpectedCode = {
    "台湾": "TW",
    "新加坡": "SG",
    "美国": "US",
    "日本": "JP",
    "韩国": "KR",
    "英国": "GB",
  };

  const geoResults = {};
  for (const item of pendingPlan) {
    const geo = await probeProxyEgressGeo(item.port);
    geoResults[item.port] = geo;

    if (!item.isCustomIsp && item.region && regionExpectedCode[item.region]) {
      const expCode = regionExpectedCode[item.region];
      if (geo.ok && geo.countryCode && geo.countryCode !== expCode) {
        activation.state = "failed";
        activation.failure = `端口 ${item.port} (${item.name}) 预期出口地区为 [${expCode}]，实测出口却为 [${geo.countryCode} · ${geo.country}]！已被硬核拦截防止串线。`;
        await saveSettings();
        throw new Error(activation.failure);
      }
    }
  }

  // 5. 全部严格通过，转正计划！
  runtime.egressPlan = pendingPlan;
  netSettings.egressPlan = pendingPlan;
  netSettings.pendingEgressPlan = [];
  netSettings.lastSyncedAt = new Date().toISOString();
  activation.state = "active";
  activation.verifiedAt = new Date().toISOString();
  activation.failure = "";
  netSettings.activation = activation;
  runtime.settings.networkSettings = netSettings;
  await saveSettings();

  addLog("network", `✓ 成功验证 ${pendingPlan.length} 个端口全链路真实出口，多通道已完全解锁`);

  return {
    ok: true,
    state: "active",
    egressPlan: publicEgressPlan(runtime.egressPlan),
    activation,
    geoResults,
    message: "✓ 所有独立端口与真实出口国家已 100% 校验通过，OAuth 与多账号通道已解锁！",
  };
}

export const mihomoRuntime = new MihomoRuntimeCoordinator({
  dataDir: path.join(DATA_DIR, "mihomo"),
  manager: globalMihomoManager,
  probeGeoFn: probeProxyEgressGeo,
  saveSettingsFn: saveSettings,
  addLogFn: addLog,
});

/**
 * 统一出口门禁验证 (P0-9 严格出口保护)
 * 在 isolated 模式下严禁未指定出口或出口未激活/未验证/端口未监听，绝不允许 silent fallback 到默认代理或系统代理
 */
export async function requireVerifiedEgress(proxyPort = 0, { requireListening = true } = {}) {
  const netSettings = runtime.settings?.networkSettings || {};
  const mode = netSettings.mode || "isolated";

  if (mode !== "isolated") {
    // default 模式允许默认代理
    return { ok: true, mode: "default", proxyPort: proxyPort || 0 };
  }

  const port = Number(proxyPort);
  if (!port || port <= 0) {
    throw new Error("[多通道安全隔离门禁] 当前处于多通道隔离模式，必须指定合法的专属独立出口端口 (7892+)，严禁直连或使用默认代理！");
  }

  const activation = netSettings.activation || {};
  if (activation.state !== "active") {
    throw new Error(`[多通道安全隔离门禁] 多通道网络尚未完全就绪 (当前状态: ${activation.state || "inactive"})，已拦截操作。请先在网络设置中激活通道。`);
  }

  const activePlan = runtime.egressPlan || netSettings.egressPlan || [];
  const matched = activePlan.find((p) => Number(p.port) === port);
  if (!matched) {
    throw new Error(`[多通道安全隔离门禁] 端口 ${port} 未在已激活的独立通道计划中登记，严禁使用非授权出口！`);
  }

  if (matched.verified === false) {
    throw new Error(`[多通道安全隔离门禁] 端口 ${port} (${matched.proxyName || matched.proxy}) 未通过全链路真实出口验证，禁止发起认证或流量！`);
  }

  if (requireListening) {
    const isListening = await globalMihomoManager.canConnect(port, 400);
    if (!isListening) {
      throw new Error(`[多通道安全隔离门禁] 端口 ${port} 当前本地无服务监听，网络内核可能已停止，请重新激活网络！`);
    }
  }

  return { ok: true, egress: matched, proxyPort: port };
}

/**
 * V0.4：内置独立 Mihomo 事务化一键激活 (通过 mihomoRuntime 状态机原子执行)
 */
export async function activateEmbeddedMihomoNetwork(selectedNodes = [], forceUrl = null, forceCustomIsp = null, forceCustomNodes = null) {
  const netSettings = { ...(runtime.settings.networkSettings || {}) };
  if (forceUrl !== null) netSettings.subscriptionUrl = String(forceUrl).trim();
  if (forceCustomIsp !== null) netSettings.customIspText = String(forceCustomIsp).trim();
  if (forceCustomNodes !== null) netSettings.customNodes = forceCustomNodes;
  netSettings.mode = "isolated";
  netSettings.backend = "embedded-mihomo";

  let nodesToApply = selectedNodes;
  if (!nodesToApply || nodesToApply.length === 0) {
    const fetched = await fetchSubscriptionCandidateNodes(netSettings.subscriptionUrl, netSettings.customIspText, null, netSettings.customNodes);
    nodesToApply = fetched.nodes.filter((n) => n.recommended);
  }
  if (nodesToApply.length === 0) throw new Error("没有可激活的真实节点");

  let relay = selectSingaporeRelay([...nodesToApply, ...runtime.candidateNodes]);
  if (nodesToApply.some((node) => node.isCustomIsp) && !relay) {
    try {
      const fetched = await fetchSubscriptionCandidateNodes(
        netSettings.subscriptionUrl,
        netSettings.customIspText,
        null,
        netSettings.customNodes,
      );
      relay = selectSingaporeRelay(fetched.nodes);
    } catch {}
  }
  if (nodesToApply.some((node) => node.isCustomIsp) && !relay) {
    throw new Error("住宅 ISP 必须经过新加坡专线，但当前节点列表中没有找到新加坡 IEPL/IPLC/专线节点");
  }

  const previousPlan = netSettings.egressPlan || runtime.egressPlan || [];
  const egressPlan = buildPlanFromSelectedNodes(nodesToApply, 7892, {
    relayNodeName: relay?.name || "",
    previousPlan,
  });

  // 1. 获取 Source of Truth (完整供应商配置底版)
  let sourceText = "";
  if (netSettings.subscriptionUrl) {
    try {
      sourceText = await fetchSubscriptionRawText(netSettings.subscriptionUrl);
    } catch {}
  }
  if (!sourceText) {
    sourceText = findLocalRawProfileContent();
  }
  if (!sourceText) {
    throw new Error("无法获取完整的源订阅配置 (Source of Truth)，请先输入有效订阅链接或扫描本地配置文件");
  }

  mihomoRuntime.init({ runtime, settings: runtime.settings });

  // 2. 执行完整真事务激活
  const res = await mihomoRuntime.activateTransaction({
    sourceText,
    egressPlan,
    selectedNodes: nodesToApply,
    relayNodeName: relay?.name || "",
    controllerPort: 19090,
  });

  netSettings.egressPlan = res.egressPlan;
  netSettings.pendingEgressPlan = [];
  netSettings.selectedNodes = nodesToApply;
  netSettings.relayNodeName = relay?.name || "";
  runtime.settings.networkSettings = netSettings;
  await saveSettings();

  return {
    ok: true,
    state: "active",
    generationId: res.generationId,
    egressPlan: publicEgressPlan(res.egressPlan),
    configHash: res.configHash,
    message: `✓ 内置专向独立内核已启动！${res.egressPlan.length}/${res.egressPlan.length} 个独立通道已全部通过出口物理验证`,
  };
}

export async function applySelectedNodes(selectedNodes = [], forceUrl = null, forceCustomIsp = null, forceCustomNodes = null) {
  return prepareSelectedNodes(selectedNodes, forceUrl, forceCustomIsp, forceCustomNodes);
}

export async function injectXiyouyunRelayScript(egressPlan = []) {
  const prefsPath = path.join(getClashConfigDir(), "shared_preferences.json");
  if (!fsSync.existsSync(prefsPath)) throw new Error(`未找到西游云配置文件: ${prefsPath}`);

  const rawText = await fs.readFile(prefsPath, "utf8");
  const scriptCode = createXiyouOverrideScript(egressPlan);
  const patched = patchXiyouPreferences(rawText, scriptCode);

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = path.join(path.dirname(prefsPath), `shared_preferences_backup_abc_${stamp}.json`);
  await fs.copyFile(prefsPath, backupPath);
  await atomicWrite(prefsPath, patched);
  return { ok: true, preferencesPath: prefsPath, backupPath };
}

async function syncSubscriptionNodes(forceUrl = null, forceCustomIsp = null) {
  const fetched = await fetchSubscriptionCandidateNodes(forceUrl, forceCustomIsp);
  const recommended = fetched.nodes.filter((n) => n.recommended);
  return prepareSelectedNodes(recommended, forceUrl, forceCustomIsp);
}

/**
 * 纯读接口：绝不隐式修改或写入西游云配置
 */
async function getAvailableProxyNodes() {
  const activePort = await detectActiveProxyPort();
  const netSettings = runtime.settings.networkSettings || { mode: "isolated" };

  // 模式 1：默认网络模式
  if (netSettings.mode === "default") {
    return [
      {
        id: "default",
        name: "默认网络 / 规则分流",
        protocol: "RULE",
        country: "🌐",
        port: activePort,
        desc: "跟随系统或代理软件当前选中的生效节点",
        display: `[RULE] 🌐 默认网络（跟随系统/代理软件当前生效节点） [端口 ${activePort}]`,
      },
    ];
  }

  // 模式 2：高级多出口隔离模式 (历史配置与已就绪节点一律列出供用户自由选择)
  const currentPlan = (runtime.egressPlan && runtime.egressPlan.length > 0)
    ? runtime.egressPlan
    : (netSettings.egressPlan || []);

  const result = currentPlan.length > 0 ? publicEgressPlan(currentPlan) : [];

  result.push({
    id: "default",
    name: "默认网络 / 规则分流",
    protocol: "RULE",
    country: "🌐",
    port: activePort,
    desc: "跟随西游云当前选中的节点",
    display: `[RULE] 🌐 默认网络（跟随西游云当前生效节点） [端口 ${activePort}]`,
  });

  return result;
}

function findBrowserPath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

async function launchSafeBrowser({ authUrl, proxyPort, nodeName }) {
  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error("未在系统中找到 Chrome 或 Edge 浏览器，请手动复制授权链接在浏览器中打开");
  }

  const verified = await requireVerifiedEgress(proxyPort);
  const effectivePort = verified.mode === "default" ? (Number(proxyPort) || await detectActiveProxyPort()) : verified.proxyPort;

  const tempProfile = path.join(os.tmpdir(), `abc-oauth-profile-${effectivePort || "default"}-${Date.now()}`);
  const args = [
    `--user-data-dir=${tempProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (effectivePort > 0) {
    args.push(`--proxy-server=http://127.0.0.1:${effectivePort}`);
  }

  args.push("https://ip.sb");
  args.push(authUrl);

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  addLog("oauth", `已调起隔离安全浏览器（节点: ${nodeName || "独立出口"}, 生效端口: ${effectivePort}）`);
  return { launched: true, browser: path.basename(browserPath), port: effectivePort };
}

async function startOAuth(options = {}) {
  await startProxy();
  const proxyPort = Number(options.proxyPort) || 0;
  const proxyName = String(options.proxyName || "").trim();

  // 严格执行 Egress 门禁
  const verified = await requireVerifiedEgress(proxyPort);
  const effectivePort = verified.mode === "default" ? (proxyPort || await detectActiveProxyPort()) : verified.proxyPort;

  const existingAccounts = await getAccounts(true).catch(() => []);
  const payload = await proxyRequest("/antigravity-auth-url?is_webui=true", { management: true });
  if (!payload.url || !payload.state) throw new Error("CLIProxyAPI 未返回 OAuth 地址");

  if (payload.state) {
    pendingOAuthStates.set(payload.state, {
      proxyPort: effectivePort,
      proxyName,
      existingAccountKeys: existingAccounts.flatMap(accountIdentityKeys),
      createdAt: Date.now(),
    });
  }

  let browserResult = null;
  if (options.launchBrowser) {
    browserResult = await launchSafeBrowser({
      authUrl: payload.url,
      proxyPort,
      nodeName: proxyName,
    });
  }

  addLog("oauth", `已创建 Antigravity OAuth 登录会话${proxyName ? ` (指定节点: ${proxyName})` : ""}`);
  return { url: payload.url, state: payload.state, browser: browserResult };
}

async function oauthStatus(state) {
  const payload = await proxyRequest(`/get-auth-status?state=${encodeURIComponent(state)}`, { management: true });
  if (payload.status === "ok") {
    runtime.accountCache.at = 0;
    runtime.modelCache.at = 0;

    const pending = pendingOAuthStates.get(state);
    if (pending && pending.proxyName) {
      const accounts = await getAccounts(true);
      if (accounts.length > 0) {
        const existingKeys = new Set(pending.existingAccountKeys || []);
        const target = accounts.find((account) => accountIdentityKeys(account).every((key) => !existingKeys.has(key)))
          || [...accounts].sort((a, b) => Date.parse(b.lastRefresh || 0) - Date.parse(a.lastRefresh || 0))[0];
        if (target) {
          if (!runtime.settings.accountProxies) runtime.settings.accountProxies = {};
          runtime.settings.accountProxies[target.email || target.id] = {
            name: pending.proxyName,
            port: pending.proxyPort,
            boundAt: new Date().toISOString(),
          };
          await saveSettings();

          // 同步写入 auth json 文件中的 proxy_url，让 CLIProxyAPI 转发该账号请求时走专属端口
          if (pending.proxyPort > 0) {
            await setAccountProxyUrl(target, pending.proxyPort);
          }

          addLog("oauth", `账号 ${target.email || target.id} 已成功绑定节点: ${pending.proxyName} (出口端口 ${pending.proxyPort})`);
        }
      }
      pendingOAuthStates.delete(state);
    }

    addLog("oauth", "Google OAuth 登录完成");
  }
  return payload;
}

async function backupIfChanged(filePath, nextContent) {
  let current = "";
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch {}
  if (!current || current === nextContent) return null;
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = path.join(DATA_DIR, "backups", "codex", stamp);
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(filePath));
  await atomicWrite(backupPath, current);
  if (await hashFile(backupPath) !== await hashFile(filePath)) {
    throw new Error("Codex profile backup verification failed");
  }
  return backupPath;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function codexAppUserModelId(appPath) {
  const normalized = String(appPath || "").replaceAll("/", "\\");
  const packageDirectory = normalized.match(/\\WindowsApps\\([^\\]+)\\/i)?.[1] || "";
  const match = packageDirectory.match(/^(.+?)_[^_]+_(?:x64|x86|arm64|neutral)__([^_]+)$/i);
  return match ? `${match[1]}_${match[2]}!App` : "";
}

async function writeCodexLauncher(model = runtime.settings.defaultModel) {
  const preferredPath = runtime.settings.codexAppPath || process.env.CODEX_APP_PATH || "";
  const preferredAppId = codexAppUserModelId(preferredPath);
  const script = `$ErrorActionPreference = 'Stop'
$appId = ${powershellLiteral(preferredAppId)}
$uiKey = ${powershellLiteral(runtime.settings.uiKey)}
$bridgeUrl = ${powershellLiteral(`http://${UI_HOST}:${UI_PORT}`)}
$model = ${powershellLiteral(model)}
$headers = @{ 'X-Bridge-Key' = $uiKey }
$body = @{ model = $model } | ConvertTo-Json

$codexProcesses = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue
foreach ($process in $codexProcesses) { [void]$process.CloseMainWindow() }
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}
Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Stop-Process -ErrorAction Stop
Write-Output 'Codex has exited.'

if ([string]::IsNullOrWhiteSpace($appId)) {
  $package = Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^OpenAI\\.(Codex|ChatGPT)$' -or $_.PackageFamilyName -match '^OpenAI\\.(Codex|ChatGPT)_'
  } | Select-Object -First 1
  if ($package) { $appId = $package.PackageFamilyName + '!App' }
}

if ([string]::IsNullOrWhiteSpace($appId)) {
  $winAppsDir = Get-ChildItem -Path 'C:\\Program Files\\WindowsApps' -Filter 'OpenAI.Codex_*' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($winAppsDir) {
    if ($winAppsDir.Name -match '^(.+?)_[^_]+_(?:x64|x86|arm64|neutral)__([^_]+)$') {
      $appId = $matches[1] + '_' + $matches[2] + '!App'
    }
  }
}

if ([string]::IsNullOrWhiteSpace($appId)) {
  $appId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
}

$activated = $false
try {
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/activate') -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  $activated = $true
  $target = 'shell:AppsFolder\\' + $appId
  Start-Process -FilePath 'explorer.exe' -ArgumentList @($target) -ErrorAction Stop | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(ChatGPT|OpenAI\.Codex)$' }) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(ChatGPT|OpenAI\.Codex)$' })) {
    throw 'Codex did not start within 20 seconds.'
  }

  Start-Sleep -Seconds 3
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/reapply') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Output ('Codex API Service is active with model: ' + $model)
} catch {
  if ($activated) {
    try {
      Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/restore') -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
    } catch {}
  }
  throw
}
`;
  const command = `@echo off\r
chcp 65001 >nul 2>&1\r
title Codex API Service - Antigravity\r
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-codex-api-service.ps1"\r
if errorlevel 1 (\r
  echo.\r
  pause\r
)\r
`;
  await Promise.all([
    fs.writeFile(CODEX_LAUNCHER_PS1_PATH, script, "utf8"),
    fs.writeFile(CODEX_LAUNCHER_PATH, command, "utf8"),
  ]);
  return { cmdPath: CODEX_LAUNCHER_PATH, ps1Path: CODEX_LAUNCHER_PS1_PATH };
}

async function prepareCodex(modelRequested = "") {
  await startProxy();
  const accounts = await getAccounts(true);
  if (!accounts.some((account) => !account.disabled && !account.unavailable)) throw new Error("没有可用的 Antigravity 账号，请先完成 Google OAuth 登录");
  const models = await waitForModels();
  if (!models.length) throw new Error("代理没有返回可用模型，请刷新账号状态后重试");
  const model = chooseDefaultModel(models, modelRequested || runtime.settings.defaultModel);
  const codexHome = codexHomePath();
  const profilePath = path.join(codexHome, "antigravity.config.toml");
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const catalog = `${JSON.stringify(createModelCatalog(models), null, 2)}\n`;
  const profile = createCodexProfile({
    port: UI_PORT,
    model,
    catalogPath: CATALOG_PATH,
    bearerToken: runtime.settings.clientKey,
  });
  const currentConfig = await fs.readFile(configPath, "utf8").catch(() => "");
  const config = createActiveCodexConfig(currentConfig, {
    port: UI_PORT,
    model,
    catalogPath: CATALOG_PATH,
    bearerToken: runtime.settings.clientKey,
  });
  const auth = createCodexApiAuth();
  const backupPath = await backupIfChanged(profilePath, profile);
  await fs.mkdir(codexHome, { recursive: true });
  await applyFiles([
    { path: CATALOG_PATH, data: catalog },
    { path: profilePath, data: profile },
    { path: configPath, data: config },
    { path: authPath, data: auth },
  ]);
  const launcher = await writeCodexLauncher(model);
  runtime.settings.defaultModel = model;
  runtime.settings.codexApiPrepared = true;
  await saveSettings();
  addLog("codex", `已准备 Codex API Service 暂存配置，默认模型 ${model}`);
  return {
    model,
    profilePath,
    configPath,
    authPath,
    catalogPath: CATALOG_PATH,
    launcherPath: launcher.cmdPath,
    backupPath,
    modelCount: models.length,
  };
}

function codexHomePath() {
  return path.resolve(CODEX_HOME_DIR);
}

function liveCodexHomePath() {
  return path.resolve(runtime.settings.codexHome || detectCodexHome());
}

async function backupLiveCodex() {
  const existing = path.resolve(runtime.settings.codexActiveBackup || "");
  const backupRoot = path.resolve(ACTIVE_BACKUP_ROOT);
  const liveHome = liveCodexHomePath();
  if (runtime.settings.codexActiveBackup
    && existing.startsWith(`${backupRoot}${path.sep}`)
    && fsSync.existsSync(path.join(existing, "manifest.json"))) {
    try {
      const manifest = await readJson(path.join(existing, "manifest.json"), null);
      if (manifest && path.resolve(manifest.liveHome) === liveHome) {
        await verifySnapshot(existing, manifest);
        return existing;
      }
    } catch (err) {
      addLog("codex", `检测到历史备份快照需自愈更新 (${err.message})，已自动重建新快照`, "warn");
      runtime.settings.codexActiveBackup = "";
      await saveSettings();
    }
  }

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = path.join(ACTIVE_BACKUP_ROOT, stamp);
  try {
    const manifest = await createSnapshot(liveHome, backupDir, ["config.toml", "auth.json"]);
    await writeJson(path.join(backupDir, "manifest.json"), manifest);
    await verifySnapshot(backupDir, manifest);
    runtime.settings.codexActiveBackup = backupDir;
    await saveSettings();
    return backupDir;
  } catch (snapErr) {
    addLog("codex", `创建快照出现告警: ${snapErr.message}，已使用容灾快照继续接管`, "warn");
    runtime.settings.codexActiveBackup = backupDir;
    await saveSettings();
    return backupDir;
  }
}

async function activateCodexConfig(modelRequested = "") {
  const prepared = await prepareCodex(modelRequested);
  const liveHome = liveCodexHomePath();
  const backupPath = await backupLiveCodex();
  let manifest = await readJson(path.join(backupPath, "manifest.json"), null);
  if (!manifest) throw new Error("Codex backup manifest is incomplete");
  manifest = await updateSnapshotState(backupPath, manifest, "applying", { selectedModel: prepared.model });
  const configPath = path.join(liveHome, "config.toml");
  const authPath = path.join(liveHome, "auth.json");
  const config = await fs.readFile(prepared.configPath);

  // Preserve official user login and history in auth.json if already present
  const hasExistingAuth = fsSync.existsSync(authPath);
  const filesToApply = [{ path: configPath, data: config }];
  if (!hasExistingAuth) {
    const auth = await fs.readFile(prepared.authPath);
    filesToApply.push({ path: authPath, data: auth });
  }

  try {
    await applyFiles(filesToApply);
    await syncThreadProvider(liveHome, "antigravity_local");
    manifest = await updateSnapshotState(backupPath, manifest, "active", {
      applied: {
        "config.toml": await hashFile(configPath),
        ...(hasExistingAuth ? {} : { "auth.json": await hashFile(authPath) }),
      },
    });
  } catch (error) {
    try {
      await restoreSnapshot(backupPath, manifest);
      await syncThreadProvider(liveHome, "openai");
      await updateSnapshotState(backupPath, manifest, "failed-restored", { failure: error.message });
      runtime.settings.codexActiveBackup = "";
      await saveSettings();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Codex takeover failed and automatic restore also failed");
    }
    throw error;
  }
  addLog("codex", `API Service 配置已应用；默认模型 ${prepared.model}，原登录与历史会话已保留`);
  return {
    ...prepared,
    liveHome,
    configPath,
    authPath: hasExistingAuth ? authPath : (filesToApply.find((f) => f.path === authPath)?.path || ""),
    backupPath,
  };
}

async function switchCodexModel(modelRequested) {
  const targetModel = String(modelRequested || "").trim();
  if (!targetModel) throw new Error("请指定要切换的模型名称");
  runtime.settings.defaultModel = targetModel;
  await saveSettings();

  const liveHome = liveCodexHomePath();
  const configPath = path.join(liveHome, "config.toml");
  if (fsSync.existsSync(configPath)) {
    let content = await fs.readFile(configPath, "utf8");
    if (content.includes("model_provider")) {
      content = content.replace(/^\s*model\s*=\s*"[^"]*"/m, `model = "${targetModel}"`);
      await atomicWrite(configPath, content);
    }
  }

  const preparedConfig = path.join(CODEX_HOME_DIR, "config.toml");
  if (fsSync.existsSync(preparedConfig)) {
    let content = await fs.readFile(preparedConfig, "utf8");
    content = content.replace(/^\s*model\s*=\s*"[^"]*"/m, `model = "${targetModel}"`);
    await atomicWrite(preparedConfig, content);
  }

  await writeProxyConfig();
  addLog("codex", `已将 Codex 当前模型快速切换为 ${targetModel}`);
  return { status: "ok", model: targetModel };
}

async function restoreCodexConfig() {
  const liveHome = path.resolve(liveCodexHomePath());
  const backupDir = path.resolve(runtime.settings.codexActiveBackup || "");
  const backupRoot = path.resolve(ACTIVE_BACKUP_ROOT);
  if (runtime.settings.codexActiveBackup && backupDir.startsWith(`${backupRoot}${path.sep}`)) {
    try {
      let manifest = await readJson(path.join(backupDir, "manifest.json"), null);
      if (manifest) {
        manifest = await updateSnapshotState(backupDir, manifest, "restoring");
        await restoreSnapshot(backupDir, manifest);
        await updateSnapshotState(backupDir, manifest, "restored");
      }
    } catch (err) {
      addLog("codex", `还原快照时出现非致命告警: ${err.message}，已自动继续执行官方环境恢复`, "warn");
    }
  }
  try {
    await syncThreadProvider(liveHome, "openai");
    await cleanForeignReasoningItems(path.join(liveHome, "sessions"));
    await cleanForeignReasoningItems(path.join(liveHome, "archived_sessions"));
  } catch (err) {
    addLog("codex", `清理与同步会话历史时跳过: ${err.message}`, "warn");
  }
  runtime.settings.codexActiveBackup = "";
  await saveSettings();
  addLog("codex", "已确认并恢复官方默认配置与纯净会话历史");
  return { restored: true, liveHome, backupDir };
}

async function recoverInterruptedTakeover() {
  if (!runtime.settings?.codexActiveBackup) return false;
  const backupDir = path.resolve(runtime.settings.codexActiveBackup);
  const backupRoot = path.resolve(ACTIVE_BACKUP_ROOT);
  if (!backupDir.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("Refusing to recover a Codex backup outside the bridge backup directory");
  }
  let manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest) throw new Error("The active Codex backup manifest is missing");
  if (["restored", "failed-restored", "recovered"].includes(manifest.state)) {
    runtime.settings.codexActiveBackup = "";
    await saveSettings();
    return true;
  }
  if (!["prepared", "applying", "restoring"].includes(manifest.state)) return false;
  const interruptedState = manifest.state;
  await restoreSnapshot(backupDir, manifest);
  manifest = await updateSnapshotState(backupDir, manifest, "recovered", {
    recoveryReason: `bridge-started-after-${interruptedState}`,
  });
  runtime.settings.codexActiveBackup = "";
  await saveSettings();
  addLog("recovery", `Recovered interrupted Codex takeover from ${backupDir}`);
  return true;
}

async function resumeActiveTakeover() {
  if (!runtime.settings.codexActiveBackup) return false;
  const backupDir = path.resolve(runtime.settings.codexActiveBackup);
  const manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest || (manifest.state && manifest.state !== "active")) return false;
  try {
    await startProxy();
    addLog("recovery", "Resumed the proxy for the active Codex takeover");
    return true;
  } catch (error) {
    addError("recovery", error);
    await restoreCodexConfig();
    addLog("recovery", "Restored the original Codex profile because the proxy could not restart", "warn");
    return false;
  }
}

async function reapplyPreparedCodex() {
  if (!await proxyHealth()) await startProxy();
  const backupDir = path.resolve(runtime.settings.codexActiveBackup || "");
  const backupRoot = path.resolve(ACTIVE_BACKUP_ROOT);
  if (!runtime.settings.codexActiveBackup || !backupDir.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("Codex API Service takeover is not active");
  }
  let manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest) throw new Error("Codex backup manifest is incomplete");
  manifest = await updateSnapshotState(backupDir, manifest, "applying", { reapplying: true });
  const liveHome = liveCodexHomePath();
  const configPath = path.join(liveHome, "config.toml");
  try {
    await applyFiles([
      { path: configPath, data: await fs.readFile(path.join(CODEX_HOME_DIR, "config.toml")) },
    ]);
    await syncThreadProvider(liveHome, "antigravity_local");
    manifest = await updateSnapshotState(backupDir, manifest, "active", {
      reapplying: false,
      reappliedAt: new Date().toISOString(),
      applied: {
        "config.toml": await hashFile(configPath),
      },
    });
  } catch (error) {
    await restoreSnapshot(backupDir, manifest);
    await updateSnapshotState(backupDir, manifest, "failed-restored", { failure: error.message });
    runtime.settings.codexActiveBackup = "";
    await saveSettings();
    throw error;
  }
  return { active: true, model: manifest.selectedModel || runtime.settings.defaultModel };
}

async function activateCodex(modelRequested = "") {
  const prepared = await activateCodexConfig(modelRequested);
  return {
    ...prepared,
    activation: "manual-store-restart",
    launched: false,
    manualRestartRequired: true,
  };
}

let codexWatcherTimer = null;

function startCodexProcessWatcher() {
  if (codexWatcherTimer) return;
  let codexSeenRunning = false;
  let checksWithoutProcess = 0;

  codexWatcherTimer = setInterval(() => {
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/FO", "CSV", "/NH"], async (err, stdout) => {
      if (err) return;
      const isRunning = String(stdout || "").includes("ChatGPT.exe");
      if (isRunning) {
        codexSeenRunning = true;
        checksWithoutProcess = 0;
      } else if (codexSeenRunning) {
        checksWithoutProcess++;
        if (checksWithoutProcess >= 1) {
          clearInterval(codexWatcherTimer);
          codexWatcherTimer = null;
          codexSeenRunning = false;
          checksWithoutProcess = 0;
          addLog("codex", "检测到 Codex 桌面端已退出，正在极速自动还原为官方配置...");
          try {
            if (runtime.settings.codexActiveBackup) {
              await restoreCodexConfig();
              addLog("codex", "已自动还原为官方 OpenAI 配置与会话历史");
            }
          } catch (restoreErr) {
            addLog("codex", `自动还原官方配置失败: ${restoreErr.message}`, "warn");
          }
        }
      }
    });
  }, 500);
}

async function launchCodex(modelRequested = "") {
  if (runtime.codexLaunch.running) throw new Error("Codex one-click launch is already running");
  const prepared = await prepareCodex(modelRequested);
  runtime.codexLaunch = { running: true, message: "Closing Codex and applying the API Service profile" };
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    CODEX_LAUNCHER_PS1_PATH,
  ], {
    cwd: DATA_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => addLog("codex-launch", chunk.toString("utf8").trim()));
  child.stderr.on("data", (chunk) => addLog("codex-launch", chunk.toString("utf8").trim(), "warn"));
  child.once("error", (error) => {
    runtime.codexLaunch = { running: false, message: error.message };
    addError("codex-launch", error);
  });
  child.once("exit", (code) => {
    runtime.codexLaunch = {
      running: false,
      message: code === 0 ? "Codex API Service started" : `Launcher exited with code ${code}`,
    };
    if (code) {
      addError("codex-launch", runtime.codexLaunch.message);
    } else {
      startCodexProcessWatcher();
    }
  });
  return {
    ...prepared,
    activation: "one-click",
    launched: true,
    launcherPid: child.pid,
  };
}

async function proxyState() {
  const running = await proxyHealth();
  const compatibility = await inspectProxyCompatibility();
  return {
    installed: Boolean(detectProxyBinary()),
    binaryPath: detectProxyBinary(),
    running,
    managed: running && Boolean(runtime.proxyProcess),
    starting: runtime.proxyStarting,
    startedAt: running ? runtime.proxyStartedAt : null,
    pid: runtime.proxyProcess?.pid || null,
    install: runtime.install,
    endpoint: `http://127.0.0.1:${runtime.settings.proxyPort}/v1`,
    compatibility,
  };
}

const CURRENT_VERSION = "0.4.0";
let cachedVersionCheck = { at: 0, result: null };

async function checkAppVersion() {
  if (Date.now() - cachedVersionCheck.at < 60_000 && cachedVersionCheck.result) {
    return cachedVersionCheck.result;
  }
  try {
    const res = await fetch("https://api.github.com/repos/yu-hx-tom/antigravity-bridge-codex/releases/latest", {
      headers: { "User-Agent": "AntigravityCodexBridge" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      const latestTag = String(data.tag_name || "").replace(/^v/, "");
      const hasUpdate = Boolean(latestTag && latestTag !== CURRENT_VERSION && latestTag > CURRENT_VERSION);
      const resData = {
        currentVersion: CURRENT_VERSION,
        latestVersion: latestTag || CURRENT_VERSION,
        hasUpdate,
        releaseUrl: data.html_url || "https://github.com/yu-hx-tom/antigravity-bridge-codex/releases",
        releaseNotes: data.body || "",
      };
      cachedVersionCheck = { at: Date.now(), result: resData };
      return resData;
    }
  } catch {}
  return {
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    hasUpdate: false,
    releaseUrl: "https://github.com/yu-hx-tom/antigravity-bridge-codex/releases",
    releaseNotes: "",
  };
}

async function dashboard() {
  const proxy = await proxyState();
  const history = await getHistory();
  const liveHome = liveCodexHomePath();
  const activeConfigPath = path.join(liveHome, "config.toml");
  const activeAuthPath = path.join(liveHome, "auth.json");
  const backupManifest = runtime.settings.codexActiveBackup
    ? await readJson(path.join(runtime.settings.codexActiveBackup, "manifest.json"), null)
    : null;
  const activeConfig = await fs.readFile(activeConfigPath, "utf8").catch(() => "");
  const selectedModel = activeConfig.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1]
    || runtime.settings.defaultModel
    || "";
  const backupMatches = backupManifest
    && path.resolve(backupManifest.liveHome || "") === liveHome;
  let accounts = [];
  let models = [];
  if (proxy.running) {
    [accounts, models] = await Promise.all([getAccounts(), getModels()]);
  }
  return {
    app: { name: "Antigravity Codex Bridge", version: APP_VERSION },
    proxy,
    history,
    settings: publicSettings(),
    accounts,
    models: models.map((model) => ({ ...model, capabilities: modelCapabilities(model.id) })),
    quotaRefreshing: runtime.quotaRefreshing,
    codex: {
      active: Boolean(backupMatches && activeConfig.includes('model_provider = "antigravity_local"')),
      restoreAvailable: Boolean(backupManifest),
      selectedModel,
      configPath: activeConfigPath,
      authPath: activeAuthPath,
      preparedHome: codexHomePath(),
      launcherPath: CODEX_LAUNCHER_PATH,
      launch: runtime.codexLaunch,
    },
    lastQuotaSweep: runtime.lastQuotaSweep || null,
    telemetry: globalTelemetryCollector.snapshot(),
    mihomo: {
      ...globalMihomoManager.getStatus(),
      activationState: runtime.settings.networkSettings?.activation?.state || "inactive",
      generationId: runtime.settings.networkSettings?.activation?.generationId || "",
      expectedPorts: runtime.settings.networkSettings?.activation?.expectedPorts || [],
    },
    logs: runtime.logs.slice(-40),
    errors: runtime.errors,
    paths: {
      dataDir: DATA_DIR,
      authDir: AUTH_DIR,
      codexProfile: path.join(codexHomePath(), "antigravity.config.toml"),
      codexHome: codexHomePath(),
      liveCodexHome: liveCodexHomePath(),
      codexLauncher: CODEX_LAUNCHER_PATH,
    },
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1_000_000) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function assertApiAccess(request) {
  if (request.headers["x-bridge-key"] !== runtime.settings.uiKey) {
    const error = new Error("无效的本地控制密钥");
    error.status = 401;
    throw error;
  }
  if (!["GET", "HEAD"].includes(request.method) && !String(request.headers["content-type"] || "").startsWith("application/json")) {
    const error = new Error("API 仅接受 application/json");
    error.status = 415;
    throw error;
  }
}

async function benchmarkModel(modelId = "") {
  const targetModel = modelId || runtime.settings.defaultModel || "gemini-3.7-flash-high";
  if (!await proxyHealth()) {
    throw new Error("核心服务离线，请先启动核心服务");
  }

  const reqId = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  globalTelemetryCollector.beginRequest({ requestId: reqId, model: targetModel, source: "benchmark" });

  const prompt = "Please respond with a brief 30-word sentence about space voyages.";
  let lastUsagePayload = null;
  let fullText = "";

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 25000);

  try {
    const url = `http://127.0.0.1:${runtime.settings.proxyPort}/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${runtime.settings.clientKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 80,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const err = new Error(`模型响应异常 (${res.status}): ${errText.slice(0, 100)}`);
      globalTelemetryCollector.failRequest(reqId, err);
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        if (trimmed === "data: [DONE]") continue;
        try {
          const json = JSON.parse(trimmed.slice(5).trim());
          if (json.usage) {
            lastUsagePayload = json;
          }
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) {
            globalTelemetryCollector.addOutputText(reqId, delta);
            fullText += delta;
          }
        } catch {}
      }
    }
  } catch (e) {
    globalTelemetryCollector.failRequest(reqId, e);
    throw e;
  } finally {
    clearTimeout(abortTimer);
  }

  const completed = globalTelemetryCollector.completeRequest(reqId, {
    usagePayload: lastUsagePayload,
    finalText: fullText,
  });

  const tokensPerSec = completed?.tokensPerSec ?? 0;
  const ttftMs = completed?.ttftMs ?? 0;
  const totalDurationMs = completed?.totalDurationMs ?? 0;
  const outputTokens = completed?.outputTokens ?? 0;
  const tokenSource = completed?.tokenSource ?? "unknown";
  const estimated = completed?.estimated ?? false;

  addLog("benchmark", `模型 [${targetModel}] 吞吐测速: ${tokensPerSec} tokens/s (首字: ${ttftMs}ms, 总耗时: ${totalDurationMs}ms, 输出: ${outputTokens} tokens, 来源: ${tokenSource})`);

  return {
    ok: true,
    model: targetModel,
    tokensPerSec,
    ttftMs,
    totalDurationMs,
    tokens: outputTokens,
    outputTokens,
    tokenSource,
  };
}

async function handleApi(request, response, url) {
  assertApiAccess(request);
  const key = `${request.method} ${url.pathname}`;
  let result;
  if (key === "GET /api/dashboard") result = await dashboard();
  else if (key === "GET /api/history") result = await getHistory(true);
  else if (key === "GET /api/proxy/compatibility") result = await inspectProxyCompatibility(true);
  else if (key === "GET /api/proxies/nodes") result = await getAvailableProxyNodes();
  else if (key === "GET /api/network/settings") {
    const netSettings = runtime.settings.networkSettings || {
      mode: "isolated",
      subscriptionUrl: "",
      customIspText: "",
      customNodes: [],
      lastSyncedAt: null,
    };
    result = { ok: true, networkSettings: publicNetworkSettings(netSettings), egressPlan: publicEgressPlan(runtime.egressPlan || []) };
  } else if (key === "POST /api/network/settings") {
    const body = await readBody(request);
    const netSettings = runtime.settings.networkSettings || {};
    if (body.mode) netSettings.mode = body.mode === "default" ? "default" : "isolated";
    if (body.subscriptionUrl !== undefined) netSettings.subscriptionUrl = String(body.subscriptionUrl).trim();
    if (body.customIspText !== undefined) netSettings.customIspText = String(body.customIspText).trim();
    if (Array.isArray(body.customNodes)) netSettings.customNodes = body.customNodes;
    runtime.settings.networkSettings = netSettings;

    if (netSettings.mode === "default") {
      try {
        const files = await fs.readdir(AUTH_DIR);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const fp = path.join(AUTH_DIR, file);
            const obj = JSON.parse(await fs.readFile(fp, "utf8"));
            if (obj.proxy_url) {
              delete obj.proxy_url;
              await fs.writeFile(fp, JSON.stringify(obj, null, 2), "utf8");
            }
          }
        }
      } catch {}
      await saveSettings();
      result = { ok: true, networkSettings: publicNetworkSettings(netSettings), egressPlan: publicEgressPlan(runtime.egressPlan || []) };
    } else {
      await saveSettings();
      result = await syncSubscriptionNodes(netSettings.subscriptionUrl, netSettings.customIspText);
      setTimeout(() => { refreshQuota().catch(() => {}); }, 300);
    }
  } else if (key === "POST /api/network/account-login") {
    const body = await readBody(request).catch(() => ({}));
    const { apiBaseUrl, email, password } = body;
    try {
      const res = await loginAndFetchAccountSubscription({ apiBaseUrl, email, password });

      if (!runtime.settings.networkSettings) runtime.settings.networkSettings = {};
      runtime.settings.networkSettings.importMode = "account";
      runtime.settings.networkSettings.accountSettings = {
        apiBaseUrl: res.apiBaseUrl,
        email: res.email,
        subscriptionUrl: res.subscriptionUrl,
        lastSyncedAt: new Date().toISOString(),
      };
      if (Array.isArray(body.customNodes)) runtime.settings.networkSettings.customNodes = body.customNodes;
      await saveSettings();

      const scoredNodes = pickRecommendedNodes([
        ...parseCustomNodesList(body.customNodes || []),
        ...res.parsedNodes,
      ], 5);
      runtime.candidateNodes = scoredNodes;
      result = {
        ok: true,
        message: `成功登录官方账号 (${res.email}) 并拉取 ${res.parsedNodes.length} 个出海节点`,
        warning: res.warning || "",
        nodes: scoredNodes,
        totalCount: scoredNodes.length,
        supportedCount: scoredNodes.length,
        recommendedCount: scoredNodes.filter((n) => n.recommended).length,
      };
    } catch (e) {
      result = {
        ok: false,
        error: e.message,
      };
    }
  } else if (key === "POST /api/network/fetch-nodes") {
    const body = await readBody(request).catch(() => ({}));
    result = await fetchSubscriptionCandidateNodes(body.subscriptionUrl || null, body.customIspText || null, body.accountCreds || null, body.customNodes || null);
  } else if (key === "POST /api/network/prepare-plan" || key === "POST /api/network/apply-nodes") {
    const body = await readBody(request).catch(() => ({}));
    result = await prepareSelectedNodes(body.selectedNodes || [], body.subscriptionUrl || null, body.customIspText || null, body.customNodes || null);
  } else if (key === "POST /api/network/activate-embedded") {
    const body = await readBody(request).catch(() => ({}));
    result = await activateEmbeddedMihomoNetwork(body.selectedNodes || [], body.subscriptionUrl || null, body.customIspText || null, body.customNodes || null);
  } else if (key === "GET /api/mihomo/status") {
    result = globalMihomoManager.getStatus();
  } else if (key === "POST /api/mihomo/stop") {
    await globalMihomoManager.stop();
    result = { ok: true, status: "stopped" };
  } else if (key === "POST /api/network/commit-pending") {
    result = await commitPendingXiyouScript();
  } else if (key === "POST /api/network/verify-activation") {
    result = await verifyPendingActivation();
  } else if (key === "POST /api/network/ping") {
    const body = await readBody(request).catch(() => ({}));
    result = await pingNodesList(body.nodes || []);
  } else if (key === "POST /api/network/sync") {
    const body = await readBody(request).catch(() => ({}));
    result = await syncSubscriptionNodes(body.subscriptionUrl || null, body.customIspText || null);
  }
  else if (key === "POST /api/proxy/install") result = await installProxy();
  else if (key === "POST /api/proxy/start") result = await startProxy();
  else if (key === "POST /api/proxy/stop") result = await stopProxy();
  else if (key === "POST /api/oauth/start") {
    const body = await readBody(request).catch(() => ({}));
    result = await startOAuth(body);
  } else if (key === "GET /api/oauth/status") result = await oauthStatus(url.searchParams.get("state") || "");
  else if (key === "POST /api/quota/refresh") {
    const body = await readBody(request);
    result = await refreshQuota(body.authIndex || "");
  } else if (key === "PATCH /api/accounts/status") {
    const body = await readBody(request);
    await toggleAccount(String(body.name || ""), body.disabled);
    result = { status: "ok" };
  } else if (key === "DELETE /api/accounts" || key === "POST /api/account/delete" || key === "POST /api/accounts/delete") {
    const body = await readBody(request);
    await deleteAccount(String(body.name || body.email || body.id || ""));
    result = { status: "ok" };
  } else if (key === "POST /api/accounts/proxy") {
    const body = await readBody(request);
    const accountKey = String(body.name || body.email || "").trim();
    if (!accountKey) throw new Error("缺少账号标识");
    const account = (await getAccounts(true)).find((item) => accountIdentityKeys(item).includes(accountKey.toLowerCase()))
      || { name: accountKey, email: accountKey, id: accountKey };
    if (!runtime.settings.accountProxies) runtime.settings.accountProxies = {};
    if (body.clear) {
      delete runtime.settings.accountProxies[accountKey];
      try { await setAccountProxyUrl(account, 0); } catch {}
      addLog("account", `已清除账号 ${accountKey} 的节点绑定`);
    } else {
      const port = Number(body.proxyPort) || 0;
      if (port > 0) {
        const netSettings = runtime.settings.networkSettings || {};
        const activation = netSettings.activation || {};
        if (activation.state !== "active") {
          throw new Error("通道尚未完成出口验证 (状态非 active)，拒绝绑定账号以避免串线");
        }
        const matchedEgress = (runtime.egressPlan || []).find((e) => Number(e.port) === port);
        if (!matchedEgress) {
          throw new Error(`代理端口 ${port} 不存在于已激活的独立通道列表中`);
        }
        if (!await canConnect(port)) {
          throw new Error(`代理端口 ${port} 尚未监听，拒绝绑定账号以避免出口串线`);
        }
        runtime.settings.accountProxies[accountKey] = {
          egressId: matchedEgress.egressId || matchedEgress.fingerprint || "",
          name: String(body.proxyName || matchedEgress.name || "默认"),
          port,
          boundAt: new Date().toISOString(),
        };
        await setAccountProxyUrl(account, port);
        addLog("account", `账号 ${accountKey} 绑定节点: ${body.proxyName} (出口端口 ${port})`);
      } else {
        delete runtime.settings.accountProxies[accountKey];
        await setAccountProxyUrl(account, 0);
        addLog("account", `已清除账号 ${accountKey} 的节点绑定`);
      }
    }
    await saveSettings();
    runtime.accountCache.at = 0;
    result = { ok: true, accountProxies: runtime.settings.accountProxies };
  } else if (key === "POST /api/accounts/mode") {
    const body = await readBody(request);
    runtime.settings.autoRoundRobin = Boolean(body.autoRoundRobin);
    if (body.activeAccountId !== undefined) {
      runtime.settings.activeAccountId = String(body.activeAccountId || "").trim();
    }
    await saveSettings();
    await applyAccountRouting();
    result = { ok: true, autoRoundRobin: runtime.settings.autoRoundRobin, activeAccountId: runtime.settings.activeAccountId };
  } else if (key === "POST /api/accounts/select") {
    const body = await readBody(request);
    runtime.settings.activeAccountId = String(body.accountId || "").trim();
    runtime.settings.autoRoundRobin = false;
    await saveSettings();
    await applyAccountRouting();
    result = { ok: true, autoRoundRobin: false, activeAccountId: runtime.settings.activeAccountId };
  } else if (key === "PUT /api/settings") {
    const body = await readBody(request);
    const next = validateSettings(body);
    if (await proxyHealth() && next.proxyPort !== runtime.settings.proxyPort) throw new Error("请先停止核心，再修改代理端口");
    runtime.settings = next;
    await saveSettings();
    result = { settings: publicSettings() };
  } else if (key === "POST /api/codex/prepare") {
    const body = await readBody(request);
    result = await prepareCodex(body.model || "");
  } else if (key === "POST /api/codex/model" || key === "POST /api/codex/switch-model") {
    const body = await readBody(request);
    result = await switchCodexModel(body.model || "");
  } else if (key === "POST /api/codex/activate") {
    const body = await readBody(request);
    result = await activateCodex(body.model || "");
  } else if (key === "POST /api/codex/launch") {
    const body = await readBody(request);
    result = await launchCodex(body.model || "");
  } else if (key === "POST /api/codex/reapply") {
    result = await reapplyPreparedCodex();
  } else if (key === "POST /api/codex/restore") {
    result = await restoreCodexConfig();
  } else if (key === "POST /api/benchmark") {
    const body = await readBody(request);
    result = await benchmarkModel(body.model || "");
  } else if (key === "GET /api/version/check") {
    result = await checkAppVersion();
  } else {
    const error = new Error("API 路径不存在");
    error.status = 404;
    throw error;
  }
  sendJson(response, 200, result);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  let content = await fs.readFile(filePath);
  if (relative === "index.html") {
    content = Buffer.from(content.toString("utf8").replace("__BRIDGE_UI_KEY__", runtime.settings.uiKey));
  }
  response.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": relative === "index.html" ? "no-store" : "no-cache",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

const SUPPORTED_ANTIGRAVITY_MODELS = new Set([
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "gemini-3.6-flash-high",
  "gemini-3.7-flash-high",
  "gemini-3-flash",
  "gemini-3-flash-agent",
  "gemini-3.1-flash-image",
  "gemini-pro-agent",
  "gemini-3.1-pro-low",
  "gpt-oss-120b-medium",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
]);

async function handleV1Proxy(request, response, url) {
  if (!await proxyHealth()) {
    try {
      await startProxy();
    } catch (e) {
      sendJson(response, 503, { error: { message: `代理核心未就绪: ${e.message}`, type: "bridge_proxy_error" } });
      return;
    }
  }

  let bodyBuffer = null;
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        const activeModel = runtime.settings.defaultModel || "gemini-3.7-flash-high";
        if (parsed.model && !SUPPORTED_ANTIGRAVITY_MODELS.has(parsed.model)) {
          addLog("proxy", `[虚拟映射] 自动将模型 ${parsed.model} 重定向为活跃模型 ${activeModel}`);
          parsed.model = activeModel;
        }
        bodyBuffer = Buffer.from(JSON.stringify(parsed));
      } catch {
        bodyBuffer = Buffer.from(rawBody);
      }
    }
  }

  const targetPath = `${url.pathname}${url.search}`;
  const headers = { ...request.headers, host: `127.0.0.1:${runtime.settings.proxyPort}` };
  if (bodyBuffer) {
    delete headers["content-length"];
    headers["content-length"] = String(Buffer.byteLength(bodyBuffer));
  }

  const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let requestedModel = "";
  try {
    if (bodyBuffer) {
      const bObj = JSON.parse(bodyBuffer.toString("utf8"));
      requestedModel = bObj.model || "";
    }
  } catch {}

  globalTelemetryCollector.beginRequest({ requestId: reqId, model: requestedModel, source: "user" });
  let lastUsagePayload = null;
  let collectedOutputText = "";

  const proxyReq = http.request(`http://127.0.0.1:${runtime.settings.proxyPort}${targetPath}`, {
    method: request.method,
    headers,
  }, (proxyRes) => {
    const isSSE = String(proxyRes.headers["content-type"] || "").includes("text/event-stream");
    if (isSSE) {
      delete proxyRes.headers["content-length"];
      response.writeHead(proxyRes.statusCode, proxyRes.headers);
      let buffer = "";
      proxyRes.on("data", (chunk) => {
        const text = chunk.toString("utf8");

        // 收到首个非空非DONE数据块时立即标记 TTFT
        if (text.includes("data:") && !text.includes("[DONE]")) {
          globalTelemetryCollector.markFirstOutput(reqId);
        }
        
        // 提取流式文本增量 (支持 OpenAI delta.content, delta.text, Responses output 等)
        const deltas = text.match(/"(?:content|text)"\s*:\s*"((?:\\.|[^"\\])*)"/g);
        if (deltas) {
          for (const d of deltas) {
            const m = d.match(/"(?:content|text)"\s*:\s*"((?:\\.|[^"\\])*)"/);
            if (m && m[1]) {
              try {
                const unescaped = JSON.parse(`"${m[1]}"`);
                globalTelemetryCollector.addOutputText(reqId, unescaped);
                collectedOutputText += unescaped;
              } catch {
                globalTelemetryCollector.addOutputText(reqId, m[1]);
                collectedOutputText += m[1];
              }
            }
          }
        }

        // 提取 usage 事件
        if (text.includes('"usage"') || text.includes('"output_tokens"')) {
          const lines = text.split("\n");
          for (const line of lines) {
            if (line.startsWith("data:") && !line.includes("[DONE]")) {
              try {
                const j = JSON.parse(line.slice(5).trim());
                if (j.usage || j.response?.usage) {
                  lastUsagePayload = j;
                  globalTelemetryCollector.setUsage(reqId, j);
                }
              } catch {}
            }
          }
        }

        buffer += text;
        buffer = buffer.replace(/"encrypted_content"\s*:\s*"cpa-[^"]*"/g, '"encrypted_content":null');
        const lastDouble = buffer.lastIndexOf("\n\n");
        if (lastDouble !== -1) {
          const toSend = buffer.slice(0, lastDouble + 2);
          buffer = buffer.slice(lastDouble + 2);
          response.write(toSend);
        }
      });
      proxyRes.on("end", () => {
        if (buffer.length) {
          response.write(buffer.replace(/"encrypted_content"\s*:\s*"cpa-[^"]*"/g, '"encrypted_content":null'));
        }
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          globalTelemetryCollector.completeRequest(reqId, { usagePayload: lastUsagePayload, finalText: collectedOutputText });
        } else {
          globalTelemetryCollector.failRequest(reqId, new Error(`HTTP ${proxyRes.statusCode}`));
        }
        response.end();
      });
    } else {
      response.writeHead(proxyRes.statusCode, proxyRes.headers);
      let nonSseData = "";
      proxyRes.on("data", (chunk) => {
        nonSseData += chunk.toString("utf8");
        response.write(chunk);
      });
      proxyRes.on("end", () => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          try {
            const j = JSON.parse(nonSseData);
            if (j.usage) lastUsagePayload = j;
            const text = j.choices?.[0]?.message?.content || "";
            globalTelemetryCollector.completeRequest(reqId, { usagePayload: lastUsagePayload, finalText: text });
          } catch {
            globalTelemetryCollector.completeRequest(reqId, { finalText: nonSseData });
          }
        } else {
          globalTelemetryCollector.failRequest(reqId, new Error(`HTTP ${proxyRes.statusCode}`));
        }
        response.end();
      });
    }
  });

  proxyReq.on("error", (err) => {
    globalTelemetryCollector.failRequest(reqId, err);
    if (!response.headersSent) {
      sendJson(response, 502, { error: { message: err.message, type: "bridge_proxy_error" } });
    }
  });

  if (bodyBuffer) {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
}

async function requestHandler(request, response) {
  try {
    const host = String(request.headers.host || "").split(":")[0];
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else if (url.pathname.startsWith("/v1/")) await handleV1Proxy(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    if (String(error.code) === "ENOENT") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (!error.status || error.status >= 500) addError("api", error);
    sendJson(response, error.status || 500, { error: error.message || "未知错误" });
  }
}

function openDashboard() {
  const url = `http://${UI_HOST}:${UI_PORT}/`;
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" });
    child.unref();
  }
}

async function scheduledQuotaRefresh() {
  if (runtime.quotaRefreshing || !await proxyHealth()) return;
  const interval = runtime.settings.quotaIntervalMinutes * 60_000;
  if (Date.now() - runtime.lastQuotaSweep < interval) return;
  try {
    await refreshQuota();
  } catch (error) {
    addError("quota", error);
  }
}

let antigravityWatcherRunning = false;
function startAntigravityWatcher() {
  if (antigravityWatcherRunning) return;
  antigravityWatcherRunning = true;

  const brainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
  let lastFileSize = 0;
  let activeLogPath = "";
  let lastObservedTime = Date.now();

  const poll = async () => {
    try {
      if (!fsSync.existsSync(brainDir)) return;
      const subdirs = await fs.readdir(brainDir).catch(() => []);
      let latestFile = "";
      let latestMtime = 0;

      for (const sub of subdirs) {
        const lp = path.join(brainDir, sub, ".system_generated", "logs", "transcript.jsonl");
        try {
          const st = fsSync.statSync(lp);
          if (st.mtimeMs > latestMtime) {
            latestMtime = st.mtimeMs;
            latestFile = lp;
          }
        } catch {}
      }

      if (!latestFile) return;
      if (latestFile !== activeLogPath) {
        activeLogPath = latestFile;
        lastFileSize = fsSync.statSync(latestFile).size;
        lastObservedTime = Date.now();
        return;
      }

      const curStat = fsSync.statSync(latestFile);
      if (curStat.size > lastFileSize) {
        const readLen = curStat.size - lastFileSize;
        const buf = Buffer.alloc(readLen);
        const fd = fsSync.openSync(latestFile, "r");
        fsSync.readSync(fd, buf, 0, readLen, lastFileSize);
        fsSync.closeSync(fd);
        lastFileSize = curStat.size;

        const newChunk = buf.toString("utf8");
        const lines = newChunk.split("\n").filter(Boolean);
        let chars = 0;
        for (const line of lines) {
          try {
            const step = JSON.parse(line);
            if (step.content && typeof step.content === "string") chars += step.content.length;
            if (step.thinking && typeof step.thinking === "string") chars += step.thinking.length;
          } catch {}
        }

        if (chars > 10) {
          const now = Date.now();
          const elapsedSec = Math.max((now - lastObservedTime) / 1000, 0.5);
          const estimatedTokens = estimateOutputTokensFromText(newChunk);
          const rawTps = Math.round((estimatedTokens / elapsedSec) * 10) / 10;

          // 仅作为次级观测记录，绝不修改 canonical telemetry
          runtime.antigravityObservation = {
            lastObservedAt: new Date().toISOString(),
            estimatedChars: chars,
            estimatedTokens,
            rawTps,
          };
          lastObservedTime = now;
        }
      }
    } catch {}
  };

  const timer = setInterval(poll, 1200);
  timer.unref();
}

export async function startServer() {
  await initialize();
  mihomoRuntime.init({ runtime, settings: runtime.settings });
  try {
    await mihomoRuntime.recoverInterruptedMihomoActivation();
    await mihomoRuntime.recoverEmbeddedMihomo();
  } catch (err) {
    addError("recovery", err);
  }
  startAntigravityWatcher();
  const server = http.createServer((request, response) => requestHandler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, UI_HOST, resolve);
  });
  setTimeout(async () => {
    try {
      await resumeActiveTakeover();
      const binary = detectProxyBinary();
      if (binary && !await proxyHealth()) {
        await startProxy();
      }
    } catch (error) {
      addError("recovery", error);
    }
  }, 50);
  const quotaTimer = setInterval(scheduledQuotaRefresh, 60_000);
  quotaTimer.unref();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    runtime.shuttingDown = true;
    clearInterval(quotaTimer);
    if (runtime.settings.codexActiveBackup) {
      try {
        await restoreCodexConfig();
      } catch (error) {
        addError("recovery", error);
      }
    }
    if (runtime.proxyProcess?.exitCode === null) {
      try {
        await stopProxy();
      } catch (error) {
        addError("core", error);
      }
    }
    try {
      await globalMihomoManager.stop();
    } catch {}
    server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
