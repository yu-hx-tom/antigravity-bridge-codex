import assert from "node:assert/strict";
import test from "node:test";
import { friendlyProxyError, modelCapabilities, responseText } from "../protocol.mjs";

test("proxy errors are translated into actionable Chinese messages", () => {
  assert.match(friendlyProxyError(429, "Selected model is at capacity"), /模型当前满载/);
  assert.match(friendlyProxyError(429, "quota exhausted"), /额度已耗尽/);
  assert.match(friendlyProxyError(401), /凭据无效/);
  assert.match(friendlyProxyError(403), /重新登录/);
});

test("protocol helpers extract Responses text and conservative capabilities", () => {
  assert.equal(responseText({ output: [{ content: [{ type: "output_text", text: "OK" }] }] }), "OK");
  assert.equal(modelCapabilities("gemini-3.7-flash-high").imageInput, true);
  assert.equal(modelCapabilities("gpt-oss-120b-medium").imageInput, false);
  assert.equal(modelCapabilities("gemini-3.1-flash-image").parallelTools, false);
});
