import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createCodexApiAuth, createCodexProfile, createModelCatalog } from "../core.mjs";

const timeoutMs = 15_000;

function codexEntryPoint() {
  const candidate = path.join(
    process.env.APPDATA || "",
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!process.env.APPDATA) throw new Error("APPDATA is not set");
  return candidate;
}

function sourceModels(payload) {
  if (!Array.isArray(payload?.models) || payload.models.length === 0) {
    throw new Error("The source catalog does not contain any models");
  }
  return payload.models.map((model) => ({
    id: model.slug,
    displayName: model.display_name || model.slug,
  }));
}

function waitForModelList(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for model/list")), timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2) {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
          else resolve(message.result);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Codex app-server exited before model/list (code ${code})`));
    });
  });
}

async function stopOwnChild(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_500)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

async function main() {
  const defaultCatalog = path.join(
    process.env.LOCALAPPDATA || "",
    "AntigravityCodexBridge",
    "codex-model-catalog.json",
  );
  const sourcePath = path.resolve(process.argv[2] || defaultCatalog);
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const models = sourceModels(source);
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "antigravity-catalog-verify-"));
  const catalogPath = path.join(tempHome, "models.json");
  const tokenCommandPath = path.join(tempHome, "get-token.ps1");
  let child;
  let stderr = "";

  try {
    await writeFile(catalogPath, `${JSON.stringify(createModelCatalog(models), null, 2)}\n`, "utf8");
    await writeFile(tokenCommandPath, "[Console]::Out.Write('catalog-verifier-not-used')\n", "utf8");
    await writeFile(path.join(tempHome, "config.toml"), createCodexProfile({
      port: 8317,
      model: models[0].id,
      catalogPath,
      tokenCommandPath,
    }), "utf8");
    await writeFile(path.join(tempHome, "auth.json"), createCodexApiAuth("catalog-verifier-not-used"), "utf8");

    child = spawn(process.execPath, [codexEntryPoint(), "app-server", "--stdio"], {
      env: { ...process.env, CODEX_HOME: tempHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });

    const response = waitForModelList(child);
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "antigravity-catalog-verifier", version: "0.1.0" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: {} })}\n`);

    const result = await response;
    const returned = Array.isArray(result?.data) ? result.data : [];
    const expectedIds = new Set(models.map((model) => model.id));
    const returnedIds = new Set(returned.map((model) => model.id));
    const missing = [...expectedIds].filter((id) => !returnedIds.has(id));
    const unexpected = [...returnedIds].filter((id) => !expectedIds.has(id));

    if (/invalid configuration|failed to parse model_catalog_json/i.test(stderr)) {
      throw new Error(stderr.trim());
    }
    if (missing.length || unexpected.length) {
      throw new Error(`Catalog mismatch. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
    }

    console.log(`Codex accepted ${returned.length} Antigravity models:`);
    for (const model of returned) {
      console.log(`- ${model.id} | ${model.displayName} | default=${model.defaultReasoningEffort}`);
    }
  } finally {
    if (child) await stopOwnChild(child);
    await rm(tempHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
