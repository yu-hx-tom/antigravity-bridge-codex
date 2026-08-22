/**
 * Build Script: Packages Antigravity Codex Bridge into a standalone Windows Executable distribution.
 *
 * Produces:
 * 1. dist/AntigravityCodexBridge/AntigravityCodexBridge.exe (Native Windows System Tray Executable)
 * 2. dist/AntigravityCodexBridge/ (complete standalone portable folder)
 * 3. dist/启动.bat
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isStaging = process.argv.includes("--staging");
const DIST = path.join(ROOT, isStaging ? "dist-staging" : "dist");
const APP_DIR = path.join(DIST, "AntigravityCodexBridge");

console.log(`=== Building Antigravity Codex Bridge Standalone Package (${isStaging ? "STAGING MODE" : "RELEASE MODE"}) ===`);

// 1. Clean and prepare output directories
try {
  await fs.rm(DIST, { recursive: true, force: true });
} catch (error) {
  throw new Error(`输出目录正在使用，请先退出旧版 Bridge，或使用 --staging 构建：${error.message}`);
}
await fs.mkdir(APP_DIR, { recursive: true });
await fs.mkdir(path.join(APP_DIR, "public"), { recursive: true });

// 2. Copy static web assets
console.log("Copying public web interface...");
const publicFiles = ["index.html", "app.js", "styles.css"];
for (const file of publicFiles) {
  await fs.copyFile(path.join(ROOT, "public", file), path.join(APP_DIR, "public", file));
}

// 3. Copy essential project files
console.log("Copying core server files...");
const appFiles = [
  "server.mjs",
  "core.mjs",
  "protocol.mjs",
  "transaction.mjs",
  "history.mjs",
  "subscription.mjs",
  "telemetry.mjs",
  "xiyou-runtime.mjs",
  "package.json",
  "cliproxy.lock.json",
  "launch-codex-api-service.ps1",
];

for (const file of appFiles) {
  const src = path.join(ROOT, file);
  if (fsSync.existsSync(src)) {
    await fs.copyFile(src, path.join(APP_DIR, file));
  }
}

// Copy node_modules (yaml)
const nodeModulesSrc = path.join(ROOT, "node_modules");
const nodeModulesDest = path.join(APP_DIR, "node_modules");
if (fsSync.existsSync(nodeModulesSrc)) {
  await fs.cp(nodeModulesSrc, nodeModulesDest, { recursive: true });
}

// Bundle the build runtime so the target computer does not need Node.js installed.
await fs.copyFile(process.execPath, path.join(APP_DIR, "node.exe"));

// 4. Compile Native Desktop GUI Cockpit .EXE (WPF Native Window)
console.log("Compiling Native Windows Desktop Cockpit Application...");
const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const wpfLib = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF";
const desktopCsPath = path.join(ROOT, "src", "DesktopApp.cs");
const targetExePath = path.join(APP_DIR, "AntigravityCodexBridge.exe");

const manifestPath = path.join(ROOT, "src", "app.manifest");
const icoPath = path.join(ROOT, "src", "app.ico");

if (fsSync.existsSync(cscPath) && fsSync.existsSync(desktopCsPath)) {
  try {
    const manifestFlag = fsSync.existsSync(manifestPath) ? `/win32manifest:"${manifestPath}"` : "";
    const iconFlag = fsSync.existsSync(icoPath) ? `/win32icon:"${icoPath}"` : "";
    const tmpExePath = path.join(APP_DIR, "AntigravityCodexBridge.build.exe");
    const compileCmd = `"${cscPath}" /target:winexe /optimize+ /platform:anycpu ${manifestFlag} ${iconFlag} /out:"${tmpExePath}" /lib:"${wpfLib}" /r:PresentationFramework.dll,PresentationCore.dll,WindowsBase.dll,System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Xaml.dll,System.Web.Extensions.dll "${desktopCsPath}"`;
    execSync(compileCmd, { stdio: "inherit" });
    console.log("✓ Native Desktop GUI Client compiled successfully!");

    if (fsSync.existsSync(targetExePath)) {
      try {
        fsSync.unlinkSync(targetExePath);
      } catch {
        const oldPath = path.join(APP_DIR, `AntigravityCodexBridge.${Date.now()}.old`);
        try { fsSync.renameSync(targetExePath, oldPath); } catch {}
      }
    }
    try {
      fsSync.renameSync(tmpExePath, targetExePath);
    } catch {
      fsSync.copyFileSync(tmpExePath, targetExePath);
    }
  } catch (err) {
    throw new Error(`Could not compile Desktop .EXE: ${err.message}`);
  }
} else {
  throw new Error(`Missing C# compiler or desktop source: ${cscPath}`);
}

if (!fsSync.existsSync(targetExePath)) throw new Error("Desktop compiler completed without producing the EXE");

// 5. Create Batch Fallback Launchers
console.log("Creating standalone Windows Launchers...");

const launcherBat = `@echo off
chcp 65001 >nul 2>&1
title Antigravity Codex Bridge
cd /d "%~dp0"
if exist "AntigravityCodexBridge.exe" (
  start "" "AntigravityCodexBridge.exe"
  exit
)
start "" "http://127.0.0.1:8787/"
if exist "node.exe" (
  "node.exe" server.mjs
) else (
  node server.mjs
)
`;

await fs.writeFile(path.join(APP_DIR, "启动.bat"), launcherBat, "utf8");
await fs.writeFile(path.join(DIST, "启动.bat"), `@echo off\r\nstart "" "%~dp0AntigravityCodexBridge\\AntigravityCodexBridge.exe"\r\n`, "utf8");

// 6. Create README for the portable package
const readmeTxt = `Antigravity Codex Bridge 便携运行包
========================================

使用说明：
0. 请先安装、登录并确认西游云能够正常联网；本工具不携带代理内核。
1. 双击运行 "AntigravityCodexBridge.exe"（或 "启动.bat"）。
2. 工具将在系统右下角任务栏托盘静默运行，并自动启动本地服务（127.0.0.1:8787）。
3. 右键点击托盘图标：
   - 🌟 打开控制面板 (Dashboard)：管理账号、查看圆形额度
   - 🚀 一键启动 Codex：一键安全切换并打开 Codex
   - 🔄 快速切换模型：Gemini 3.7 Flash / Claude Sonnet 4.6
   - 🛡️ 恢复官方配置：一键恢复官方 OpenAI 默认配置
   - 🚪 退出程序
4. 关闭 Codex 窗口时，系统会自动将配置还原为官方，无需手动操作。
5. 多端口配置按界面三步操作：生成计划 → 退出西游云后写入 → 重开西游云后验证。
   写入前会自动备份；验证失败时请退出西游云并点击“恢复写入前备份”。

全部数据仅在本地 127.0.0.1 回环运行。
`;

await fs.writeFile(path.join(APP_DIR, "使用说明.txt"), readmeTxt, "utf8");

console.log("\n✓ Build complete!");
console.log(` Output location: ${APP_DIR}`);
console.log(` Native EXE: ${targetExePath}`);
