import test from "node:test";
import assert from "node:assert/strict";
import { pingNodesList } from "../server.mjs";

test("inactive subscription nodes do not report BGP entry TCP time as proxy latency", async () => {
  const result = await pingNodesList([{ id: "remote", name: "新加坡｜专线", server: "203.0.113.10", port: 443 }]);
  assert.equal(result.latencies.remote, null);
  assert.equal(result.measurements.remote.kind, "inactive");
  assert.equal(result.measurements.remote.label, "未激活");
  assert.equal(result.measurements.remote.valueMs, null);
  assert.equal(result.summary.inactive, 1);
});
