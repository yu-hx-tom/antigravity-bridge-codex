import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import crypto from "node:crypto";
import { compileMihomoConfig } from "./mihomo-config.mjs";

export class EgressVerificationError extends Error {
  constructor(message, failedDetails = []) {
    super(message);
    this.name = "EgressVerificationError";
    this.failedDetails = failedDetails;
  }
}

export class MihomoActivationRollbackError extends Error {
  constructor(message, originalError, rollbackError) {
    super(message);
    this.name = "MihomoActivationRollbackError";
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

export class MihomoRuntimeCoordinator {
  constructor({ dataDir, manager, probeGeoFn, saveSettingsFn, addLogFn } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), ".data", "mihomo");
    this.compiledDir = path.join(this.dataDir, "compiled");
    this.manager = manager;
    this.probeGeoFn = probeGeoFn;
    this.saveSettingsFn = saveSettingsFn;
    this.addLogFn = addLogFn || (() => {});
    this.runtimeSettingsRef = null;
    this.runtimeRef = null;
    this.crashRecoveryCount = 0;
    this.crashRecoveryTimer = null;
  }

  init({ runtime, settings }) {
    this.runtimeRef = runtime;
    this.runtimeSettingsRef = settings;

    // 监听意外退出生命周期事件
    if (this.manager && typeof this.manager.on === "function") {
      this.manager.on("unexpected-exit", (ev) => this.handleUnexpectedExit(ev));
    }
  }

  log(msg, level = "info") {
    this.addLogFn("mihomo", msg, level);
  }

  async setActivationState(state, patch = {}) {
    const netSettings = this.runtimeSettingsRef?.networkSettings || {};
    const oldActivation = netSettings.activation || {};

    const updated = {
      ...oldActivation,
      state,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    if (state === "active") {
      updated.verifiedAt = patch.verifiedAt || new Date().toISOString();
      updated.failure = "";
      updated.degradedReason = "";
    } else if (state === "degraded") {
      updated.degradedReason = patch.degradedReason || patch.failure || "Mihomo runtime unavailable";
    } else if (state === "failed") {
      updated.failure = patch.failure || "Activation failed";
    }

    netSettings.activation = updated;
    if (this.runtimeSettingsRef) {
      this.runtimeSettingsRef.networkSettings = netSettings;
    }

    if (this.saveSettingsFn) {
      await this.saveSettingsFn();
    }
    return updated;
  }

  /**
   * 严密比对并核验所有出口通道 (分层探测：Listener -> Internet -> Geo)
   */
  async verifyEgressPlan(egressPlan) {
    const regionExpectedCode = {
      "台湾": "TW",
      "新加坡": "SG",
      "美国": "US",
      "日本": "JP",
      "韩国": "KR",
      "英国": "GB",
      "德国": "DE",
      "法国": "FR",
      "加拿大": "CA",
      "澳大利亚": "AU",
    };

    const verifiedPlan = [];
    const failedDetails = [];

    for (const item of egressPlan) {
      const port = Number(item.port);
      const targetRegion = item.region || "";
      const expectedCode = regionExpectedCode[targetRegion] || null;

      // Layer 1: Listener TCP 端口连通性
      const listenerOk = this.manager?.canConnect ? await this.manager.canConnect(port, 500) : true;
      if (!listenerOk) {
        const errMsg = `端口 ${port} (${item.proxyName || item.proxy}) Listener 本地无响应`;
        failedDetails.push(errMsg);
        this.log(`[mihomo] 端口 ${port} Listener 未监听`, "warn");
        verifiedPlan.push({
          ...item,
          state: "failed",
          listenerOk: false,
          internetOk: false,
          geoOk: false,
          verified: false,
          realGeo: null,
          error: errMsg,
        });
        continue;
      }

      // Layer 2: Internet 公网端到端连通性与 Layer 3: Geo 探测
      let probeResult = { ok: false, error: "probeFn not configured" };
      if (this.probeGeoFn) {
        probeResult = await this.probeGeoFn(port, 5000);
        if (!probeResult.ok) {
          await new Promise((r) => setTimeout(r, 600));
          probeResult = await this.probeGeoFn(port, 5000);
        }
      }

      if (!probeResult.ok) {
        const errMsg = `端口 ${port} (${item.proxyName || item.proxy}) 公网出口不可达: ${probeResult.error}`;
        failedDetails.push(errMsg);
        this.log(`[mihomo] 端口 ${port} 出口探测失败: ${probeResult.error}`, "warn");
        verifiedPlan.push({
          ...item,
          state: "failed",
          listenerOk: true,
          internetOk: false,
          geoOk: false,
          verified: false,
          realGeo: null,
          error: errMsg,
        });
        continue;
      }

      // Layer 3: Geo 出口代码匹配
      const realCode = String(probeResult.countryCode || "").toUpperCase();
      let geoOk = true;
      let state = "active";
      let mismatchReason = "";

      if (!realCode) {
        // Geo 服务未返回国家代码，但公网已通达 -> 降级为 geo_unknown
        geoOk = false;
        state = "geo_unknown";
        mismatchReason = "出口已连通，但 Geo 查询服务未返回明确地区代码";
        this.log(`[mihomo] 端口 ${port} 出口连通但 Geo 未知`, "warn");
      } else if (expectedCode && realCode !== expectedCode && !item.isCustomIsp) {
        // 明确指定预期地区但实测不符
        geoOk = false;
        state = "geo_mismatch";
        mismatchReason = `预期出口为 [${expectedCode}/${targetRegion}]，实测为 [${realCode}/${probeResult.country || "未知"}]`;
        failedDetails.push(`端口 ${port} ${mismatchReason}`);
        this.log(`[mihomo] 端口 ${port} Geo 校验不符: ${mismatchReason}`, "warn");
      }

      const isVerified = (state === "active" || state === "geo_unknown");

      verifiedPlan.push({
        ...item,
        state: isVerified ? "active" : "failed",
        listenerOk: true,
        internetOk: true,
        geoOk,
        verified: isVerified,
        realGeo: {
          ip: probeResult.ip,
          countryCode: realCode,
          country: probeResult.country,
          region: probeResult.region,
          isp: probeResult.isp,
        },
        error: isVerified ? null : mismatchReason,
      });

      if (isVerified) {
        this.log(`[mihomo] 端口 ${port} 出口验证通过 (实际出口: ${realCode || "GLOBAL"} - ${probeResult.ip || ""})`);
      }
    }

    const activeCount = verifiedPlan.filter((p) => p.verified === true).length;
    if (activeCount === 0 && verifiedPlan.length > 0) {
      throw new EgressVerificationError(
        `所有独立通道均验证失败 (0/${verifiedPlan.length} 可用):\n${failedDetails.join("\n")}`,
        failedDetails
      );
    }

    return verifiedPlan;
  }

  /**
   * 统一回滚处理函数 (原子回滚并拒绝半状态)
   */
  async rollbackMihomoActivation(originalError, previousMeta = null) {
    this.log(`[mihomo] 激活失败，启动原子回滚流程: ${originalError.message}`, "warn");
    await this.setActivationState("rolling_back", { failure: originalError.message });

    try {
      // 1. 停止当前 candidate
      await this.manager.stop();

      const activePath = path.join(this.compiledDir, "active.yaml");
      const activeMetaPath = path.join(this.compiledDir, "active.meta.json");
      const prevPath = path.join(this.compiledDir, "previous.yaml");
      const prevMetaPath = path.join(this.compiledDir, "previous.meta.json");

      let metaToRestore = previousMeta;
      if (!metaToRestore && fsSync.existsSync(prevMetaPath)) {
        try {
          metaToRestore = JSON.parse(await fs.readFile(prevMetaPath, "utf8"));
        } catch {}
      }

      if (fsSync.existsSync(prevPath) && metaToRestore) {
        this.log(`[mihomo] 正在恢复上一稳定版本配置 (${metaToRestore.generationId || "previous"})...`);
        await fs.copyFile(prevPath, activePath);
        await fs.copyFile(prevMetaPath, activeMetaPath);

        // 重新拉起稳定配置
        await this.manager.start({
          configPath: activePath,
          controllerPort: metaToRestore.controllerPort || 19090,
          secret: metaToRestore.controllerSecret || "",
          expectedPorts: metaToRestore.expectedPorts || [],
        });

        // 恢复 runtime 计划与 active 状态
        if (this.runtimeRef) {
          this.runtimeRef.egressPlan = metaToRestore.egressPlan || [];
        }
        await this.setActivationState("active", {
          generationId: metaToRestore.generationId,
          configHash: metaToRestore.configHash,
          expectedPorts: metaToRestore.expectedPorts,
          verifiedAt: metaToRestore.verifiedAt,
        });

        this.log(`[mihomo] ✓ 上一稳定版本配置已成功回滚并恢复运行`);
      } else {
        // 无可用 previous，恢复为 failed
        if (this.runtimeRef) {
          this.runtimeRef.egressPlan = [];
        }
        await this.setActivationState("failed", { failure: originalError.message });
        this.log(`[mihomo] 没有可恢复的旧版本配置，已重置为未激活状态`, "warn");
      }
    } catch (rollbackErr) {
      this.log(`[mihomo] ⚠️ 回滚过程发生二次异常: ${rollbackErr.message}`, "error");
      await this.setActivationState("degraded", {
        degradedReason: `Activation failed (${originalError.message}) and Rollback also failed (${rollbackErr.message})`,
      });
      throw new MihomoActivationRollbackError(
        `激活失败: ${originalError.message}\n且回滚恢复亦失败: ${rollbackErr.message}`,
        originalError,
        rollbackErr
      );
    }
  }

  /**
   * V0.4.1 完整真事务激活（支持 Partial 部分成功）
   */
  async activateTransaction({ sourceText, egressPlan, selectedNodes = [], relayNodeName = "", controllerPort = 19090 }) {
    await fs.mkdir(this.compiledDir, { recursive: true });

    const candidatePath = path.join(this.compiledDir, "candidate.yaml");
    const candidateMetaPath = path.join(this.compiledDir, "candidate.meta.json");
    const activePath = path.join(this.compiledDir, "active.yaml");
    const activeMetaPath = path.join(this.compiledDir, "active.meta.json");
    const previousPath = path.join(this.compiledDir, "previous.yaml");
    const previousMetaPath = path.join(this.compiledDir, "previous.meta.json");

    const generationId = `gen_${crypto.randomBytes(6).toString("hex")}`;
    const secret = `sec_${crypto.randomBytes(8).toString("hex")}`;

    // 记录本次激活尝试诊断
    const attemptRecord = {
      at: new Date().toISOString(),
      generationId,
      requestedCount: egressPlan.length,
      egressPlan: [],
      errors: [],
    };

    // 1. PREPARE
    await this.setActivationState("preparing", { generationId });
    this.log(`[mihomo] 编译 Candidate 配置 (Generation: ${generationId})...`);

    const { compiledText, configHash, expectedPorts } = compileMihomoConfig({
      sourceText,
      egressPlan,
      controllerPort,
      secret,
      singaporeRelayName: relayNodeName,
    });

    const candidateMeta = {
      schemaVersion: 1,
      generationId,
      configHash,
      controllerPort,
      controllerSecret: secret,
      expectedPorts,
      egressPlan,
      selectedNodes,
      relayNodeName,
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(candidatePath, compiledText, "utf8");
    await fs.writeFile(candidateMetaPath, JSON.stringify(candidateMeta, null, 2), "utf8");

    // 2. PRE-FLIGHT (mihomo -t)
    await this.setActivationState("preflight", { generationId });
    this.log(`[mihomo] 执行配置语法严格预检 (mihomo -t)...`);
    const testRes = await this.manager.testConfig(candidatePath);
    if (!testRes.ok) {
      const err = new Error(`Mihomo 配置预检未通过:\n${testRes.error}`);
      attemptRecord.errors.push(err.message);
      if (this.runtimeRef) this.runtimeRef.lastActivationAttempt = attemptRecord;
      await this.rollbackMihomoActivation(err, null);
      throw err;
    }
    this.log(`[mihomo] ✓ 语法预检通过`);

    // 3. 读取当前 Active 信息作为回滚备用
    let currentActiveMeta = null;
    if (fsSync.existsSync(activeMetaPath)) {
      try {
        currentActiveMeta = JSON.parse(await fs.readFile(activeMetaPath, "utf8"));
      } catch {}
    }

    // 4. 停止当前实例并 START CANDIDATE
    await this.setActivationState("starting", { generationId });
    this.log(`[mihomo] 启动 Candidate 进程...`);
    try {
      await this.manager.start({
        configPath: candidatePath,
        controllerPort,
        secret,
        expectedPorts,
        skipPreflight: true,
      });
    } catch (startErr) {
      attemptRecord.errors.push(startErr.message);
      if (this.runtimeRef) this.runtimeRef.lastActivationAttempt = attemptRecord;
      await this.rollbackMihomoActivation(startErr, currentActiveMeta);
      throw startErr;
    }

    // 5. VERIFY ALL EGRESS
    await this.setActivationState("verifying", { generationId });
    this.log(`[mihomo] 开始物理核验全部 ${expectedPorts.length} 个独立出口通道...`);
    let verifiedPlan = [];
    try {
      verifiedPlan = await this.verifyEgressPlan(egressPlan);
    } catch (verifyErr) {
      attemptRecord.errors.push(verifyErr.message);
      attemptRecord.egressPlan = verifiedPlan;
      if (this.runtimeRef) this.runtimeRef.lastActivationAttempt = attemptRecord;
      await this.rollbackMihomoActivation(verifyErr, currentActiveMeta);
      throw verifyErr;
    }

    const activeCount = verifiedPlan.filter((p) => p.verified === true).length;
    const failedCount = verifiedPlan.filter((p) => p.verified !== true).length;
    const finalState = failedCount > 0 ? "partial" : "active";

    attemptRecord.egressPlan = verifiedPlan;
    if (this.runtimeRef) this.runtimeRef.lastActivationAttempt = attemptRecord;

    // 6. PROMOTE (至少 1 个通道成功，正式 Promote Candidate)
    this.log(`[mihomo] 出口验证完成 (${activeCount} 成功, ${failedCount} 失败)，正在 Promote Candidate 为 ${finalState}...`);
    try {
      // 备份原 active 到 previous
      if (fsSync.existsSync(activePath)) {
        await fs.copyFile(activePath, previousPath);
      }
      if (fsSync.existsSync(activeMetaPath)) {
        await fs.copyFile(activeMetaPath, previousMetaPath);
      }

      // Candidate 晋升为 Active
      await fs.copyFile(candidatePath, activePath);
      candidateMeta.verifiedAt = new Date().toISOString();
      candidateMeta.egressPlan = verifiedPlan;
      candidateMeta.state = finalState;
      await fs.writeFile(activeMetaPath, JSON.stringify(candidateMeta, null, 2), "utf8");

      // 切换 manager 激活路径指向 active.yaml
      this.manager.activeConfigPath = activePath;

      if (this.runtimeRef) {
        this.runtimeRef.egressPlan = verifiedPlan;
      }

      await this.setActivationState(finalState, {
        generationId,
        configHash,
        expectedPorts,
        verifiedAt: candidateMeta.verifiedAt,
      });

      this.log(`[mihomo] ✓ Generation ${generationId} 已成功 Promote (状态: ${finalState})`);

      return {
        ok: true,
        state: finalState,
        generationId,
        egressPlan: verifiedPlan,
        summary: {
          requested: egressPlan.length,
          active: activeCount,
          failed: failedCount,
        },
        expectedPorts,
        configHash,
      };
    } catch (promoteErr) {
      await this.rollbackMihomoActivation(promoteErr, currentActiveMeta);
      throw promoteErr;
    }
  }

  /**
   * 恢复未完成的中断事务 (启动时调用)
   */
  async recoverInterruptedMihomoActivation() {
    const netSettings = this.runtimeSettingsRef?.networkSettings || {};
    const state = netSettings.activation?.state;

    const transitionalStates = ["preparing", "preflight", "starting", "verifying", "rolling_back"];
    if (transitionalStates.includes(state)) {
      this.log(`[mihomo] 检测到上次进程在过渡态 [${state}] 中断，执行中断事务安全清理...`, "warn");

      const activePath = path.join(this.compiledDir, "active.yaml");
      const activeMetaPath = path.join(this.compiledDir, "active.meta.json");

      if (fsSync.existsSync(activePath) && fsSync.existsSync(activeMetaPath)) {
        try {
          const meta = JSON.parse(await fs.readFile(activeMetaPath, "utf8"));
          await this.setActivationState("active", {
            generationId: meta.generationId,
            configHash: meta.configHash,
            expectedPorts: meta.expectedPorts,
            verifiedAt: meta.verifiedAt,
          });
          this.log(`[mihomo] 已重置回未损坏的 Active 配置 (${meta.generationId})`);
        } catch {
          await this.setActivationState("inactive");
        }
      } else {
        await this.setActivationState("inactive");
      }
    }
  }

  /**
   * 重启后自动恢复 Embedded Mihomo 稳定运行
   */
  async recoverEmbeddedMihomo() {
    const netSettings = this.runtimeSettingsRef?.networkSettings || {};
    if (netSettings.mode !== "isolated" || netSettings.activation?.state !== "active") {
      return { ok: true, skipped: true };
    }

    const activePath = path.join(this.compiledDir, "active.yaml");
    const activeMetaPath = path.join(this.compiledDir, "active.meta.json");

    if (!fsSync.existsSync(activePath) || !fsSync.existsSync(activeMetaPath)) {
      this.log(`[mihomo] Active 配置文件丢失，标记为降级状态`, "warn");
      await this.setActivationState("degraded", { degradedReason: "Active config file missing on disk" });
      return { ok: false, error: "Active config file missing" };
    }

    try {
      const meta = JSON.parse(await fs.readFile(activeMetaPath, "utf8"));
      this.log(`[mihomo] 正在从 Active 配置 (${meta.generationId}) 恢复独立内核...`);

      // 1. 预检
      const testRes = await this.manager.testConfig(activePath);
      if (!testRes.ok) {
        throw new Error(`Active 配置预检未通过: ${testRes.error}`);
      }

      // 2. 启动
      await this.manager.start({
        configPath: activePath,
        controllerPort: meta.controllerPort || 19090,
        secret: meta.controllerSecret || "",
        expectedPorts: meta.expectedPorts || [],
        skipPreflight: true,
      });

      if (this.runtimeRef) {
        this.runtimeRef.egressPlan = meta.egressPlan || [];
      }

      this.log(`[mihomo] ✓ 已成功从磁盘恢复独立内核及多通道监听`);
      return { ok: true, recovered: true };
    } catch (err) {
      this.log(`[mihomo] 恢复运行失败: ${err.message}`, "error");
      await this.setActivationState("degraded", { degradedReason: `Failed to recover: ${err.message}` });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 进程意外退出时的安全处理与有限重试
   */
  async handleUnexpectedExit(event) {
    this.log(`[mihomo] 警告：Mihomo 内核意外崩溃退出 (PID: ${event.pid}, Code: ${event.code})`, "warn");

    // 立即降级并禁用出口
    await this.setActivationState("degraded", {
      degradedReason: `Mihomo process crashed (exit code ${event.code})`,
    });

    if (this.runtimeRef?.egressPlan) {
      for (const item of this.runtimeRef.egressPlan) {
        item.verified = false;
      }
    }

    // 有限自动恢复重试 (最多3次: 1s, 2s, 4s)
    if (this.crashRecoveryCount < 3) {
      this.crashRecoveryCount++;
      const delayMs = Math.pow(2, this.crashRecoveryCount - 1) * 1000;
      this.log(`[mihomo] 将在 ${delayMs / 1000} 秒后尝试第 ${this.crashRecoveryCount}/3 次自动恢复...`);

      clearTimeout(this.crashRecoveryTimer);
      this.crashRecoveryTimer = setTimeout(async () => {
        try {
          const res = await this.recoverEmbeddedMihomo();
          if (res.ok) {
            this.log(`[mihomo] ✓ 自动恢复成功！`);
            this.crashRecoveryCount = 0;
          }
        } catch {}
      }, delayMs);
    } else {
      this.log(`[mihomo] 达到最大崩溃重试次数 (3次)，保持 degraded 状态，请手动检查或重新激活`, "error");
    }
  }
}
