import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFileSha256 } from "../scripts/install-mihomo.mjs";

test("mihomo.lock.json contains pinned version, asset URL, and sha256", async () => {
  const lockPath = path.resolve("mihomo.lock.json");
  const lockContent = await fs.readFile(lockPath, "utf8");
  const lock = JSON.parse(lockContent);

  assert.ok(lock.version);
  assert.ok(lock.assets["windows-amd64"]);
  const asset = lock.assets["windows-amd64"];
  assert.ok(asset.url.startsWith("https://github.com/MetaCubeX/mihomo/releases"));
  assert.ok(asset.sha256 && asset.sha256.length === 64);
  assert.equal(asset.binary, "mihomo.exe");
});

test("hashFileSha256 calculates consistent sha256 checksum", async () => {
  const lockPath = path.resolve("mihomo.lock.json");
  const hash = await hashFileSha256(lockPath);
  assert.ok(hash && hash.length === 64);
});
