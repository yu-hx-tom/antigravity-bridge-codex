import path from "node:path";

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
  if (/gemini/i.test(modelId)) return 1_048_576;
  if (/claude/i.test(modelId)) return 200_000;
  return 200_000;
}

export function createModelCatalog(models) {
  return {
    models: models.map((model, index) => {
      const contextWindow = contextWindowFor(model.id);
      return {
        slug: model.id,
        display_name: model.displayName || model.id,
        description: "Antigravity via local CLIProxyAPI",
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: index,
        upgrade: null,
          base_instructions: "You are Codex, a coding agent. Work with the user in the current workspace, follow instructions carefully, use tools when needed, and report results concisely.",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: true,
        supports_image_detail_original: false,
        context_window: contextWindow,
        max_context_window: contextWindow,
        experimental_supported_tools: [],
      };
    }),
  };
}

export function createCodexApiAuth(bearerToken) {
  return `${JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: bearerToken,
  }, null, 2)}\n`;
}

export function createCodexProfile({ port, model, catalogPath, bearerToken }) {
  return `model_provider = "antigravity_local"
model = ${tomlString(model)}
model_catalog_json = ${tomlString(toPortablePath(catalogPath))}

[model_providers.antigravity_local]
name = "Codex API Service"
base_url = "http://127.0.0.1:${port}/v1"
experimental_bearer_token = ${tomlString(bearerToken)}
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
supports_websockets = false

[windows]
sandbox = "unelevated"
`;
}

export function createActiveCodexConfig(current, { port, model, catalogPath, bearerToken }) {
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
  const provider = `[model_providers.antigravity_local]
name = "Codex API Service"
base_url = "http://127.0.0.1:${port}/v1"
experimental_bearer_token = ${tomlString(bearerToken)}
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
supports_websockets = false`;
  const windows = hasWindowsTable ? "" : `[windows]
sandbox = "unelevated"`;

  return `${[active, existing, provider, windows].filter(Boolean).join("\n\n")}\n`;
}

export function chooseDefaultModel(models, requested = "") {
  if (requested && models.some((model) => model.id === requested)) return requested;
  const preferences = [
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
