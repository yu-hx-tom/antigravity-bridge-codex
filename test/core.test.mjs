import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseDefaultModel,
  createActiveCodexConfig,
  createCodexApiAuth,
  createCodexProfile,
  createModelCatalog,
  createProxyConfig,
  extractProjectId,
  normalizeModels,
  parseQuotaPayload,
} from "../core.mjs";

test("proxy config stays loopback-only and enables safe routing defaults", () => {
  const config = createProxyConfig({
    port: 8317,
    authDir: "D:\\Data\\auths",
    clientKey: "client-secret",
    managementKey: "management-secret",
  });
  assert.match(config, /host: "127\.0\.0\.1"/);
  assert.match(config, /auth-dir: "D:\/Data\/auths"/);
  assert.match(config, /allow-remote: false/);
  assert.match(config, /session-affinity: true/);
  assert.match(config, /antigravity-credits: false/);
});

test("quota parser supports map-shaped Antigravity responses", () => {
  const models = parseQuotaPayload({
    models: {
      "gemini-3-flash": {
        displayName: "Gemini 3 Flash",
        quotaInfo: { remainingFraction: 0.73, resetTime: "2026-08-16T00:00:00Z" },
      },
    },
  });
  assert.deepEqual(models, [{
    id: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    remainingFraction: 0.73,
    resetTime: "2026-08-16T00:00:00Z",
  }]);
});

test("quota parser clamps fractions and supports array responses", () => {
  const models = parseQuotaPayload({
    models: [
      { name: "a", remainingFraction: 2 },
      { name: "b", quota_info: { remaining_fraction: -1 } },
    ],
  });
  assert.equal(models.find((model) => model.id === "a").remainingFraction, 1);
  assert.equal(models.find((model) => model.id === "b").remainingFraction, 0);
});

test("project id parser supports string and object loadCodeAssist responses", () => {
  assert.equal(extractProjectId({ cloudaicompanionProject: "project-a" }), "project-a");
  assert.equal(extractProjectId({ cloudaicompanionProject: { id: "project-b" } }), "project-b");
  assert.equal(extractProjectId({}), "");
});

test("models normalize, deduplicate and produce a Codex catalog", () => {
  const models = normalizeModels({ data: [
    { id: "gemini-3-flash", owned_by: "google" },
    { id: "gemini-3-flash" },
    { id: "claude-sonnet-4-5", display_name: "Claude Sonnet" },
  ] });
  assert.equal(models.length, 2);
  assert.equal(chooseDefaultModel(models), "gemini-3-flash");
  const catalog = createModelCatalog(models);
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].visibility, "list");
  assert.equal(catalog.models[0].apply_patch_tool_type, "freeform");
  assert.ok(catalog.models.every((model) => model.base_instructions?.length > 0));
});

test("Codex profile uses Responses API and a local API key", () => {
  const profile = createCodexProfile({
    port: 8317,
    model: "gemini-3-flash",
    catalogPath: "D:\\Data\\models.json",
    bearerToken: "local-secret",
  });
  assert.match(profile, /model_provider = "antigravity_local"/);
  assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
  assert.match(profile, /name = "Codex API Service"/);
  assert.match(profile, /experimental_bearer_token = "local-secret"/);
  assert.match(profile, /wire_api = "responses"/);
  assert.match(profile, /requires_openai_auth = false/);
  assert.match(profile, /\[windows\]\nsandbox = "unelevated"/);
  assert.match(profile, /D:\/Data\/models\.json/);
});

test("Codex API Service auth uses API key mode without OAuth tokens", () => {
  const auth = JSON.parse(createCodexApiAuth("local-secret"));
  assert.deepEqual(auth, {
    auth_mode: "apikey",
    OPENAI_API_KEY: "local-secret",
  });
  assert.equal(auth.tokens, undefined);
});

test("active Codex config replaces only routing keys and preserves user settings", () => {
  const config = createActiveCodexConfig(`model = "gpt-official"
model_provider = "openai"
service_tier = "default"

[mcp_servers.demo]
command = "demo"

[model_providers.antigravity_local]
base_url = "http://old/v1"
experimental_bearer_token = "old"

[features]
apps = true

[windows]
sandbox = "elevated"
`, {
    port: 8317,
    model: "gemini-3-flash",
    catalogPath: "D:\\Data\\models.json",
    bearerToken: "local-secret",
  });

  assert.equal(config.match(/^model_provider\s*=/gm)?.length, 1);
  assert.equal(config.match(/^model\s*=/gm)?.length, 1);
  assert.match(config, /model = "gemini-3-flash"/);
  assert.match(config, /model_provider = "antigravity_local"/);
  assert.match(config, /\[model_providers\.antigravity_local\]/);
  assert.match(config, /experimental_bearer_token = "local-secret"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /\[mcp_servers\.demo\]\ncommand = "demo"/);
  assert.match(config, /service_tier = "default"/);
  assert.match(config, /\[features\]\napps = true/);
  assert.equal(config.match(/^\[windows\]$/gm)?.length, 1);
  assert.equal(config.match(/^sandbox\s*=/gm)?.length, 1);
  assert.match(config, /\[windows\]\nsandbox = "unelevated"/);
  assert.doesNotMatch(config, /http:\/\/old/);
  assert.doesNotMatch(config, /openai_base_url/);
});

test("active Codex config adds the unelevated Windows fallback when absent", () => {
  const config = createActiveCodexConfig("service_tier = \"default\"\n", {
    port: 8317,
    model: "gemini-3-flash",
    catalogPath: "D:\\Data\\models.json",
    bearerToken: "local-secret",
  });

  assert.match(config, /\[windows\]\nsandbox = "unelevated"/);
});
