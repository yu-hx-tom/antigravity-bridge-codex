/**
 * Antigravity Bridge Codex Telemetry Collector
 * 严格遵循真实 Usage 优先、单调时钟 TTFT、无人工 Clamp、全局加权均速模型
 */

export function extractOutputTokenUsage(payload) {
  if (!payload || typeof payload !== "object") return null;

  // 1. OpenAI / standard format: payload.usage.completion_tokens / output_tokens
  if (payload.usage && typeof payload.usage === "object") {
    const out = payload.usage.output_tokens ?? payload.usage.completion_tokens;
    if (typeof out === "number" && !isNaN(out)) return Math.max(0, Math.floor(out));
  }

  // 2. Responses API format: payload.response?.usage?.output_tokens
  if (payload.response?.usage && typeof payload.response.usage === "object") {
    const out = payload.response.usage.output_tokens ?? payload.response.usage.completion_tokens;
    if (typeof out === "number" && !isNaN(out)) return Math.max(0, Math.floor(out));
  }

  // 3. Directly in payload.output_tokens
  if (typeof payload.output_tokens === "number" && !isNaN(payload.output_tokens)) {
    return Math.max(0, Math.floor(payload.output_tokens));
  }

  return null;
}

/**
 * 字符近似估算器 (仅当上游完全未提供任何 usage 时作为兜底 fallback，必须显式标记 estimated=true)
 */
export function estimateOutputTokensFromText(text) {
  if (!text || typeof text !== "string") return 0;
  // 简单分词与字符混合启发式算法
  let cjkCount = 0;
  let nonCjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      cjkCount++;
    } else {
      nonCjkCount++;
    }
  }
  const estimated = Math.ceil(cjkCount * 1.0 + nonCjkCount / 3.8);
  return Math.max(1, estimated);
}

export class TelemetryCollector {
  constructor({ clock = null } = {}) {
    this.clock = clock || (() => performance.now());
    this.requests = new Map(); // active & recent requests by requestId
    this.completedRequestIds = new Set();

    // Canonical Session Totals
    this.totalRequests = 0;
    this.completedRequests = 0;
    this.failedRequests = 0;
    this.cancelledRequests = 0;

    this.totalOutputTokens = 0;
    this.totalGenerationSeconds = 0;
    this.totalTtftMs = 0;
    this.ttftSampleCount = 0;

    this.lastRecord = null;
    this.lastActivityAt = null;
  }

  now() {
    return this.clock();
  }

  beginRequest({ requestId, model = "", source = "user" }) {
    if (!requestId) return null;
    const req = {
      requestId,
      model,
      source,
      startedAt: this.now(),
      firstOutputAt: null,
      completedAt: null,
      outputTokens: 0,
      tokenSource: "unknown",
      estimated: false,
      status: "running",
      outputText: "",
      ttftMs: null,
      generationMs: null,
      totalDurationMs: null,
      tokensPerSec: null,
      includeInSessionAggregate: source !== "benchmark",
    };
    this.requests.set(requestId, req);
    this.totalRequests++;
    this.lastActivityAt = new Date().toISOString();
    return req;
  }

  markFirstOutput(requestId) {
    const req = this.requests.get(requestId);
    if (!req || req.firstOutputAt !== null) return;
    req.firstOutputAt = this.now();
    req.ttftMs = Math.max(0, Math.round((req.firstOutputAt - req.startedAt) * 10) / 10);
  }

  addOutputText(requestId, textChunk) {
    const req = this.requests.get(requestId);
    if (!req || !textChunk) return;
    if (req.firstOutputAt === null) {
      this.markFirstOutput(requestId);
    }
    req.outputText += String(textChunk);
  }

  setUsage(requestId, usagePayload) {
    const req = this.requests.get(requestId);
    if (!req) return;
    const extracted = extractOutputTokenUsage(usagePayload);
    if (extracted !== null) {
      req.outputTokens = extracted;
      req.tokenSource = "api-usage";
      req.estimated = false;
    }
  }

  completeRequest(requestId, { usagePayload = null, finalText = null } = {}) {
    const req = this.requests.get(requestId);
    if (!req) return null;

    // 防止重复统计同一个 requestId
    if (this.completedRequestIds.has(requestId)) {
      return req;
    }
    this.completedRequestIds.add(requestId);

    req.completedAt = this.now();
    if (req.firstOutputAt === null) {
      req.firstOutputAt = req.completedAt;
    }

    if (finalText) req.outputText = finalText;

    if (usagePayload) {
      this.setUsage(requestId, usagePayload);
    }

    // 若无真实 API usage，则执行 fallback 估算并显式标记 estimated=true
    if (req.tokenSource !== "api-usage") {
      req.outputTokens = estimateOutputTokensFromText(req.outputText);
      req.tokenSource = "tokenizer-estimate";
      req.estimated = true;
    }

    req.totalDurationMs = Math.max(0, req.completedAt - req.startedAt);
    req.generationMs = Math.max(0, req.completedAt - req.firstOutputAt);

    if (req.ttftMs === null) {
      req.ttftMs = Math.max(0, Math.round(req.totalDurationMs * 10) / 10);
    }

    const genSeconds = req.generationMs / 1000;
    const durSeconds = req.totalDurationMs / 1000;

    if (genSeconds > 0 && req.outputTokens > 0) {
      req.tokensPerSec = Math.round((req.outputTokens / genSeconds) * 10) / 10;
    } else if (durSeconds > 0 && req.outputTokens > 0) {
      req.tokensPerSec = Math.round((req.outputTokens / durSeconds) * 10) / 10;
    } else {
      req.tokensPerSec = null;
    }

    req.status = "completed";
    this.completedRequests++;
    this.lastActivityAt = new Date().toISOString();
    this.lastRecord = { ...req };

    // 会话全局聚合计算（若 includeInSessionAggregate = true）
    if (req.includeInSessionAggregate) {
      this.totalOutputTokens += req.outputTokens;
      this.totalGenerationSeconds += genSeconds;

      if (req.ttftMs !== null) {
        this.totalTtftMs += req.ttftMs;
        this.ttftSampleCount++;
      }
    }

    return req;
  }

  failRequest(requestId, error = null) {
    const req = this.requests.get(requestId);
    if (!req || this.completedRequestIds.has(requestId)) return;
    this.completedRequestIds.add(requestId);
    req.status = "failed";
    req.completedAt = this.now();
    req.error = error?.message || String(error || "Unknown error");
    this.failedRequests++;
    this.lastActivityAt = new Date().toISOString();
  }

  cancelRequest(requestId) {
    const req = this.requests.get(requestId);
    if (!req || this.completedRequestIds.has(requestId)) return;
    this.completedRequestIds.add(requestId);
    req.status = "cancelled";
    req.completedAt = this.now();
    this.cancelledRequests++;
    this.lastActivityAt = new Date().toISOString();
  }

  snapshot() {
    const weightedAvg = this.totalGenerationSeconds > 0
      ? Math.round((this.totalOutputTokens / this.totalGenerationSeconds) * 10) / 10
      : 0;

    const avgTtft = this.ttftSampleCount > 0
      ? Math.round(this.totalTtftMs / this.ttftSampleCount)
      : 0;

    return {
      totalRequests: this.totalRequests,
      completedRequests: this.completedRequests,
      failedRequests: this.failedRequests,
      cancelledRequests: this.cancelledRequests,

      totalOutputTokens: this.totalOutputTokens,
      totalGenerationSeconds: Math.round(this.totalGenerationSeconds * 100) / 100,

      avgTokensPerSec: weightedAvg,
      weightedAvgTokensPerSec: weightedAvg,
      avgTtftMs: avgTtft,

      lastTokensPerSec: this.lastRecord?.tokensPerSec ?? 0,
      lastTtftMs: this.lastRecord?.ttftMs ?? 0,
      lastOutputTokens: this.lastRecord?.outputTokens ?? 0,
      lastTokenSource: this.lastRecord?.tokenSource ?? "unknown",
      lastEstimated: this.lastRecord?.estimated ?? false,

      lastActivityAt: this.lastActivityAt,
    };
  }

  reset() {
    this.requests.clear();
    this.completedRequestIds.clear();
    this.totalRequests = 0;
    this.completedRequests = 0;
    this.failedRequests = 0;
    this.cancelledRequests = 0;
    this.totalOutputTokens = 0;
    this.totalGenerationSeconds = 0;
    this.totalTtftMs = 0;
    this.ttftSampleCount = 0;
    this.lastRecord = null;
    this.lastActivityAt = null;
  }
}

export const globalTelemetryCollector = new TelemetryCollector();
