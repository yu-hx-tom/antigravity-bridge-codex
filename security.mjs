import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWrite } from "./transaction.mjs";

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))
`;

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd().Trim()
$encrypted = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function writeProtectedJson(filePath, value) {
  if (process.platform !== "win32") throw new Error("Windows DPAPI is required");
  const encrypted = await runPowerShell(PROTECT_SCRIPT, JSON.stringify(value));
  await atomicWrite(filePath, `${encrypted.trim()}\n`);
}

export async function readProtectedJson(filePath) {
  if (process.platform !== "win32") throw new Error("Windows DPAPI is required");
  const encrypted = await fs.readFile(filePath, "utf8");
  return JSON.parse(await runPowerShell(UNPROTECT_SCRIPT, encrypted));
}

async function filesUnder(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to vault symbolic link ${fullPath}`);
    if (entry.isDirectory()) files.push(...await filesUnder(root, fullPath));
    else if (entry.isFile()) files.push({
      name: path.relative(root, fullPath).replaceAll("\\", "/"),
      fullPath,
    });
  }
  return files;
}

function vaultTarget(root, relativeName) {
  const target = path.resolve(root, relativeName);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid OAuth vault path");
  return target;
}

export async function sealDirectory(directory, vaultPath) {
  await fs.mkdir(directory, { recursive: true });
  const sourceFiles = await filesUnder(directory);
  if (!sourceFiles.length) return { sealed: false, count: 0 };
  const payload = {
    version: 1,
    sealedAt: new Date().toISOString(),
    files: await Promise.all(sourceFiles.map(async (file) => ({
      name: file.name,
      data: (await fs.readFile(file.fullPath)).toString("base64"),
    }))),
  };
  await writeProtectedJson(vaultPath, payload);
  const verified = await readProtectedJson(vaultPath);
  if (JSON.stringify(verified.files) !== JSON.stringify(payload.files)) {
    throw new Error("OAuth vault verification failed");
  }
  for (const file of sourceFiles) await fs.rm(file.fullPath, { force: true });
  return { sealed: true, count: sourceFiles.length };
}

export async function openDirectory(directory, vaultPath) {
  let payload;
  try {
    payload = await readProtectedJson(vaultPath);
  } catch (error) {
    if (error.code === "ENOENT") return { opened: false, count: 0 };
    throw error;
  }
  if (!Array.isArray(payload?.files)) throw new Error("OAuth vault is invalid");
  await fs.mkdir(directory, { recursive: true });
  for (const file of payload.files) {
    const target = vaultTarget(directory, file.name);
    const data = Buffer.from(file.data, "base64");
    await atomicWrite(target, data);
    if (!Buffer.from(await fs.readFile(target)).equals(data)) throw new Error(`OAuth restore verification failed for ${file.name}`);
  }
  return { opened: true, count: payload.files.length };
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function createTokenCommand(secretsPath) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = (Get-Content -Raw -LiteralPath ${psLiteral(secretsPath)}).Trim()
$encrypted = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$secrets = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
[Console]::Out.Write($secrets.clientKey)
`;
}

function encryptPath(target) {
  return new Promise((resolve) => {
    const child = spawn("cipher.exe", ["/E", "/A", target], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
    child.once("error", (error) => resolve({ enabled: false, reason: error.message }));
    child.once("exit", (code) => resolve({
      enabled: code === 0,
      reason: code === 0 ? "" : output.trim() || `cipher.exe exited with code ${code}`,
    }));
  });
}

async function containedPaths(directory) {
  const paths = [directory];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    paths.push(fullPath);
    if (entry.isDirectory()) paths.push(...await containedPaths(fullPath));
  }
  return paths;
}

export async function enableEfs(directory) {
  if (process.platform !== "win32") return { enabled: false, reason: "Windows EFS is required" };
  if (process.env.BRIDGE_DISABLE_EFS === "1") return { enabled: false, reason: "disabled" };
  for (const target of await containedPaths(directory)) {
    const result = await encryptPath(target);
    if (!result.enabled) return result;
  }
  return { enabled: true, reason: "" };
}
