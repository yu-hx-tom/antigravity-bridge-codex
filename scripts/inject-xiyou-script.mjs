import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createXiyouOverrideScript, inspectXiyouPreferences, patchXiyouPreferences } from "../subscription.mjs";
import { atomicWrite } from "../transaction.mjs";

const execFileAsync = promisify(execFile);
const dataDir = process.env.BRIDGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge");
const planFile = process.argv[2] || path.join(dataDir, "settings.json");
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const candidates = [
  process.env.XIYOUYUN_CONFIG_DIR ? path.join(process.env.XIYOUYUN_CONFIG_DIR, "shared_preferences.json") : "",
  path.join(appData, "com.appshub", "XiyouYun", "shared_preferences.json"),
  path.join(appData, "com.follow", "clash", "shared_preferences.json"),
].filter(Boolean);
const prefsPath = candidates.find((file) => fsSync.existsSync(file));

if (!prefsPath) throw new Error("未找到西游云/Follow shared_preferences.json");
if (process.platform === "win32") {
  const { stdout } = await execFileAsync("tasklist.exe", ["/NH", "/FO", "CSV"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  }).catch((error) => {
    throw new Error(`无法确认西游云运行状态，已拒绝写入：${error.message}`);
  });
  if (/xiyouyun\.exe|xiyoucore\.exe/i.test(stdout)) {
    throw new Error("西游云仍在运行，已拒绝写入。请先从托盘彻底退出西游云。");
  }
}

const planDocument = JSON.parse(await fs.readFile(planFile, "utf8"));
const egressPlan = Array.isArray(planDocument)
  ? planDocument
  : planDocument.networkSettings?.pendingEgressPlan
    || planDocument.networkSettings?.egressPlan
    || planDocument.egressPlan
    || [];
if (egressPlan.length === 0) throw new Error(`没有可注入的出口计划: ${planFile}`);

const rawText = await fs.readFile(prefsPath, "utf8");
const scriptCode = createXiyouOverrideScript(egressPlan);
const patchedText = patchXiyouPreferences(rawText, scriptCode);
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(path.dirname(prefsPath), `shared_preferences_backup_abc_${stamp}.json`);
await fs.copyFile(prefsPath, backupPath);
try {
  await atomicWrite(prefsPath, patchedText);
  const inspected = inspectXiyouPreferences(await fs.readFile(prefsPath, "utf8"));
  if (!inspected.ok || !inspected.isActive) throw new Error(inspected.error || "活动脚本校验失败");
} catch (error) {
  await atomicWrite(prefsPath, rawText).catch(() => {});
  throw new Error(`写入校验失败，已恢复原配置：${error.message}`);
}
console.log(JSON.stringify({ ok: true, preferencesPath: prefsPath, backupPath, listeners: egressPlan.length }, null, 2));
