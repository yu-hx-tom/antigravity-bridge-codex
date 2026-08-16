import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { friendlyProxyError, responseText } from "../protocol.mjs";

const dataDir = path.resolve(process.env.BRIDGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge"));
const settings = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8").catch(() => "{}"));
const endpoint = process.env.BRIDGE_ENDPOINT || `http://127.0.0.1:${settings.proxyPort || 8317}/v1`;
const clientKey = settings.clientKey || "";
const extended = process.argv.includes("--extended");
const report = { generatedAt: new Date().toISOString(), endpoint, extended, model: "", checks: [] };

function record(name, status, detail = "") {
  report.checks.push({ name, status, detail });
}

async function request(route, body, signal = AbortSignal.timeout(90_000)) {
  const response = await fetch(`${endpoint}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${clientKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.error?.message || payload?.error || payload?.message || `HTTP ${response.status}`;
    throw new Error(friendlyProxyError(response.status, detail));
  }
  return response;
}

async function jsonResponse(body, signal) {
  return (await request("/responses", body, signal)).json();
}

async function check(name, task) {
  try {
    const detail = await task();
    record(name, "pass", detail || "");
  } catch (error) {
    record(name, "fail", error.message);
  }
}

try {
  const models = await (await request("/models", undefined, AbortSignal.timeout(2_000))).json();
  const ids = (models.data || []).map((model) => model.id);
  report.model = process.env.BRIDGE_MODEL || settings.defaultModel || ids[0] || "";
  if (!report.model) throw new Error("代理没有返回模型");
  record("models", "pass", `${ids.length} models; selected ${report.model}`);
} catch (error) {
  record("proxy-online", "skip", error.message);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

await check("ping", async () => {
  const payload = await jsonResponse({
    model: report.model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply only with PING_OK." }] }],
  });
  const text = responseText(payload);
  if (!/PING_OK/i.test(text)) throw new Error(`Unexpected response: ${text.slice(0, 100)}`);
  return text.trim();
});

if (extended) {
  await check("streaming", async () => {
    const response = await request("/responses", {
      model: report.model,
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Count from 1 to 3 with spaces." }] }],
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    if (!text.includes("data:")) throw new Error("No SSE chunks received");
    return `stream bytes: ${text.length}`;
  });
}

console.log(JSON.stringify(report, null, 2));
if (report.checks.some((entry) => entry.status === "fail")) process.exitCode = 1;
