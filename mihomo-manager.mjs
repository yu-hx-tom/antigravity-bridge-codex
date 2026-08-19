import { spawn, execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class MihomoManager extends EventEmitter {
  constructor({ binDir = "bin", dataDir = ".data/mihomo" } = {}) {
    super();
    this.binDir = binDir;
    this.dataDir = dataDir;
    this.process = null;
    this.pid = null;
    this.starting = false;
    this.startedAt = null;
    this.activeConfigPath = null;
    this.controllerPort = 19090;
    this.controllerSecret = "";
    this.lastExitCode = null;
    this.lastError = "";
    this.intentionalStop = false;
    this.logHistory = [];
    this.processLogs = [];
    this.maxProcessLogs = 300;
  }

  addLog(msg, level = "info") {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: String(msg || ""),
    };
    this.logHistory.push(entry);
    if (this.logHistory.length > 200) this.logHistory.shift();
  }

  appendProcessLog(stream, text) {
    const lines = String(text || "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      this.processLogs.push({
        at: new Date().toISOString(),
        stream,
        line: line.trim(),
      });
    }
    while (this.processLogs.length > this.maxProcessLogs) {
      this.processLogs.shift();
    }
  }

  getProcessLogs(limit = 100) {
    return this.processLogs.slice(-limit);
  }

  /**
   * 探测 Mihomo 可执行文件路径
   */
  detectBinaryPath() {
    const candidates = [
      path.join(this.dataDir, "bin", "mihomo.exe"),
      path.join(this.binDir, "mihomo.exe"),
      path.join(process.cwd(), "bin", "mihomo.exe"),
      path.join(process.cwd(), "core", "mihomo.exe"),
      path.join(this.binDir, "mihomo"),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return path.resolve(c);
    }
    return null;
  }

  /**
   * 获取内核版本信息
   */
  async getVersion() {
    const binPath = this.detectBinaryPath();
    if (!binPath) return { ok: false, error: "未找到 Mihomo 内核二进制文件" };
    try {
      const { stdout } = await execFileAsync(binPath, ["-v"], { timeout: 3000, windowsHide: true });
      return { ok: true, versionText: stdout.trim(), binaryPath: binPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 配置语法预检 (-t)
   */
  async testConfig(configPath) {
    const binPath = this.detectBinaryPath();
    if (!binPath) throw new Error("未找到 Mihomo 内核，无法执行配置预检");
    if (!fsSync.existsSync(configPath)) throw new Error(`配置文件不存在: ${configPath}`);

    const dir = path.dirname(path.resolve(configPath));
    try {
      const { stdout, stderr } = await execFileAsync(binPath, ["-t", "-d", dir, "-f", configPath], {
        timeout: 5000,
        windowsHide: true,
      });
      return { ok: true, output: (stdout + "\n" + stderr).trim() };
    } catch (err) {
      const msg = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + err.message;
      return { ok: false, error: msg.trim() };
    }
  }

  /**
   * 检查单个 TCP 端口是否连通
   */
  async canConnect(port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  /**
   * 请求 Controller API (127.0.0.1:19090)
   */
  async requestController(apiPath, { method = "GET", body = null, timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (this.controllerSecret) {
        headers["Authorization"] = `Bearer ${this.controllerSecret}`;
      }
      let reqBody = null;
      if (body) {
        reqBody = typeof body === "string" ? body : JSON.stringify(body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(reqBody);
      }

      const req = http.request({
        host: "127.0.0.1",
        port: this.controllerPort,
        path: apiPath.startsWith("/") ? apiPath : `/${apiPath}`,
        method,
        headers,
        timeout: timeoutMs,
      }, (res) => {
        let d = "";
        res.on("data", (chunk) => d += chunk);
        res.on("end", () => {
          try {
            const json = d ? JSON.parse(d) : {};
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json });
          } catch {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, raw: d });
          }
        });
      });

      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Controller request timeout on ${apiPath}`));
      });

      if (reqBody) req.write(reqBody);
      req.end();
    });
  }

  /**
   * 等待 Mihomo 完整就绪：进程存活 + 所有 Listener 端口就绪 + Controller HTTP 2xx
   */
  async waitReady({ expectedPorts = [], timeoutMs = 8000 } = {}) {
    const startTime = Date.now();
    let lastPortChecks = [];
    let controllerOk = false;

    while (Date.now() - startTime < timeoutMs) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error("Mihomo 进程在等待就绪期间意外退出");
      }

      // 1. 检查 Listener 端口
      if (expectedPorts.length > 0) {
        lastPortChecks = await Promise.all(expectedPorts.map((p) => this.canConnect(p, 400)));
      } else {
        lastPortChecks = [true];
      }

      // 2. 检查 Controller API /version
      try {
        const ctrlRes = await this.requestController("/version", { timeoutMs: 800 });
        controllerOk = Boolean(ctrlRes && ctrlRes.ok);
      } catch {
        controllerOk = false;
      }

      if (lastPortChecks.every(Boolean) && controllerOk) {
        const readyCount = expectedPorts.length;
        this.addLog(`✓ 内置 Mihomo 已完全就绪 (Listeners: ${readyCount}/${readyCount}, Controller: ready)`);
        return true;
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    const failedPorts = expectedPorts.filter((p, i) => !lastPortChecks[i]);
    const reasons = [];
    if (failedPorts.length > 0) reasons.push(`端口未连通: ${failedPorts.join(", ")}`);
    if (!controllerOk) reasons.push(`Controller (${this.controllerPort}) 未响应`);
    throw new Error(`内置 Mihomo 启动就绪超时 (${timeoutMs}ms): ${reasons.join("; ")}`);
  }

  /**
   * 启动内置 Mihomo
   */
  async start({ configPath, controllerPort = 19090, secret = "", expectedPorts = [], skipPreflight = false }) {
    const binPath = this.detectBinaryPath();
    if (!binPath) throw new Error("未找到内置 Mihomo 内核文件 (mihomo.exe)");

    // 1. 语法预检
    if (!skipPreflight) {
      const testRes = await this.testConfig(configPath);
      if (!testRes.ok) {
        throw new Error(`Mihomo 配置预检未通过:\n${testRes.error}`);
      }
    }

    // 2. 停止当前正在运行的本进程
    await this.stop();

    this.starting = true;
    this.intentionalStop = false;
    this.controllerPort = controllerPort;
    this.controllerSecret = secret;
    this.activeConfigPath = configPath;

    const workDir = path.dirname(path.resolve(configPath));
    await fs.mkdir(workDir, { recursive: true });

    this.addLog(`正在拉起独立专向 Mihomo 内核 (PID 管理模式)...`);

    const child = spawn(binPath, ["-d", workDir, "-f", path.resolve(configPath)], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.pid = child.pid;
    this.startedAt = new Date().toISOString();

    if (child.stdout) {
      child.stdout.on("data", (buf) => {
        this.appendProcessLog("stdout", buf.toString("utf8"));
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (buf) => {
        this.appendProcessLog("stderr", buf.toString("utf8"));
      });
    }

    child.on("exit", (code, signal) => {
      const wasIntentional = this.intentionalStop;
      this.addLog(`Mihomo 进程 (PID: ${this.pid}) 已退出 [code: ${code}, signal: ${signal}, intentional: ${wasIntentional}]`, wasIntentional ? "info" : "warn");
      this.lastExitCode = code;
      const oldPid = this.pid;

      if (this.process === child) {
        this.process = null;
        this.pid = null;
      }

      if (wasIntentional) {
        this.emit("stopped", { code, signal, pid: oldPid });
      } else {
        this.emit("unexpected-exit", { code, signal, pid: oldPid, configPath: this.activeConfigPath });
      }
    });

    try {
      // 3. 等待所有监听端口与 Controller 就绪
      await this.waitReady({ expectedPorts, timeoutMs: 8000 });
      this.starting = false;
      this.emit("started", { pid: this.pid, configPath, expectedPorts, controllerPort });
      return {
        ok: true,
        pid: this.pid,
        controllerPort: this.controllerPort,
        expectedPorts,
      };
    } catch (err) {
      this.starting = false;
      await this.stop();
      throw err;
    }
  }

  /**
   * 安全停止当前 Mihomo 子进程（精准通过 PID 终止，绝不影响系统其他代理）
   */
  async stop() {
    this.intentionalStop = true;
    const currentPid = this.pid;
    const proc = this.process;

    this.process = null;
    this.pid = null;
    this.starting = false;

    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }

    if (currentPid && process.platform === "win32") {
      try {
        await execFileAsync("taskkill.exe", ["/F", "/PID", String(currentPid), "/T"], {
          timeout: 2000,
          windowsHide: true,
        });
      } catch {}
    }
  }

  /**
   * 获取当前运行状态（供 API / 仪表盘展示，安全脱敏）
   */
  getStatus() {
    return {
      running: Boolean(this.process && this.pid),
      pid: this.pid,
      starting: this.starting,
      startedAt: this.startedAt,
      controllerPort: this.controllerPort,
      activeConfigPath: this.activeConfigPath,
      lastExitCode: this.lastExitCode,
    };
  }
}

export const globalMihomoManager = new MihomoManager();
