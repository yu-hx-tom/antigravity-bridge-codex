import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryCollector, extractOutputTokenUsage, estimateOutputTokensFromText } from "../telemetry.mjs";

test("extractOutputTokenUsage correctly extracts token count across diverse response shapes", () => {
  // 1. OpenAI format
  assert.equal(extractOutputTokenUsage({ usage: { completion_tokens: 42 } }), 42);
  assert.equal(extractOutputTokenUsage({ usage: { output_tokens: 99 } }), 99);

  // 2. Responses API format
  assert.equal(extractOutputTokenUsage({ response: { usage: { output_tokens: 128 } } }), 128);

  // 3. Directly in payload
  assert.equal(extractOutputTokenUsage({ output_tokens: 256 }), 256);

  // 4. Missing
  assert.equal(extractOutputTokenUsage({}), null);
  assert.equal(extractOutputTokenUsage(null), null);
});

test("estimateOutputTokensFromText estimates token count from text without fake precision", () => {
  const text = "Hello world! This is a test response for space voyages.";
  const estimated = estimateOutputTokensFromText(text);
  assert.ok(estimated > 0);
});

test("CASE T1: Deterministic TTFT, duration and TPS with fake clock", () => {
  let currentTime = 1000;
  const fakeClock = () => currentTime;
  const collector = new TelemetryCollector({ clock: fakeClock });

  collector.beginRequest({ requestId: "req-1", model: "test-model" });

  currentTime = 1500; // 500ms later -> first output
  collector.markFirstOutput("req-1");

  currentTime = 3500; // 2000ms gen time later -> complete with 100 tokens
  const result = collector.completeRequest("req-1", {
    usagePayload: { usage: { output_tokens: 100 } },
  });

  assert.equal(result.ttftMs, 500);
  assert.equal(result.generationMs, 2000);
  assert.equal(result.totalDurationMs, 2500);
  assert.equal(result.outputTokens, 100);
  assert.equal(result.tokensPerSec, 50.0); // 100 / 2.0s = 50.0
  assert.equal(result.tokenSource, "api-usage");
  assert.equal(result.estimated, false);
});

test("CASE T2: Slow stream (8.0 tokens/s) is preserved exactly without clamping to 15/20", () => {
  let currentTime = 1000;
  const collector = new TelemetryCollector({ clock: () => currentTime });

  collector.beginRequest({ requestId: "req-slow" });
  currentTime = 1200;
  collector.markFirstOutput("req-slow");
  currentTime = 6200; // 5000ms gen time for 40 tokens -> 8.0 tokens/s

  const result = collector.completeRequest("req-slow", {
    usagePayload: { usage: { output_tokens: 40 } },
  });

  assert.equal(result.tokensPerSec, 8.0);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.avgTokensPerSec, 8.0);
});

test("CASE T3: Ultra fast stream (250.0 tokens/s) is preserved exactly without clamping to 120", () => {
  let currentTime = 1000;
  const collector = new TelemetryCollector({ clock: () => currentTime });

  collector.beginRequest({ requestId: "req-fast" });
  currentTime = 1100;
  collector.markFirstOutput("req-fast");
  currentTime = 2100; // 1000ms gen time for 250 tokens -> 250.0 tokens/s

  const result = collector.completeRequest("req-fast", {
    usagePayload: { usage: { output_tokens: 250 } },
  });

  assert.equal(result.tokensPerSec, 250.0);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.avgTokensPerSec, 250.0);
});

test("CASE T4: Weighted global session average: (100 tok / 2s) + (300 tok / 3s) = 80.0 t/s", () => {
  let currentTime = 0;
  const collector = new TelemetryCollector({ clock: () => currentTime });

  // Request A: 100 tokens in 2.0s (50 t/s)
  collector.beginRequest({ requestId: "req-a" });
  currentTime = 200;
  collector.markFirstOutput("req-a");
  currentTime = 2200;
  collector.completeRequest("req-a", { usagePayload: { usage: { output_tokens: 100 } } });

  // Request B: 300 tokens in 3.0s (100 t/s)
  collector.beginRequest({ requestId: "req-b" });
  currentTime = 2500;
  collector.markFirstOutput("req-b");
  currentTime = 5500;
  collector.completeRequest("req-b", { usagePayload: { usage: { output_tokens: 300 } } });

  const snapshot = collector.snapshot();
  // Total tokens: 400, Total gen seconds: 5.0 -> 400 / 5 = 80.0 t/s
  assert.equal(snapshot.totalOutputTokens, 400);
  assert.equal(snapshot.totalGenerationSeconds, 5.0);
  assert.equal(snapshot.weightedAvgTokensPerSec, 80.0);
  assert.equal(snapshot.avgTokensPerSec, 80.0);
});

test("CASE T5: Request deduplication prevents double-counting the same requestId", () => {
  let currentTime = 0;
  const collector = new TelemetryCollector({ clock: () => currentTime });

  collector.beginRequest({ requestId: "req-dup" });
  currentTime = 1000;
  collector.completeRequest("req-dup", { usagePayload: { usage: { output_tokens: 50 } } });

  // Second complete call on same ID
  currentTime = 2000;
  collector.completeRequest("req-dup", { usagePayload: { usage: { output_tokens: 50 } } });

  const snapshot = collector.snapshot();
  assert.equal(snapshot.completedRequests, 1);
  assert.equal(snapshot.totalOutputTokens, 50);
});

test("CASE T8 & T9: Real usage sets estimated=false; missing usage sets estimated=true", () => {
  const collector = new TelemetryCollector();

  // With usage
  collector.beginRequest({ requestId: "with-usage" });
  const res1 = collector.completeRequest("with-usage", { usagePayload: { usage: { output_tokens: 64 } } });
  assert.equal(res1.tokenSource, "api-usage");
  assert.equal(res1.estimated, false);

  // Without usage (fallback estimate)
  collector.beginRequest({ requestId: "no-usage" });
  const res2 = collector.completeRequest("no-usage", { finalText: "Hello world!" });
  assert.equal(res2.tokenSource, "tokenizer-estimate");
  assert.equal(res2.estimated, true);
  assert.ok(res2.outputTokens > 0);
});
