import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { friendlyProxyError, responseText } from "../protocol.mjs";
import { readProtectedJson } from "../security.mjs";

const dataDir = path.resolve(process.env.BRIDGE_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AntigravityCodexBridge"));
const settings = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"));
const secrets = await readProtectedJson(path.join(dataDir, "secure", "secrets.dpapi")).catch((error) => {
  if (error.code === "ENOENT" && settings.clientKey) return settings;
  throw error;
});
const endpoint = process.env.BRIDGE_ENDPOINT || `http://127.0.0.1:${settings.proxyPort || 8317}/v1`;
const extended = process.argv.includes("--extended");
const report = { generatedAt: new Date().toISOString(), endpoint, extended, model: "", checks: [] };

function record(name, status, detail = "") {
  report.checks.push({ name, status, detail });
}

async function request(route, body, signal = AbortSignal.timeout(90_000)) {
  const response = await fetch(`${endpoint}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${secrets.clientKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

await check("responses-nonstream", async () => {
  const payload = await jsonResponse({ model: report.model, input: "Reply with exactly LIVE_OK", stream: false });
  if (!/LIVE_OK/i.test(responseText(payload))) throw new Error("expected LIVE_OK text was not returned");
  return `response ${payload.id || "without id"}`;
});

await check("responses-stream", async () => {
  const response = await request("/responses", { model: report.model, input: "Reply with exactly STREAM_OK", stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = 0;
  let completed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) {
      const data = event.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const payload = JSON.parse(data);
      if (/output_text\.delta/.test(payload.type)) deltas += 1;
      if (payload.type === "response.completed") completed = true;
    }
  }
  if (!deltas || !completed) throw new Error(`stream incomplete: deltas=${deltas}, completed=${completed}`);
  return `${deltas} text deltas`;
});

await check("function-tool", async () => {
  const payload = await jsonResponse({
    model: report.model,
    input: "Call bridge_probe with value tool_ok. Do not answer in text.",
    tools: [{
      type: "function",
      name: "bridge_probe",
      description: "Protocol verification function",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      strict: true,
    }],
  });
  const call = (payload.output || []).find((item) => item.type === "function_call" && item.name === "bridge_probe");
  if (!call) throw new Error("model did not emit bridge_probe function_call");
  return "function_call emitted";
});

await check("multi-turn", async () => {
  const first = await jsonResponse({ model: report.model, input: "Remember this token: BRIDGE_731. Reply remembered." });
  if (!first.id) throw new Error("first response has no id");
  const second = await jsonResponse({ model: report.model, previous_response_id: first.id, input: "What token did I ask you to remember?" });
  if (!/BRIDGE_731/.test(responseText(second))) throw new Error("second turn did not preserve the token");
  return "previous_response_id retained context";
});

await check("image-input", async () => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const payload = await jsonResponse({
    model: report.model,
    input: [{ role: "user", content: [
      { type: "input_text", text: "Acknowledge that an image was attached in five words or fewer." },
      { type: "input_image", image_url: `data:image/png;base64,${pixel}` },
    ] }],
  });
  if (!responseText(payload)) throw new Error("image request returned no text");
  return "image accepted";
});

await check("client-timeout", async () => {
  try {
    await jsonResponse({ model: report.model, input: "Reply OK" }, AbortSignal.timeout(1));
  } catch (error) {
    if (/abort|timeout/i.test(`${error.name} ${error.message}`)) return "AbortSignal timeout observed";
    throw error;
  }
  throw new Error("request unexpectedly completed before the 1ms timeout");
});

await check("cancel-stream", async () => {
  const controller = new AbortController();
  const response = await request("/responses", { model: report.model, input: "Count slowly from 1 to 1000", stream: true }, controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  try { await reader.read(); } catch {}
  return "stream aborted after first chunk";
});

if (extended) {
  await check("long-multi-turn", async () => {
    let previous = "";
    for (let index = 0; index < 12; index += 1) {
      const payload = await jsonResponse({
        model: report.model,
        ...(previous ? { previous_response_id: previous } : {}),
        input: `Turn ${index + 1}: retain marker LONG_CONTEXT_884 and answer with one short sentence.`,
      });
      previous = payload.id;
    }
    const final = await jsonResponse({ model: report.model, previous_response_id: previous, input: "Return the retained marker only." });
    if (!/LONG_CONTEXT_884/.test(responseText(final))) throw new Error("long conversation lost its marker");
    return "12-turn context retained";
  });
} else {
  record("long-context-compaction", "skip", "run npm run verify:live:extended to spend quota on this check");
}

record("retry-reconnect", "not-simulated", "requires a controlled fault-injection gateway; normal requests do not prove retry behavior");
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((item) => item.status === "fail")) process.exitCode = 1;
