import test from "node:test";
import assert from "node:assert/strict";
import { parseXiyouControllerConfig, pingNodesList } from "../server.mjs";
import { parseXiyouPreferences } from "../xiyou-runtime.mjs";

test("Xiyou controller address can be recovered from a profile config", () => {
  assert.deepEqual(
    parseXiyouControllerConfig("external-controller: '127.0.0.1:9090'\nsecret: ''\n"),
    { baseUrl: "http://127.0.0.1:9090", secret: "" },
  );
  assert.equal(parseXiyouControllerConfig('external-controller: ""\n'), null);
});

test("Xiyou controller address can be recovered from shared preferences", () => {
  const raw = JSON.stringify({
    "flutter.config": JSON.stringify({
      currentProfileId: "profile-a",
      patchClashConfig: {
        "external-controller": "0.0.0.0:9090",
        secret: "local-test-secret",
      },
      profiles: [{ id: "profile-a", label: "Test" }],
    }),
  });
  const parsed = parseXiyouPreferences(raw);
  assert.equal(parsed.controller.baseUrl, "http://127.0.0.1:9090");
  assert.equal(parsed.controller.secret, "local-test-secret");
  assert.equal(parsed.currentProfileId, "profile-a");
});

test("inactive subscription nodes do not report BGP entry TCP time as proxy latency", async () => {
  process.env.BRIDGE_DISABLE_XIYOU_CONTROLLER = "1";
  try {
    const result = await pingNodesList(
      [{ id: "remote", name: "新加坡｜专线", server: "203.0.113.10", port: 443 }],
      { scope: "candidates" },
    );
    assert.equal(result.latencies.remote, null);
    assert.equal(result.measurements.remote.kind, "xiyou-urltest");
    assert.equal(result.measurements.remote.label, "西游云测速接口不可用");
    assert.equal(result.measurements.remote.valueMs, null);
    assert.equal(result.summary.inactive, 1);
  } finally {
    delete process.env.BRIDGE_DISABLE_XIYOU_CONTROLLER;
  }
});
