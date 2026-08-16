import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRateLimit,
  friendlyProxyError,
  modelCapabilities,
  responseText,
  sanitizeToolSchema,
  THOUGHT_SIGNATURE_SENTINEL,
} from "../protocol.mjs";

test("proxy errors are translated into actionable Chinese messages", () => {
  assert.match(friendlyProxyError(429, "Selected model is at capacity"), /模型当前满载/);
  assert.match(friendlyProxyError(429, "quota exhausted"), /(?:配额|额度)已耗尽/);
  assert.match(friendlyProxyError(401), /凭据无效/);
  assert.match(friendlyProxyError(403), /重新登录/);
});

test("429 rate limit classification identifies soft, minute and daily limits", () => {
  const soft = classifyRateLimit("too many requests", 1500);
  assert.equal(soft.category, "soft_rate_limit");

  const minLimit = classifyRateLimit("rate limit exceeded", 60000);
  assert.equal(minLimit.category, "rate_limited");
  assert.match(minLimit.description, /分钟/);

  const dailyExhausted = classifyRateLimit("RESOURCE_EXHAUSTED individual quota reached");
  assert.equal(dailyExhausted.category, "quota_exhausted");
  assert.match(dailyExhausted.description, /额度已耗尽/);
});

test("tool schema sanitization strips unsupported protobuf keywords", () => {
  const inputSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "WriteFile",
    description: "Write content to a file",
    properties: {
      path: { type: "string", description: "File path", minLength: 1 },
      content: { type: "string", description: "File body" },
    },
    required: ["path", "content"],
    additionalProperties: false,
    propertyNames: { pattern: "^[a-z]+$" },
  };

  const clean = sanitizeToolSchema(inputSchema);
  assert.equal(clean.$schema, undefined);
  assert.equal(clean.propertyNames, undefined);
  assert.equal(clean.type, "object");
  assert.equal(clean.description, "Write content to a file");
  assert.equal(clean.properties.path.type, "string");
  assert.equal(clean.properties.path.minLength, undefined);
  assert.deepEqual(clean.required, ["path", "content"]);
});

test("thought signature sentinel is defined correctly", () => {
  assert.equal(THOUGHT_SIGNATURE_SENTINEL, "skip_thought_signature_validator");
});

test("protocol helpers extract Responses text and conservative capabilities", () => {
  assert.equal(responseText({ output: [{ content: [{ type: "output_text", text: "OK" }] }] }), "OK");
  assert.equal(modelCapabilities("gemini-3.7-flash-high").imageInput, true);
  assert.equal(modelCapabilities("gpt-oss-120b-medium").imageInput, false);
  assert.equal(modelCapabilities("gemini-3.1-flash-image").parallelTools, false);
});
