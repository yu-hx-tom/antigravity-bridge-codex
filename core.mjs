import path from "node:path";
import { modelCapabilities } from "./protocol.mjs";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toPortablePath(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

export function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createProxyConfig({ port, authDir, clientKey, managementKey }) {
  return `host: "127.0.0.1"
port: ${port}

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: "${managementKey}"
  disable-control-panel: true

auth-dir: "${toPortablePath(authDir)}"

api-keys:
  - "${clientKey}"

debug: false
logging-to-file: true
logs-max-total-size-mb: 20
usage-statistics-enabled: false
request-retry: 2
max-retry-interval: 30
disable-image-generation: "chat"

quota-exceeded:
  switch-project: true
  switch-preview-model: true
  antigravity-credits: false

routing:
  strategy: "round-robin"
  session-affinity: true
  session-affinity-ttl: "1h"

ws-auth: true
streaming:
  keepalive-seconds: 15
  bootstrap-retries: 1
`;
}

export function normalizeModels(payload) {
  const source = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(source)) return [];

  const seen = new Set();
  return source
    .map((item) => {
      const id = cleanText(typeof item === "string" ? item : item?.id || item?.name);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        displayName: cleanText(item?.display_name || item?.displayName) || id,
        ownedBy: cleanText(item?.owned_by || item?.ownedBy) || "antigravity",
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function parseQuotaPayload(payload) {
  const rawModels = payload?.models ?? payload?.availableModels ?? payload?.available_models ?? [];
  const entries = Array.isArray(rawModels)
    ? rawModels.map((item, index) => [item?.name || item?.id || String(index), item])
    : Object.entries(rawModels || {});

  const models = entries.map(([key, raw]) => {
    const item = raw && typeof raw === "object" ? raw : {};
    const quota = item.quotaInfo || item.quota_info || item.quota || {};
    const remaining = numberOrNull(
      quota.remainingFraction ?? quota.remaining_fraction ?? item.remainingFraction ?? item.remaining_fraction,
    );
    const resetTime = cleanText(
      quota.resetTime ?? quota.reset_time ?? item.resetTime ?? item.reset_time,
    );
    return {
      id: cleanText(item.name || item.id || key) || key,
      displayName: cleanText(item.displayName || item.display_name) || cleanText(item.name || key),
      remainingFraction: remaining === null ? null : Math.max(0, Math.min(1, remaining)),
      resetTime: resetTime || null,
    };
  });

  return models
    .filter((model) => model.id)
    .sort((a, b) => {
      if (a.remainingFraction === null && b.remainingFraction !== null) return 1;
      if (a.remainingFraction !== null && b.remainingFraction === null) return -1;
      return a.id.localeCompare(b.id, "en");
    });
}

export function extractProjectId(payload) {
  const value = payload?.cloudaicompanionProject ?? payload?.cloudAiCompanionProject ?? null;
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return cleanText(value.id || value.name || value.projectId || value.project_id);
}

function contextWindowFor(modelId) {
  return modelCapabilities(modelId).contextWindow;
}

function displayNameFor(modelId) {
  const words = String(modelId).split("-").map((word) => {
    if (/^gpt$/i.test(word)) return "GPT";
    if (/^oss$/i.test(word)) return "OSS";
    if (/^\d+(?:\.\d+)*$/.test(word) || /^\d+b$/i.test(word)) return word.toUpperCase();
    return word ? `${word[0].toUpperCase()}${word.slice(1)}` : word;
  });
  return words.join(" ");
}

function reasoningFor(modelId) {
  if (/extra-low|flash-lite|\blite\b/i.test(modelId)) return "low";
  if (/(?:^|-)low(?:-|$)/i.test(modelId)) return "low";
  if (/medium/i.test(modelId)) return "medium";
  if (/high|thinking|(?:^|-)pro(?:-|$)|opus/i.test(modelId)) return "high";
  return "medium";
}

const REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning for everyday coding tasks",
  high: "Greater reasoning depth for complex coding tasks",
};

export function createModelCatalog(models) {
  return {
    models: models.map((model, index) => {
      const contextWindow = contextWindowFor(model.id);
      const reasoning = reasoningFor(model.id);
      const capabilities = modelCapabilities(model.id);
      return {
        slug: model.id,
        display_name: model.displayName && model.displayName !== model.id
          ? model.displayName
          : displayNameFor(model.id),
        description: "Antigravity via local CLIProxyAPI",
        default_reasoning_level: reasoning,
        supported_reasoning_levels: [{
          effort: reasoning,
          description: REASONING_DESCRIPTIONS[reasoning],
        }],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: index,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        base_instructions: "You are Codex, a coding agent. Work with the user in the current workspace, follow instructions carefully, use tools when needed, and report results concisely.",
        model_messages: null,
        default_reasoning_summary: "none",
        supports_reasoning_summaries: false,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: capabilities.parallelTools,
        supports_image_detail_original: capabilities.imageInput,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        comp_hash: `antigravity-${model.id}`,
        experimental_supported_tools: [],
        input_modalities: capabilities.imageInput ? ["text", "image"] : ["text"],
        supports_search_tool: false,
        use_responses_lite: false,
      };
    }),
  };
}

export function createCodexApiAuth() {
  return `${JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "codex-api-service",
  }, null, 2)}\n`;
}

function codexProvider({ port, bearerToken, tokenCommandPath }) {
  const bearer = tokenCommandPath ? "" : `
experimental_bearer_token = ${tomlString(bearerToken)}`;
  const authCommand = tokenCommandPath ? `

[model_providers.antigravity_local.auth]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ${tomlString(toPortablePath(tokenCommandPath))}]
timeout_ms = 5000
refresh_interval_ms = 0` : "";
  return `[model_providers.antigravity_local]
name = "Codex API Service"
base_url = "http://127.0.0.1:${port}/v1"${bearer}
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
supports_websockets = false${authCommand}`;
}

export function createCodexProfile({ port, model, catalogPath, bearerToken = "", tokenCommandPath = "" }) {
  return `model_provider = "antigravity_local"
model = ${tomlString(model)}
model_catalog_json = ${tomlString(toPortablePath(catalogPath))}

${codexProvider({ port, bearerToken, tokenCommandPath })}

[windows]
sandbox = "unelevated"
`;
}

export function createActiveCodexConfig(current, {
  port,
  model,
  catalogPath,
  bearerToken = "",
  tokenCommandPath = "",
}) {
  const preserved = [];
  let beforeFirstTable = true;
  let skippingManagedProvider = false;
  let inWindowsTable = false;
  let hasWindowsTable = false;

  for (const line of String(current || "").replaceAll("\r\n", "\n").split("\n")) {
    const table = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (table) {
      beforeFirstTable = false;
      const name = table[1].trim();
      skippingManagedProvider = name === "model_providers.antigravity_local"
        || name.startsWith("model_providers.antigravity_local.");
      inWindowsTable = name === "windows";
      if (inWindowsTable) hasWindowsTable = true;
      if (!skippingManagedProvider) {
        preserved.push(line);
        if (inWindowsTable) preserved.push('sandbox = "unelevated"');
      }
      continue;
    }
    if (skippingManagedProvider) continue;
    if (inWindowsTable && /^\s*sandbox\s*=/.test(line)) continue;
    if (beforeFirstTable && /^\s*(?:model_provider|model|model_catalog_json|openai_base_url)\s*=/.test(line)) continue;
    preserved.push(line);
  }

  const existing = preserved.join("\n").trim();
  const active = `model_provider = "antigravity_local"
model = ${tomlString(model)}
model_catalog_json = ${tomlString(toPortablePath(catalogPath))}`;
  const provider = codexProvider({ port, bearerToken, tokenCommandPath });
  const windows = hasWindowsTable ? "" : `[windows]
sandbox = "unelevated"`;

  return `${[active, existing, provider, windows].filter(Boolean).join("\n\n")}\n`;
}

export function chooseDefaultModel(models, requested = "") {
  if (requested && models.some((model) => model.id === requested)) return requested;
  const preferences = [
    /gemini-3\.7-flash-high/i,
    /gemini-3\.6-flash-high/i,
    /gemini-3\.1-pro/i,
    /gemini-3-pro/i,
    /gemini-3\.1-flash/i,
    /gemini-3-flash/i,
    /claude-sonnet/i,
    /gemini-2\.5-pro/i,
    /gemini-2\.5-flash/i,
  ];
  for (const pattern of preferences) {
    const match = models.find((model) => pattern.test(model.id) && !/image|computer-use/i.test(model.id));
    if (match) return match.id;
  }
  return models.find((model) => !/image|computer-use/i.test(model.id))?.id || models[0]?.id || "";
}

export function isAntigravityAccount(account) {
  const hints = [account?.provider, account?.type, account?.account_type, account?.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hints.includes("antigravity");
}
