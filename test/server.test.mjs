import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { atomicWriteJson, createSnapshot, updateSnapshotState } from "../transaction.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPage(url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("test server did not start");
}

test("Store launcher performs a recoverable one-click takeover", async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, "..", "server.mjs"), "utf8");
  const launcher = await fs.readFile(path.resolve(import.meta.dirname, "..", "launch-codex-api-service.ps1"), "utf8");
  assert.match(source, /shell:AppsFolder/);
  assert.doesNotMatch(source, /Start-Process -FilePath \$exe/);
  assert.match(launcher, /CloseMainWindow/);
  assert.match(launcher, /Stop-Process -ErrorAction Stop/);
  assert.match(launcher, /shell:AppsFolder/);
  assert.match(launcher, /\/api\/codex\/activate/);
  assert.match(launcher, /\/api\/codex\/reapply/);
  assert.match(launcher, /\/api\/codex\/restore/);
  assert.match(source, /\/api\/codex\/reapply/);
  assert.doesNotMatch(launcher, /WindowsApps/);
});

test("local dashboard serves a protected API and allows live model switching", { timeout: 15_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-codex-bridge-"));
  const liveCodexHome = path.join(dataDir, "live-codex-home");
  const port = await freePort();
  await fs.mkdir(liveCodexHome, { recursive: true });
  await fs.writeFile(path.join(liveCodexHome, "config.toml"), "model_provider = \"antigravity_local\"\nmodel = \"gemini-3-flash\"\n");
  await fs.writeFile(path.join(liveCodexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { test: "user-session" } }));
  await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
    clientKey: "test-client-secret",
    managementKey: "test-management-secret",
    uiKey: "test-ui-secret",
    codexHome: liveCodexHome,
  }));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_CODEX_HOME: liveCodexHome,
      BRIDGE_PORT: String(port),
      BRIDGE_NO_OPEN: "1",
    },
    stdio: "ignore",
  });
  try {
    const page = await waitForPage(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    const token = html.match(/name="bridge-key" content="([^"]+)"/)?.[1];
    assert.ok(token);

    const denied = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { "X-Bridge-Key": token } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.proxy.running, false);
    assert.equal(body.proxy.endpoint, "http://127.0.0.1:8317/v1");
    assert.equal(body.paths.codexHome, path.join(dataDir, "codex-home"));
    assert.equal(body.codex.configPath, path.join(liveCodexHome, "config.toml"));
    assert.equal(body.codex.authPath, path.join(liveCodexHome, "auth.json"));
    assert.equal(body.paths.liveCodexHome, liveCodexHome);

    // Test live model switching endpoint
    const switchRes = await fetch(`http://127.0.0.1:${port}/api/codex/model`, {
      method: "POST",
      headers: { "X-Bridge-Key": token, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.7-flash-high" }),
    });
    assert.equal(switchRes.status, 200);
    const switchBody = await switchRes.json();
    assert.equal(switchBody.model, "gemini-3.7-flash-high");

    const updatedConfig = await fs.readFile(path.join(liveCodexHome, "config.toml"), "utf8");
    assert.match(updatedConfig, /model = "gemini-3\.7-flash-high"/);

    // Verify auth.json was preserved with original user session
    const preservedAuth = JSON.parse(await fs.readFile(path.join(liveCodexHome, "auth.json"), "utf8"));
    assert.equal(preservedAuth.auth_mode, "chatgpt");
    assert.equal(preservedAuth.tokens?.test, "user-session");
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("imported subscription nodes survive a Bridge restart", { timeout: 20_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-node-cache-"));
  const liveCodexHome = path.join(dataDir, "live-codex-home");
  const subscriptionServer = http.createServer((_request, response) => {
    response.end('proxies:\n  - name: "新加坡 | 测试专线"\n    type: trojan\n    server: 203.0.113.10\n    port: 443\n    password: test\n    sni: example.com\n');
  });
  await new Promise((resolve) => subscriptionServer.listen(0, "127.0.0.1", resolve));
  const subscriptionUrl = `http://127.0.0.1:${subscriptionServer.address().port}/subscription`;
  await fs.mkdir(liveCodexHome, { recursive: true });
  await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
    clientKey: "cache-client-secret",
    managementKey: "cache-management-secret",
    uiKey: "cache-ui-secret",
    codexHome: liveCodexHome,
  }));

  let child;
  try {
    const firstPort = await freePort();
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_CODEX_HOME: liveCodexHome, BRIDGE_PORT: String(firstPort), BRIDGE_NO_OPEN: "1" },
      stdio: "ignore",
    });
    await waitForPage(`http://127.0.0.1:${firstPort}/`);
    const imported = await fetch(`http://127.0.0.1:${firstPort}/api/network/fetch-nodes`, {
      method: "POST",
      headers: { "X-Bridge-Key": "cache-ui-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionUrl }),
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).nodes.length, 1);
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));

    const storedBeforeRestart = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"));
    storedBeforeRestart.networkSettings.activation = { state: "prepared", scriptHash: "draft-only" };
    storedBeforeRestart.networkSettings.pendingEgressPlan = [{ id: "draft", port: 7892 }];
    await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify(storedBeforeRestart));

    const secondPort = await freePort();
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_CODEX_HOME: liveCodexHome, BRIDGE_PORT: String(secondPort), BRIDGE_NO_OPEN: "1" },
      stdio: "ignore",
    });
    await waitForPage(`http://127.0.0.1:${secondPort}/`);
    const restored = await fetch(`http://127.0.0.1:${secondPort}/api/network/settings`, { headers: { "X-Bridge-Key": "cache-ui-secret" } });
    const settings = await restored.json();
    assert.equal(settings.networkSettings.subscriptionUrl, subscriptionUrl);
    assert.equal(settings.networkSettings.candidateNodes.length, 1);
    assert.equal(settings.networkSettings.candidateNodes[0].name, "新加坡 | 测试专线");
    assert.equal(settings.networkSettings.activation.state, "inactive");
    assert.equal(settings.networkSettings.pendingEgressPlan.length, 0);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise((resolve) => subscriptionServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("bridge startup restores an interrupted Codex takeover", { timeout: 15_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-codex-recovery-"));
  const liveCodexHome = path.join(dataDir, "live-codex-home");
  const backupDir = path.join(dataDir, "backups", "codex-live", "interrupted");
  const port = await freePort();
  await fs.mkdir(liveCodexHome, { recursive: true });
  await fs.writeFile(path.join(liveCodexHome, "config.toml"), "model_provider = \"openai\"\n");
  let manifest = await createSnapshot(liveCodexHome, backupDir, ["config.toml", "auth.json"]);
  manifest = await updateSnapshotState(backupDir, manifest, "applying");
  await fs.writeFile(path.join(liveCodexHome, "config.toml"), "model_provider = \"antigravity_local\"\n");
  await fs.writeFile(path.join(liveCodexHome, "auth.json"), "{}\n");
  await atomicWriteJson(path.join(dataDir, "settings.json"), {
    codexHome: liveCodexHome,
    codexActiveBackup: backupDir,
  });

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_CODEX_HOME: liveCodexHome,
      BRIDGE_PORT: String(port),
      BRIDGE_NO_OPEN: "1",
    },
    stdio: "ignore",
  });
  try {
    await waitForPage(`http://127.0.0.1:${port}/`);
    assert.equal(await fs.readFile(path.join(liveCodexHome, "config.toml"), "utf8"), "model_provider = \"openai\"\n");
    await assert.rejects(fs.stat(path.join(liveCodexHome, "auth.json")), { code: "ENOENT" });
    const settings = JSON.parse(await fs.readFile(path.join(dataDir, "settings.json"), "utf8"));
    assert.equal(settings.codexActiveBackup, "");
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
