import test from "node:test";
import assert from "node:assert/strict";
import { requireVerifiedEgress } from "../server.mjs";

test("requireVerifiedEgress rejects port <= 0 in isolated mode", async () => {
  await assert.rejects(
    async () => requireVerifiedEgress(0, { requireListening: false }),
    /必须指定合法的专属独立出口端口/
  );
});

test("requireVerifiedEgress rejects when network is inactive in isolated mode", async () => {
  await assert.rejects(
    async () => requireVerifiedEgress(7892, { requireListening: false }),
    /多通道网络尚未完全就绪/
  );
});
