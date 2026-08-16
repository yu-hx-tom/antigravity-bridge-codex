/**
 * Protocol, Error Classification & Schema Sanitization Helpers
 *
 * Provides:
 * 1. 429 & HTTP error classification with user-friendly actionable hints and cooldown suggestions.
 * 2. Antigravity Protobuf Tool Schema Sanitization (strips unsupported JSON schema properties).
 * 3. Thought-signature sentinel constant & cache helpers.
 */

export const THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

const QUOTA_EXHAUSTED_KEYWORDS = [
  "quota_exhausted",
  "quota exhausted",
  "quota reached",
  "enable overages",
  "individual quota",
  "resource_exhausted",
  "insufficient_quota",
  "credits_exhausted",
];

export function classifyRateLimit(bodyText = "", retryAfterMs = undefined) {
  const text = String(bodyText || "").toLowerCase();
  if (QUOTA_EXHAUSTED_KEYWORDS.some((kw) => text.includes(kw))) {
    return {
      category: "quota_exhausted",
      cooldownMs: 24 * 60 * 60 * 1000,
      description: "当前账号额度已耗尽，请切换其他 Google 账号或等待次日额度刷新",
    };
  }
  if (retryAfterMs !== undefined && retryAfterMs < 3000) {
    return {
      category: "soft_rate_limit",
      cooldownMs: retryAfterMs || 1000,
      description: "并发请求瞬时峰值，系统已自动重试",
    };
  }
  if (retryAfterMs !== undefined || text.includes("rate limit") || text.includes("too many requests")) {
    const cd = retryAfterMs || 5 * 60 * 1000;
    const mins = Math.ceil(cd / 60000);
    return {
      category: "rate_limited",
      cooldownMs: cd,
      description: `模型每分钟请求超限，请等待约 ${mins} 分钟后重试或切换其他模型`,
    };
  }
  return {
    category: "unknown",
    cooldownMs: 30000,
    description: "请求过于频繁或触发上游限流，请稍后重试",
  };
}

export function friendlyProxyError(status, detail = "", retryAfterMs = undefined) {
  const message = String(detail || "").trim();
  if (/selected model is at capacity|model.*capacity/i.test(message)) {
    return "所选模型当前满载，请在管理界面切换为其他模型（推荐 Gemini 3.7 Flash High）或稍后重试";
  }
  if (status === 429) {
    const classified = classifyRateLimit(message, retryAfterMs);
    return classified.description;
  }
  if (status === 401) {
    return "本地 API Key 凭据无效，请重新点击“一键应用配置”同步";
  }
  if (status === 403) {
    if (QUOTA_EXHAUSTED_KEYWORDS.some((kw) => message.toLowerCase().includes(kw))) {
      return "当前 Google 账号额度已耗尽，请切换账号或等待额度刷新";
    }
    return "Google 账号授权已失效或无权访问内部接口，请在管理页面重新登录授权";
  }
  if (/quota.*exhaust|quota.*exceed|insufficient.*quota|credits?.*exhaust/i.test(message)) {
    return "当前 Google 账号额度已耗尽，请切换账号或等待额度恢复";
  }
  if (status >= 500) {
    return "上游 Google 服务暂时不可用，请稍后重试";
  }
  return message || `代理请求失败（HTTP ${status}）`;
}

export function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

export function modelCapabilities(modelId) {
  const id = String(modelId);
  const isGemini = /gemini/i.test(id);
  const isClaude = /claude/i.test(id);
  const isGptOss = /gpt-oss/i.test(id);
  return {
    contextWindow: isGemini ? 1_048_576 : isGptOss ? 131_072 : 200_000,
    tools: true,
    parallelTools: !/image/i.test(id),
    imageInput: isGemini || isClaude,
    reasoning: /thinking|high|pro|opus|medium|low/i.test(id),
    verification: "verified",
  };
}

/**
 * Antigravity Protobuf Tool Schema Sanitization
 *
 * Strips unsupported JSON schema properties ($schema, pattern, minLength, etc.)
 * that cause 400 Bad Request on Antigravity Cloud Code endpoints.
 */
const AGY_SCHEMA_ALLOWLIST = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "items",
  "enum",
  "default",
  "properties",
  "required",
  "additionalProperties",
]);

export function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((entry) => sanitizeToolSchema(entry));

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!AGY_SCHEMA_ALLOWLIST.has(key)) continue;

    if (key === "properties" && typeof value === "object" && value !== null) {
      const map = {};
      for (const [propName, propChild] of Object.entries(value)) {
        map[propName] = sanitizeToolSchema(propChild);
      }
      result[key] = map;
      continue;
    }

    if ((key === "items" || key === "additionalProperties") && typeof value === "object" && value !== null) {
      result[key] = sanitizeToolSchema(value);
      continue;
    }

    result[key] = value;
  }
  return result;
}
