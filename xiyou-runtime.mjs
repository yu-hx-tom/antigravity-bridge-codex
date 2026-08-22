function normalizeController(address, secret = "") {
  const value = String(address || "").trim();
  if (!value) return null;
  const normalized = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(normalized);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") url.hostname = "127.0.0.1";
    return { baseUrl: url.toString().replace(/\/$/, ""), secret: String(secret || "") };
  } catch {
    return null;
  }
}

export function parseXiyouPreferences(rawText = "") {
  try {
    const outer = JSON.parse(rawText || "{}");
    const innerValue = outer["flutter.config"] || "{}";
    const config = typeof innerValue === "string" ? JSON.parse(innerValue) : innerValue;
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const profile = profiles.find((item) => item?.id === config.currentProfileId) || profiles[0] || null;
    const patchConfig = config.patchClashConfig && typeof config.patchClashConfig === "object"
      ? config.patchClashConfig
      : {};
    return {
      ok: true,
      config,
      profile,
      currentProfileId: String(config.currentProfileId || profile?.id || ""),
      patchConfig,
      controller: normalizeController(patchConfig["external-controller"], patchConfig.secret),
      selectedMap: profile?.selectedMap && typeof profile.selectedMap === "object" ? profile.selectedMap : {},
    };
  } catch (error) {
    return { ok: false, error: error.message, config: {}, profile: null, currentProfileId: "", patchConfig: {}, controller: null, selectedMap: {} };
  }
}
