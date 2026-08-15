import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function atomicWrite(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createSnapshot(liveHome, backupDir, fileNames) {
  await fs.mkdir(backupDir, { recursive: true });
  const files = [];
  for (const name of fileNames) {
    const sourcePath = path.join(liveHome, name);
    let data;
    try {
      data = await fs.readFile(sourcePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (data === undefined) {
      files.push({ name, existed: false, sha256: null });
      continue;
    }
    const digest = sha256(data);
    const backupPath = path.join(backupDir, name);
    await atomicWrite(backupPath, data);
    if (await hashFile(backupPath) !== digest) throw new Error(`Backup verification failed for ${name}`);
    files.push({ name, existed: true, sha256: digest });
  }
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "prepared",
    liveHome: path.resolve(liveHome),
    files,
  };
}

function manifestFiles(manifest) {
  if (Array.isArray(manifest?.files)) return manifest.files;
  return [
    { name: "config.toml", existed: Boolean(manifest?.configExists), sha256: null },
    { name: "auth.json", existed: Boolean(manifest?.authExists), sha256: null },
  ];
}

export async function verifySnapshot(backupDir, manifest) {
  for (const file of manifestFiles(manifest)) {
    if (!file.existed) continue;
    const backupPath = path.join(backupDir, file.name);
    const digest = await hashFile(backupPath);
    if (!digest || (file.sha256 && digest !== file.sha256)) {
      throw new Error(`Backup verification failed for ${file.name}`);
    }
  }
  return true;
}

export async function applyFiles(entries) {
  for (const entry of entries) {
    await atomicWrite(entry.path, entry.data);
    const expected = sha256(entry.data);
    if (await hashFile(entry.path) !== expected) throw new Error(`Write verification failed for ${entry.path}`);
  }
}

export async function restoreSnapshot(backupDir, manifest) {
  await verifySnapshot(backupDir, manifest);
  const liveHome = path.resolve(manifest.liveHome);
  await fs.mkdir(liveHome, { recursive: true });
  for (const file of manifestFiles(manifest)) {
    const target = path.join(liveHome, file.name);
    if (!file.existed) {
      await fs.rm(target, { force: true });
      if (await hashFile(target) !== null) throw new Error(`Restore verification failed for ${file.name}`);
      continue;
    }
    const data = await fs.readFile(path.join(backupDir, file.name));
    await atomicWrite(target, data);
    const expected = file.sha256 || sha256(data);
    if (await hashFile(target) !== expected) throw new Error(`Restore verification failed for ${file.name}`);
  }
}

export async function updateSnapshotState(backupDir, manifest, state, details = {}) {
  const next = {
    ...manifest,
    ...details,
    state,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(path.join(backupDir, "manifest.json"), next);
  return next;
}
