import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createCodexApiAuth, createCodexProfile } from "../core.mjs";
import { readProtectedJson } from "../security.mjs";

const dataDir = path.resolve(process.env.BRIDGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge"));
const settings = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"));
const secretsPath = path.join(dataDir, "secure", "secrets.dpapi");
const secrets = await readProtectedJson(secretsPath).catch((error) => {
  if (error.code === "ENOENT" && settings.clientKey) return settings;
  throw error;
});
const endpoint = `http://127.0.0.1:${settings.proxyPort || 8317}/v1/models`;
try {
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${secrets.clientKey}` }, signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.log(JSON.stringify({ status: "skip", reason: `proxy offline: ${error.message}` }, null, 2));
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-codex-tools-"));
const codexHome = path.join(root, "home");
const workspace = path.join(root, "workspace");
const catalogPath = path.join(dataDir, "codex-model-catalog.json");
const tokenCommandPath = path.join(dataDir, "secure", "get-client-token.ps1");
const codexJs = path.join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
await fs.mkdir(codexHome, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(codexHome, "config.toml"), createCodexProfile({
  port: settings.proxyPort || 8317,
  model: process.env.BRIDGE_MODEL || settings.defaultModel,
  catalogPath,
  tokenCommandPath,
}));
await fs.writeFile(path.join(codexHome, "auth.json"), createCodexApiAuth());

const prompt = `Work only in the current temporary directory.
1. Use shell_command to create probe.txt containing SHELL_OK.
2. Use apply_patch to change probe.txt to contain SHELL_OK and APPLY_PATCH_OK on separate lines.
3. Run two independent shell commands in parallel that print PARALLEL_A and PARALLEL_B.
4. Read probe.txt and finish with TOOL_VERIFY_OK.`;
const args = [codexJs, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", "-c", "approval_policy=\"never\"", "-C", workspace, prompt];
const child = spawn(process.execPath, args, {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
const file = await fs.readFile(path.join(workspace, "probe.txt"), "utf8").catch(() => "");
const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);
const serialized = JSON.stringify(events);
const report = {
  status: exitCode === 0 && /SHELL_OK/.test(file) && /APPLY_PATCH_OK/.test(file) ? "pass" : "fail",
  exitCode,
  shellObserved: /command_execution|shell_command/i.test(serialized),
  applyPatchObserved: /file_change|apply_patch/i.test(serialized) || /APPLY_PATCH_OK/.test(file),
  parallelMarkersObserved: /PARALLEL_A/.test(serialized) && /PARALLEL_B/.test(serialized),
  finalMarkerObserved: /TOOL_VERIFY_OK/.test(serialized),
  stderr: stderr.trim().slice(-2_000),
};
console.log(JSON.stringify(report, null, 2));
await fs.rm(root, { recursive: true, force: true });
if (report.status !== "pass") process.exitCode = 1;
