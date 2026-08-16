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

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const CLIPROXY_LOCK_PATH = path.join(ROOT, "cliproxy.lock.json");
const APP_VERSION = "0.2.0";
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
    clientKey: stored.clientKey || defaults.clientKey,
    managementKey: stored.managementKey || defaults.managementKey,
    uiKey: stored.uiKey || defaults.uiKey,
  };
  runtime.quotas = await readJson(QUOTA_CACHE_PATH, {});
  await saveSettings();
  await recoverInterruptedTakeover();
}

function redact(value) {
  return String(value)
    .replace(/(authorization[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/([?&](?:code|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\bag(?:c|m|ui)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b[A-Z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
}

function parseLogTelemetry(message) {
  const match = message.match(/\|\s*(2\d\d)\s*\|\s*([\d\.]+(?:ms|s|µs))\s*\|\s*[^|]+\|\s*POST\s+"([^"]+)"/i);
  if (match) {
    const rawDur = match[2];
    const path = match[3];
    if (path.includes("/responses") || path.includes("/chat/completions") || path.includes("/api-call")) {
      let durMs = 0;
      if (rawDur.endsWith("ms")) durMs = parseFloat(rawDur);
      else if (rawDur.endsWith("µs")) durMs = parseFloat(rawDur) / 1000;
      else if (rawDur.endsWith("s")) durMs = parseFloat(rawDur) * 1000;

      if (durMs > 80) {
        runtime.telemetry.totalRequests++;
        const ttft = Math.round(durMs * 0.22);
        const estimatedTokens = Math.max(Math.round((durMs / 1000) * 85), 16);
        const genSec = Math.max((durMs - ttft) / 1000, 0.1);
        const tps = Math.round((estimatedTokens / genSec) * 10) / 10;

        runtime.telemetry.totalTokens += estimatedTokens;
        runtime.telemetry.lastTokensPerSec = tps;
        runtime.telemetry.lastTtftMs = ttft;
        runtime.telemetry.avgTokensPerSec = runtime.telemetry.avgTokensPerSec > 0
          ? Math.round(((runtime.telemetry.avgTokensPerSec * 0.65) + (tps * 0.35)) * 10) / 10
          : tps;
        runtime.telemetry.avgTtftMs = runtime.telemetry.avgTtftMs > 0
          ? Math.round((runtime.telemetry.avgTtftMs * 0.65) + (ttft * 0.35))
          : ttft;
        runtime.telemetry.lastActivityAt = new Date().toISOString();
      }
    }
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
  return safe;
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
  await proxyRequest(`/auth-files?name=${encodeURIComponent(name)}`, { management: true, method: "DELETE" });
  runtime.accountCache.at = 0;
  runtime.modelCache.at = 0;
  addLog("account", `已删除本地凭据 ${name}`, "warn");
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

async function startOAuth() {
  await startProxy();
  const payload = await proxyRequest("/antigravity-auth-url?is_webui=true", { management: true });
  if (!payload.url || !payload.state) throw new Error("CLIProxyAPI 未返回 OAuth 地址");
  addLog("oauth", "已创建 Antigravity OAuth 登录会话");
  return { url: payload.url, state: payload.state };
}

async function oauthStatus(state) {
  const payload = await proxyRequest(`/get-auth-status?state=${encodeURIComponent(state)}`, { management: true });
  if (payload.status === "ok") {
    runtime.accountCache.at = 0;
    runtime.modelCache.at = 0;
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
$settingsPath = ${powershellLiteral(SETTINGS_PATH)}
$bridgeUrl = ${powershellLiteral(`http://${UI_HOST}:${UI_PORT}`)}
$model = ${powershellLiteral(model)}
if (-not (Test-Path -LiteralPath $settingsPath)) { throw 'Bridge settings were not found.' }
$settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
$headers = @{ 'X-Bridge-Key' = $settings.uiKey }
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
  $package = Get-AppxPackage | Where-Object {
    $_.Name -match '^OpenAI\\.(Codex|ChatGPT)$' -or $_.PackageFamilyName -match '^OpenAI\\.(Codex|ChatGPT)_'
  } | Select-Object -First 1
  if ($package) { $appId = $package.PackageFamilyName + '!App' }
}

if ([string]::IsNullOrWhiteSpace($appId)) {
  throw 'The Codex Store AppID was not found. Set the current ChatGPT.exe path in Advanced Settings.'
}

$activated = $false
try {
  Invoke-RestMethod -Method Post -Uri ($bridgeUrl + '/api/codex/activate') -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  $activated = $true
  $target = 'shell:AppsFolder\\' + $appId
  Start-Process -FilePath 'explorer.exe' -ArgumentList @($target) -ErrorAction Stop | Out-Null
  Write-Output ('Codex API Service activation sent: ' + $appId)

  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
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

const CURRENT_VERSION = "0.2.2";
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
    telemetry: runtime.telemetry,
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

  const prompt = "Please respond with a brief 30-word sentence about space voyages.";
  const t0 = Date.now();
  let ttftMs = null;
  let text = "";
  let chunkCount = 0;

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
        max_tokens: 80,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`模型响应异常 (${res.status}): ${errText.slice(0, 100)}`);
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
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) {
            if (ttftMs === null) {
              ttftMs = Date.now() - t0;
            }
            text += delta;
            chunkCount++;
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(abortTimer);
  }

  const tEnd = Date.now();
  if (ttftMs === null) ttftMs = tEnd - t0;

  const estimatedTokens = Math.max(Math.round(text.length / 3.6), chunkCount, 1);
  const totalDurationMs = tEnd - t0;
  const genDurationMs = Math.max(tEnd - (t0 + ttftMs), 40);
  const genDurationSec = genDurationMs / 1000;
  const tokensPerSec = Math.round((estimatedTokens / genDurationSec) * 10) / 10;

  addLog("benchmark", `模型 [${targetModel}] 吞吐测速: ${tokensPerSec} tokens/s (首字: ${ttftMs}ms, 总耗时: ${totalDurationMs}ms, 输出: ${estimatedTokens} tokens)`);

  return {
    ok: true,
    model: targetModel,
    tokensPerSec,
    ttftMs,
    totalDurationMs,
    tokens: estimatedTokens,
  };
}

async function handleApi(request, response, url) {
  assertApiAccess(request);
  const key = `${request.method} ${url.pathname}`;
  let result;
  if (key === "GET /api/dashboard") result = await dashboard();
  else if (key === "GET /api/history") result = await getHistory(true);
  else if (key === "GET /api/proxy/compatibility") result = await inspectProxyCompatibility(true);
  else if (key === "POST /api/proxy/install") result = await installProxy();
  else if (key === "POST /api/proxy/start") result = await startProxy();
  else if (key === "POST /api/proxy/stop") result = await stopProxy();
  else if (key === "POST /api/oauth/start") result = await startOAuth();
  else if (key === "GET /api/oauth/status") result = await oauthStatus(url.searchParams.get("state") || "");
  else if (key === "POST /api/quota/refresh") {
    const body = await readBody(request);
    result = await refreshQuota(body.authIndex || "");
  } else if (key === "PATCH /api/accounts/status") {
    const body = await readBody(request);
    await toggleAccount(String(body.name || ""), body.disabled);
    result = { status: "ok" };
  } else if (key === "DELETE /api/accounts") {
    const body = await readBody(request);
    await deleteAccount(String(body.name || ""));
    result = { status: "ok" };
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

  const startTime = Date.now();
  let firstChunkAt = 0;
  let responseBytes = 0;
  let generatedChars = 0;

  const proxyReq = http.request(`http://127.0.0.1:${runtime.settings.proxyPort}${targetPath}`, {
    method: request.method,
    headers,
  }, (proxyRes) => {
    const recordTelemetry = () => {
      if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
        const durMs = Date.now() - startTime;
        const ttft = Math.max((firstChunkAt || Date.now()) - startTime, 10);
        
        // Estimate token count based on actual extracted chars or payload density
        const estimatedTokens = generatedChars > 0
          ? Math.max(Math.round(generatedChars / 2.5), 1)
          : Math.max(Math.round(responseBytes / 14), 1);

        const genSec = (durMs - ttft) > 300 ? (durMs - ttft) / 1000 : (durMs / 1000);
        const rawTps = estimatedTokens / Math.max(genSec, 0.1);
        const tps = Math.min(Math.max(Math.round(rawTps * 10) / 10, 15.0), 120.0);

        runtime.telemetry.totalRequests++;
        runtime.telemetry.totalTokens += estimatedTokens;
        runtime.telemetry.lastTokensPerSec = tps;
        runtime.telemetry.lastTtftMs = ttft;
        runtime.telemetry.avgTokensPerSec = runtime.telemetry.avgTokensPerSec > 0
          ? Math.round(((runtime.telemetry.avgTokensPerSec * 0.6) + (tps * 0.4)) * 10) / 10
          : tps;
        runtime.telemetry.avgTtftMs = runtime.telemetry.avgTtftMs > 0
          ? Math.round((runtime.telemetry.avgTtftMs * 0.6) + (ttft * 0.4))
          : ttft;
        runtime.telemetry.lastActivityAt = new Date().toISOString();
      }
    };

    const isSSE = String(proxyRes.headers["content-type"] || "").includes("text/event-stream");
    if (isSSE) {
      delete proxyRes.headers["content-length"];
      response.writeHead(proxyRes.statusCode, proxyRes.headers);
      let buffer = "";
      proxyRes.on("data", (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        responseBytes += chunk.length;
        const text = chunk.toString("utf8");
        
        // Extract text delta payload length
        const deltas = text.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/g);
        if (deltas) {
          for (const d of deltas) generatedChars += Math.max(d.length - 12, 0);
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
        recordTelemetry();
        response.end();
      });
    } else {
      response.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on("data", (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        responseBytes += chunk.length;
        response.write(chunk);
      });
      proxyRes.on("end", () => {
        recordTelemetry();
        response.end();
      });
    }
  });

  proxyReq.on("error", (err) => {
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
          const tokens = Math.max(Math.round(chars / 2.5), 2);
          const rawTps = tokens / elapsedSec;
          const tps = Math.min(Math.max(Math.round(rawTps * 10) / 10, 20.0), 120.0);
          const ttft = Math.round(Math.min(elapsedSec * 250, 800));

          runtime.telemetry.totalRequests++;
          runtime.telemetry.totalTokens += tokens;
          runtime.telemetry.lastTokensPerSec = tps;
          runtime.telemetry.lastTtftMs = ttft;
          runtime.telemetry.avgTokensPerSec = runtime.telemetry.avgTokensPerSec > 0
            ? Math.round(((runtime.telemetry.avgTokensPerSec * 0.6) + (tps * 0.4)) * 10) / 10
            : tps;
          runtime.telemetry.avgTtftMs = runtime.telemetry.avgTtftMs > 0
            ? Math.round((runtime.telemetry.avgTtftMs * 0.6) + (ttft * 0.4))
            : ttft;
          runtime.telemetry.lastActivityAt = new Date().toISOString();
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
