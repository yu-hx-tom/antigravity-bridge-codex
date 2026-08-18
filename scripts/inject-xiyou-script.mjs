import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createXiyouOverrideScript } from "../subscription.mjs";
import { atomicWrite } from "../transaction.mjs";

const dataDir = process.env.BRIDGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge");
const planFile = process.argv[2] || path.join(dataDir, "settings.json");
const candidates = [
  path.join(os.homedir(), "AppData", "Roaming", "com.appshub", "XiyouYun", "shared_preferences.json"),
  path.join(os.homedir(), "AppData", "Roaming", "com.follow", "clash", "shared_preferences.json"),
];
const prefsPath = candidates.find((file) => fsSync.existsSync(file));

if (!prefsPath) throw new Error("未找到西游云/Follow shared_preferences.json");

const planDocument = JSON.parse(await fs.readFile(planFile, "utf8"));
const egressPlan = Array.isArray(planDocument)
  ? planDocument
  : planDocument.networkSettings?.egressPlan || planDocument.egressPlan || [];
if (egressPlan.length === 0) throw new Error(`没有可注入的出口计划: ${planFile}`);

const rawText = await fs.readFile(prefsPath, "utf8");
const outer = JSON.parse(rawText);
const config = JSON.parse(outer["flutter.config"] || "{}");
const scriptId = "abc-multi-proxy-script";
const scriptItem = {
  id: scriptId,
  label: "Antigravity多端口并发代理脚本",
  content: createXiyouOverrideScript(egressPlan),
  url: null,
};

config.scriptProps ||= { currentId: scriptId, scripts: [] };
config.scriptProps.currentId = scriptId;
config.scriptProps.scripts ||= [];
const index = config.scriptProps.scripts.findIndex((item) => item.id === scriptId || item.label === scriptItem.label);
if (index >= 0) config.scriptProps.scripts[index] = scriptItem;
else config.scriptProps.scripts.push(scriptItem);

outer["flutter.config"] = JSON.stringify(config);
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = path.join(path.dirname(prefsPath), `shared_preferences_backup_abc_${stamp}.json`);
await fs.copyFile(prefsPath, backupPath);
await atomicWrite(prefsPath, JSON.stringify(outer));
console.log(JSON.stringify({ ok: true, preferencesPath: prefsPath, backupPath, listeners: egressPlan.length }, null, 2));
