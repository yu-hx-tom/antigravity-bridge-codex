import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import http from "node:http";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

export async function hashFileSha256(filePath) {
  if (!fsSync.existsSync(filePath)) return null;
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fsSync.createWriteStream(destPath);

    const req = client.get(url, { headers: { "User-Agent": "AntigravityBridge-Installer/0.4.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fsSync.unlinkSync(destPath); } catch {}
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fsSync.unlinkSync(destPath); } catch {}
        return reject(new Error(`Download failed with status HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(destPath);
      });
    });

    req.on("error", (err) => {
      file.close();
      try { fsSync.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

export async function ensureMihomoInstalled(targetDir = null) {
  const rootDir = process.cwd();
  const lockPath = path.join(rootDir, "mihomo.lock.json");
  if (!fsSync.existsSync(lockPath)) {
    throw new Error(`Mihomo lock file not found at ${lockPath}`);
  }

  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const asset = lock.assets?.["windows-amd64"];
  if (!asset) {
    throw new Error("No asset configuration found for windows-amd64 in mihomo.lock.json");
  }

  const binDir = targetDir || path.join(rootDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const targetBinPath = path.join(binDir, asset.binary || "mihomo.exe");

  // 1. 如果现有 binary 已经存在并可执行，则校验版本
  if (fsSync.existsSync(targetBinPath)) {
    try {
      const { stdout } = await execFileAsync(targetBinPath, ["-v"], { timeout: 3000 });
      if (stdout.includes(lock.version) || stdout.includes("Mihomo")) {
        return { ok: true, binaryPath: targetBinPath, version: lock.version, skipped: true };
      }
    } catch {}
  }

  console.log(`Installing Mihomo v${lock.version} from ${asset.url}...`);

  const tmpDir = path.join(binDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpArchive = path.join(tmpDir, `mihomo_${Date.now()}.${asset.archive || "zip"}`);
  const tmpBinary = path.join(tmpDir, `mihomo_extracted_${Date.now()}.exe`);

  try {
    // 2. 下载到临时文件
    await downloadFile(asset.url, tmpArchive);

    // 3. 校验 SHA-256 (如果 lock 中配有确切 sha256)
    if (asset.sha256 && asset.sha256.length === 64) {
      const actualHash = await hashFileSha256(tmpArchive);
      if (actualHash !== asset.sha256.toLowerCase()) {
        throw new Error(`SHA256 mismatch: expected ${asset.sha256}, got ${actualHash}`);
      }
      console.log(`✓ SHA-256 verified successfully (${actualHash})`);
    }

    // 4. 解压
    if (asset.archive === "zip" || asset.archive === "gz") {
      // 若是 windows zip 可调用 powershell Expand-Archive
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path "${tmpArchive}" -DestinationPath "${tmpDir}" -Force`,
      ]);

      const files = await fs.readdir(tmpDir);
      const exeFile = files.find((f) => f.endsWith(".exe") && f.toLowerCase().includes("mihomo"));
      if (!exeFile) throw new Error("Extracted archive did not contain mihomo executable");

      const extractedPath = path.join(tmpDir, exeFile);
      await fs.rename(extractedPath, tmpBinary);
    } else {
      await fs.rename(tmpArchive, tmpBinary);
    }

    // 5. 验证执行
    const { stdout } = await execFileAsync(tmpBinary, ["-v"], { timeout: 3000 });
    console.log(`✓ Executable verified: ${stdout.trim()}`);

    // 6. 原子覆盖到目标路径
    await fs.rename(tmpBinary, targetBinPath);
    console.log(`✓ Mihomo successfully installed to ${targetBinPath}`);

    return { ok: true, binaryPath: targetBinPath, version: lock.version, installed: true };
  } finally {
    // 清理临时文件
    try {
      if (fsSync.existsSync(tmpArchive)) await fs.unlink(tmpArchive);
      if (fsSync.existsSync(tmpBinary)) await fs.unlink(tmpBinary);
    } catch {}
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
if (isMain || process.argv.includes("--root-bin")) {
  ensureMihomoInstalled()
    .then((res) => {
      console.log("Mihomo installer complete:", res);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Mihomo installer failed:", err);
      process.exit(1);
    });
}
