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

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const APP_VERSION = "0.1.0";
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
  logs: [],
  errors: [],
  quotas: {},
  lastQuotaSweep: 0,
  quotaRefreshing: false,
  codexLaunch: { running: false, message: "" },
  accountCache: { at: 0, value: [] },
  modelCache: { at: 0, value: [] },
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

async function initialize() {
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(AUTH_DIR, { recursive: true }),
    fs.mkdir(BIN_DIR, { recursive: true }),
    fs.mkdir(CODEX_HOME_DIR, { recursive: true }),
  ]);
  runtime.settings = { ...defaultSettings(), ...(await readJson(SETTINGS_PATH, {})) };
  runtime.quotas = await readJson(QUOTA_CACHE_PATH, {});
  await writeJson(SETTINGS_PATH, runtime.settings);
  await recoverInterruptedTakeover();
}

function redact(value) {
  return String(value)
    .replace(/(authorization[:=]\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/([?&](?:code|token)=)[^&\s]+/gi, "$1[redacted]");
}

function addLog(scope, message, level = "info") {
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
  return { ...safe, clientKey: `${clientKey.slice(0, 8)}...${clientKey.slice(-4)}` };
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

async function getLatestRelease(architecture) {
  const repository = "router-for-me/CLIProxyAPI";
  const suffix = `_windows_${architecture}.zip`;
  let apiError;

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "AntigravityCodexBridge" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const asset = release.assets?.find((item) => String(item.name).toLowerCase().endsWith(suffix));
    if (!asset) throw new Error(`没有 Windows ${architecture} 安装包`);
    return { tagName: release.tag_name || "latest", asset };
  } catch (error) {
    apiError = error;
    addLog("install", `GitHub API 不可用（${error.message}），正在改用 Releases 页面`, "warn");
  }

  try {
    const response = await fetch(`https://github.com/${repository}/releases/latest`, {
      headers: { "User-Agent": "AntigravityCodexBridge" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const releaseUrl = new URL(response.url);
    const prefix = `/${repository}/releases/tag/`;
    if (releaseUrl.hostname !== "github.com" || !releaseUrl.pathname.startsWith(prefix)) {
      throw new Error("latest 没有跳转到受信任的发布页面");
    }
    const tagName = decodeURIComponent(releaseUrl.pathname.slice(prefix.length));
    if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tagName)) throw new Error("发布版本号格式无效");
    const version = tagName.slice(1);
    const name = `CLIProxyAPI_${version}_windows_${architecture}.zip`;
    return {
      tagName,
      asset: {
        name,
        browser_download_url: `https://github.com/${repository}/releases/download/${tagName}/${name}`,
      },
    };
  } catch (error) {
    throw new Error(`无法获取 CLIProxyAPI 最新版本：API ${apiError.message}；Releases ${error.message}`);
  }
}

async function installProxy() {
  if (runtime.install.running) throw new Error("核心正在安装，请稍候");
  runtime.install = { running: true, message: "正在读取最新版本" };
  try {
    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const { tagName, asset } = await getLatestRelease(architecture);
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
    const destination = path.join(BIN_DIR, "cli-proxy-api.exe");
    await fs.copyFile(sourceBinary, destination);
    await fs.rm(tempRoot, { recursive: true, force: true });
    runtime.settings.proxyBinary = destination;
    await writeJson(SETTINGS_PATH, runtime.settings);
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
    const error = new Error(`CLIProxyAPI ${response.status}: ${detail}`);
    error.status = response.status;
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
    runtime.proxyProcess = child;
    runtime.proxyStartedAt = new Date().toISOString();
    child.stdout.on("data", (chunk) => addLog("core", chunk.toString("utf8").trim()));
    child.stderr.on("data", (chunk) => addLog("core", chunk.toString("utf8").trim(), "warn"));
    child.once("exit", (code, signal) => {
      addLog("core", `核心已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）`, code ? "error" : "info");
      runtime.proxyProcess = null;
      runtime.proxyStartedAt = null;
      if (!runtime.shuttingDown && runtime.settings.codexActiveBackup) {
        restoreCodexConfig().catch((error) => addError("recovery", error));
      }
    });
    child.once("error", (error) => addError("core", error));
    await waitForProxy();
    addLog("core", `服务已监听 127.0.0.1:${runtime.settings.proxyPort}`);
    runtime.accountCache.at = 0;
    runtime.modelCache.at = 0;
    return { running: true, managed: true, reused: false };
  } catch (error) {
    if (runtime.proxyProcess && runtime.proxyProcess.exitCode === null) runtime.proxyProcess.kill();
    runtime.proxyProcess = null;
    runtime.proxyStartedAt = null;
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

async function getAccounts(force = false) {
  if (!await proxyHealth()) return [];
  if (!force && Date.now() - runtime.accountCache.at < 3_000) return runtime.accountCache.value;
  const payload = await proxyRequest("/auth-files", { management: true });
  const accounts = (payload.files || [])
    .filter(isAntigravityAccount)
    .map((account) => ({
      id: account.id || account.name,
      authIndex: account.auth_index || "",
      name: account.name || account.id,
      email: account.email || account.id || account.name,
      label: account.label || "",
      status: account.status || (account.disabled ? "disabled" : "unknown"),
      statusMessage: account.status_message || "",
      disabled: Boolean(account.disabled),
      unavailable: Boolean(account.unavailable),
      success: Number(account.success || 0),
      failed: Number(account.failed || 0),
      lastRefresh: account.last_refresh || account.updated_at || account.modtime || null,
      source: account.source || "file",
      quota: runtime.quotas[account.auth_index] || null,
    }));
  runtime.accountCache = { at: Date.now(), value: accounts };
  return accounts;
}

async function getModels(force = false) {
  if (!await proxyHealth()) return [];
  if (!force && Date.now() - runtime.modelCache.at < 10_000) return runtime.modelCache.value;
  const payload = await proxyRequest("/v1/models");
  const models = normalizeModels(payload);
  runtime.modelCache = { at: Date.now(), value: models };
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
  if (cached) return cached;
  try {
    const result = await antigravityApiCall(
      account,
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } },
    );
    return result.status === 200 ? extractProjectId(result.body) : "";
  } catch {
    return "";
  }
}

async function refreshQuota(authIndex = "") {
  if (runtime.quotaRefreshing) throw new Error("额度正在刷新，请稍候");
  runtime.quotaRefreshing = true;
  try {
    const accounts = (await getAccounts(true)).filter((account) => !account.disabled && (!authIndex || account.authIndex === authIndex));
    const endpoints = [
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    ];
    for (const account of accounts) {
      const projectId = await resolveProjectId(account);
      let lastResult = null;
      let lastError = null;
      for (const endpoint of endpoints) {
        try {
          const result = await antigravityApiCall(account, endpoint, projectId ? { project: projectId } : {});
          lastResult = result;
          if (result.status === 200) break;
          if (![404, 429, 500, 502, 503, 504].includes(result.status)) break;
        } catch (error) {
          lastError = error;
        }
      }
      const fetchedAt = new Date().toISOString();
      if (lastResult?.status === 200) {
        runtime.quotas[account.authIndex] = {
          status: "reported",
          fetchedAt,
          projectId,
          models: parseQuotaPayload(lastResult.body),
          message: projectId
            ? "额度来自带项目标识的 fetchAvailableModels 上游报告值"
            : "未解析到项目标识，当前额度可能不准确",
        };
      } else {
        const status = lastResult?.status || 0;
        runtime.quotas[account.authIndex] = {
          status: status === 401 || status === 403 ? "reauth" : status === 429 ? "cooldown" : "error",
          fetchedAt,
          projectId,
          models: [],
          message: lastError?.message || lastResult?.body?.error?.message || `上游返回 HTTP ${status || "未知"}`,
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
    port: runtime.settings.proxyPort,
    model,
    catalogPath: CATALOG_PATH,
    bearerToken: runtime.settings.clientKey,
  });
  const currentConfig = await fs.readFile(configPath, "utf8").catch(() => "");
  const config = createActiveCodexConfig(currentConfig, {
    port: runtime.settings.proxyPort,
    model,
    catalogPath: CATALOG_PATH,
    bearerToken: runtime.settings.clientKey,
  });
  const auth = createCodexApiAuth(runtime.settings.clientKey);
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
  await writeJson(SETTINGS_PATH, runtime.settings);
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
    const manifest = await readJson(path.join(existing, "manifest.json"), null);
    if (manifest && path.resolve(manifest.liveHome) === liveHome) {
      await verifySnapshot(existing, manifest);
      return existing;
    }
    throw new Error("已有其他 Codex Home 的活动备份，请先恢复原 Codex 配置");
  }

  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = path.join(ACTIVE_BACKUP_ROOT, stamp);
  const manifest = await createSnapshot(liveHome, backupDir, ["config.toml", "auth.json"]);
  await writeJson(path.join(backupDir, "manifest.json"), manifest);
  await verifySnapshot(backupDir, manifest);
  runtime.settings.codexActiveBackup = backupDir;
  await writeJson(SETTINGS_PATH, runtime.settings);
  return backupDir;
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
  const auth = await fs.readFile(prepared.authPath);
  try {
    await applyFiles([
      { path: configPath, data: config },
      { path: authPath, data: auth },
    ]);
    manifest = await updateSnapshotState(backupPath, manifest, "active", {
      applied: {
        "config.toml": await hashFile(configPath),
        "auth.json": await hashFile(authPath),
      },
    });
  } catch (error) {
    try {
      await restoreSnapshot(backupPath, manifest);
      await updateSnapshotState(backupPath, manifest, "failed-restored", { failure: error.message });
      runtime.settings.codexActiveBackup = "";
      await writeJson(SETTINGS_PATH, runtime.settings);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Codex takeover failed and automatic restore also failed");
    }
    throw error;
  }
  addLog("codex", `API Service 配置已应用；完全退出 Codex 后重新启动，默认模型 ${prepared.model}`);
  return {
    ...prepared,
    liveHome,
    configPath,
    authPath,
    backupPath,
  };
}

async function restoreCodexConfig() {
  const backupDir = path.resolve(runtime.settings.codexActiveBackup || "");
  const backupRoot = path.resolve(ACTIVE_BACKUP_ROOT);
  if (!runtime.settings.codexActiveBackup
    || !backupDir.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("没有可恢复的 Codex 默认配置备份");
  }
  let manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest) throw new Error("Codex 默认配置备份不完整");
  const liveHome = path.resolve(manifest.liveHome || liveCodexHomePath());
  manifest = await updateSnapshotState(backupDir, manifest, "restoring");
  await restoreSnapshot(backupDir, manifest);
  await updateSnapshotState(backupDir, manifest, "restored");
  runtime.settings.codexActiveBackup = "";
  await writeJson(SETTINGS_PATH, runtime.settings);
  addLog("codex", "已恢复 API Service 接管前的 config.toml 和 auth.json");
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
    await writeJson(SETTINGS_PATH, runtime.settings);
    return true;
  }
  if (!["prepared", "applying", "restoring"].includes(manifest.state)) return false;
  const interruptedState = manifest.state;
  await restoreSnapshot(backupDir, manifest);
  manifest = await updateSnapshotState(backupDir, manifest, "recovered", {
    recoveryReason: `bridge-started-after-${interruptedState}`,
  });
  runtime.settings.codexActiveBackup = "";
  await writeJson(SETTINGS_PATH, runtime.settings);
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
  const authPath = path.join(liveHome, "auth.json");
  try {
    await applyFiles([
      { path: configPath, data: await fs.readFile(path.join(CODEX_HOME_DIR, "config.toml")) },
      { path: authPath, data: await fs.readFile(path.join(CODEX_HOME_DIR, "auth.json")) },
    ]);
    manifest = await updateSnapshotState(backupDir, manifest, "active", {
      reapplying: false,
      reappliedAt: new Date().toISOString(),
      applied: {
        "config.toml": await hashFile(configPath),
        "auth.json": await hashFile(authPath),
      },
    });
  } catch (error) {
    await restoreSnapshot(backupDir, manifest);
    await updateSnapshotState(backupDir, manifest, "failed-restored", { failure: error.message });
    runtime.settings.codexActiveBackup = "";
    await writeJson(SETTINGS_PATH, runtime.settings);
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
    if (code) addError("codex-launch", runtime.codexLaunch.message);
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
  };
}

async function dashboard() {
  const proxy = await proxyState();
  const liveHome = liveCodexHomePath();
  const activeConfigPath = path.join(liveHome, "config.toml");
  const activeAuthPath = path.join(liveHome, "auth.json");
  const backupManifest = runtime.settings.codexActiveBackup
    ? await readJson(path.join(runtime.settings.codexActiveBackup, "manifest.json"), null)
    : null;
  const activeConfig = await fs.readFile(activeConfigPath, "utf8").catch(() => "");
  const activeAuth = await readJson(activeAuthPath, null);
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
    settings: publicSettings(),
    accounts,
    models,
    quotaRefreshing: runtime.quotaRefreshing,
    codex: {
      active: Boolean(backupMatches
        && activeConfig.includes('model_provider = "antigravity_local"')
        && activeAuth?.auth_mode === "apikey"),
      restoreAvailable: Boolean(backupManifest),
      configPath: activeConfigPath,
      authPath: activeAuthPath,
      preparedHome: codexHomePath(),
      launcherPath: CODEX_LAUNCHER_PATH,
      launch: runtime.codexLaunch,
    },
    lastQuotaSweep: runtime.lastQuotaSweep || null,
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

async function handleApi(request, response, url) {
  assertApiAccess(request);
  const key = `${request.method} ${url.pathname}`;
  let result;
  if (key === "GET /api/dashboard") result = await dashboard();
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
  } else if (key === "PUT /api/settings") {
    const body = await readBody(request);
    const next = validateSettings(body);
    if (await proxyHealth() && next.proxyPort !== runtime.settings.proxyPort) throw new Error("请先停止核心，再修改代理端口");
    runtime.settings = next;
    await writeJson(SETTINGS_PATH, runtime.settings);
    result = { settings: publicSettings() };
  } else if (key === "POST /api/codex/prepare") {
    const body = await readBody(request);
    result = await prepareCodex(body.model || "");
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
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
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

export async function startServer() {
  await initialize();
  const server = http.createServer((request, response) => requestHandler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, UI_HOST, resolve);
  });
  addLog("app", `管理页已监听 http://${UI_HOST}:${UI_PORT}`);
  setTimeout(() => resumeActiveTakeover().catch((error) => addError("recovery", error)), 50);
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
  if (process.env.BRIDGE_NO_OPEN !== "1") setTimeout(openDashboard, 300);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
