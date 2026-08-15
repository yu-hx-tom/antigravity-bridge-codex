import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createTokenCommand,
  openDirectory,
  readProtectedJson,
  sealDirectory,
  writeProtectedJson,
} from "../security.mjs";

const execFileAsync = promisify(execFile);

test("Windows DPAPI protects bridge secrets at rest", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ag-secrets-"));
  const secretPath = path.join(root, "secrets.dpapi");
  const secrets = { clientKey: "client-test", managementKey: "manager-test", uiKey: "ui-test" };
  try {
    await writeProtectedJson(secretPath, secrets);
    const stored = await fs.readFile(secretPath, "utf8");
    assert.doesNotMatch(stored, /client-test|manager-test|ui-test/);
    assert.deepEqual(await readProtectedJson(secretPath), secrets);
    const command = createTokenCommand(secretPath);
    assert.match(command, /ProtectedData]::Unprotect/);
    assert.doesNotMatch(command, /client-test/);
    const commandPath = path.join(root, "get-token.ps1");
    await fs.writeFile(commandPath, command);
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      commandPath,
    ], { windowsHide: true });
    assert.equal(stdout, "client-test");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows DPAPI vault seals and restores OAuth files", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ag-oauth-vault-"));
  const authDir = path.join(root, "auths");
  const vaultPath = path.join(root, "oauth.dpapi");
  await fs.mkdir(path.join(authDir, "nested"), { recursive: true });
  await fs.writeFile(path.join(authDir, "account.json"), "oauth-secret-one");
  await fs.writeFile(path.join(authDir, "nested", "account.json"), "oauth-secret-two");
  try {
    assert.deepEqual(await sealDirectory(authDir, vaultPath), { sealed: true, count: 2 });
    const vault = await fs.readFile(vaultPath, "utf8");
    assert.doesNotMatch(vault, /oauth-secret/);
    await assert.rejects(fs.stat(path.join(authDir, "account.json")), { code: "ENOENT" });

    assert.deepEqual(await openDirectory(authDir, vaultPath), { opened: true, count: 2 });
    assert.equal(await fs.readFile(path.join(authDir, "account.json"), "utf8"), "oauth-secret-one");
    assert.equal(await fs.readFile(path.join(authDir, "nested", "account.json"), "utf8"), "oauth-secret-two");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
