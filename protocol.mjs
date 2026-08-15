export function friendlyProxyError(status, detail = "") {
  const message = String(detail || "").trim();
  if (/selected model is at capacity|model.*capacity/i.test(message)) {
    return "所选模型当前满载，请切换模型或稍后重试";
  }
  if (/quota.*exhaust|quota.*exceed|insufficient.*quota|credits?.*exhaust/i.test(message)) {
    return "当前 Google 账号额度已耗尽，请切换账号或等待额度恢复";
  }
  if (status === 401) return "本地 API 凭据无效，请重启桥接器以重新生成受保护凭据";
  if (status === 403) return "Google 授权被拒绝或已失效，请重新登录该账号";
  if (status === 429) return "请求过于频繁或上游限流，请稍后重试并查看账号额度";
  if (status >= 500) return "上游模型服务暂时不可用，请稍后重试";
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
    verification: "unverified",
  };
}
