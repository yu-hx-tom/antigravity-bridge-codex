import path from "node:path";
import { modelCapabilities, sanitizeToolSchema, THOUGHT_SIGNATURE_SENTINEL } from "./protocol.mjs";

export { sanitizeToolSchema, THOUGHT_SIGNATURE_SENTINEL };

export const COMMON_MODEL_ALIASES = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
  { id: "codex-auto-review", displayName: "Codex Auto Review" },
  { id: "gpt-4o", displayName: "GPT-4o" },
  { id: "qwen3.7-plus", displayName: "Qwen 3.7 Plus" },
  { id: "qwen3-coder-plus", displayName: "Qwen 3 Coder Plus" },
  { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
];

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

export function createProxyConfig({ port, authDir, clientKey, managementKey, defaultModel = "gemini-3.7-flash-high" }) {
  const modelMappings = COMMON_MODEL_ALIASES
    .map((alias) => `  - from: "${alias.id}"\n    to: "${defaultModel}"`)
    .join("\n");

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

model-mapping:
${modelMappings}

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
  const combined = [...models];
  const existingIds = new Set(models.map((m) => m.id));
  for (const alias of COMMON_MODEL_ALIASES) {
    if (!existingIds.has(alias.id)) {
      combined.push(alias);
      existingIds.add(alias.id);
    }
  }

  return {
    models: combined.map((model, index) => {
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
  const provider = [
    'name = "Codex API Service"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
  ];
  if (bearerToken) {
    provider.push(`experimental_bearer_token = ${tomlString(bearerToken)}`);
  } else if (tokenCommandPath) {
    provider.push(`experimental_bearer_token_command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ${tomlString(toPortablePath(tokenCommandPath))}]`);
  }
  provider.push(
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 2",
    "stream_max_retries = 1",
    "stream_idle_timeout_ms = 300000",
    "supports_websockets = false",
  );
  return provider.join("\n");
}

export function createCodexProfile({ port, model, catalogPath, bearerToken, tokenCommandPath }) {
  return `model_provider = "antigravity_local"
model = ${tomlString(model)}
model_catalog_json = ${tomlString(toPortablePath(catalogPath))}

[windows]
sandbox = "unelevated"

[model_providers.antigravity_local]
${codexProvider({ port, bearerToken, tokenCommandPath })}
`;
}

export function createActiveCodexConfig(originalToml, { port, model, catalogPath, bearerToken, tokenCommandPath }) {
  const providerBlock = `[model_providers.antigravity_local]
${codexProvider({ port, bearerToken, tokenCommandPath })}`;

  let text = String(originalToml || "").replace(/\r\n/g, "\n");
  if (/^\s*model_provider\s*=/m.test(text)) {
    text = text.replace(/^\s*model_provider\s*=.*$/m, 'model_provider = "antigravity_local"');
  } else {
    text = `model_provider = "antigravity_local"\n${text}`;
  }

  if (/^\s*model\s*=/m.test(text)) {
    text = text.replace(/^\s*model\s*=.*$/m, `model = ${tomlString(model)}`);
  } else {
    text = `model = ${tomlString(model)}\n${text}`;
  }

  if (/^\s*model_catalog_json\s*=/m.test(text)) {
    text = text.replace(/^\s*model_catalog_json\s*=.*$/m, `model_catalog_json = ${tomlString(toPortablePath(catalogPath))}`);
  } else {
    text = `model_catalog_json = ${tomlString(toPortablePath(catalogPath))}\n${text}`;
  }

  text = text.replace(/\[model_providers\.antigravity_local\][\s\S]*?(?=\n\[|$)/g, "").trimEnd();
  text = `${text}\n\n${providerBlock}\n`;

  if (/\[windows\][\s\S]*?sandbox\s*=/m.test(text)) {
    text = text.replace(/(\[windows\][\s\S]*?sandbox\s*=\s*)"[^"]*"/m, '$1"unelevated"');
  } else {
    text = `${text}\n[windows]\nsandbox = "unelevated"\n`;
  }

  return `${text.trim()}\n`;
}

export function chooseDefaultModel(models) {
  const preferred = [
    "gemini-3.7-flash-high",
    "gemini-3.7-flash",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash",
    "gemini-3-flash",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
  ];
  for (const candidate of preferred) {
    const matched = models.find((model) => model.id.toLowerCase() === candidate);
    if (matched) return matched.id;
  }
  return models[0]?.id || "gemini-3.7-flash-high";
}

export function isAntigravityAccount(account) {
  return /@(?:gmail\.com|googlemail\.com)$/i.test(account?.email || account?.name || "")
    || Boolean(account?.tokens?.refresh_token)
    || Boolean(account?.tokens?.id_token)
    || Boolean(account?.oauth);
}
