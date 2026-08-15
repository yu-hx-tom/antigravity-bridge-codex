import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("local dashboard serves a protected API", { timeout: 15_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-codex-bridge-"));
  const liveCodexHome = path.join(dataDir, "live-codex-home");
  const port = await freePort();
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
  } finally {
    child.kill();
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
