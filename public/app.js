const bridgeKey = document.querySelector('meta[name="bridge-key"]').content;
let dashboard = null;
let settingsLoaded = false;
let busy = new Set();
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "X-Bridge-Key": bridgeKey,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function runBusy(name, task, successMessage = "") {
  if (busy.has(name)) return;
  busy.add(name);
  renderBusy();
  try {
    const result = await task();
    if (successMessage) showToast(successMessage);
    await refresh(true);
    return result;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  } finally {
    busy.delete(name);
    renderBusy();
  }
}

function renderBusy() {
  $("#launchCodex").disabled = busy.size > 0;
  $("#installCore").disabled = busy.has("install") || dashboard?.proxy?.install?.running;
  $("#toggleCore").disabled = busy.has("core");
  $("#addAccount").disabled = busy.has("oauth");
  $("#refreshQuota").disabled = busy.has("quota") || dashboard?.quotaRefreshing;
  $("#prepareProfile").disabled = busy.has("prepare");
  $("#restoreCodex").disabled = busy.size > 0 || !dashboard?.codex?.restoreAvailable;
}

function timeText(value) {
  if (!value) return "尚未刷新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function accountHealth(account) {
  if (account.disabled) return { label: "已停用", tone: "warn" };
  if (account.unavailable || ["error", "unavailable"].includes(account.status)) return { label: account.statusMessage || "暂不可用", tone: "bad" };
  if (account.status === "ready") return { label: "代理就绪", tone: "" };
  return { label: account.statusMessage || account.status || "状态未知", tone: "warn" };
}

function quotaHtml(account) {
  const quota = account.quota;
  if (!quota) return '<div class="health-line"><span class="health-dot warn"></span><span>尚未读取上游额度</span></div>';
  if (quota.status !== "reported") {
    return `<div class="health-line"><span class="health-dot ${quota.status === "reauth" ? "bad" : "warn"}"></span><span>${escapeHtml(quota.message || "额度读取失败")}</span></div>`;
  }
  const rows = (quota.models || []).filter((model) => model.remainingFraction !== null).slice(0, 6);
  if (!rows.length) return '<div class="health-line"><span class="health-dot warn"></span><span>上游未返回可解析的额度字段</span></div>';
  return `<div class="quota-bars">${rows.map((model) => {
    const percent = Math.round(model.remainingFraction * 100);
    return `<div class="quota-row" title="重置：${escapeHtml(timeText(model.resetTime))}">
      <span>${escapeHtml(model.displayName || model.id)}</span>
      <span class="bar"><i class="${percent <= 20 ? "low" : ""}" style="width:${percent}%"></i></span>
      <b>${percent}%</b>
    </div>`;
  }).join("")}</div>`;
}

function renderAccounts(accounts) {
  const target = $("#accountList");
  if (!accounts.length) {
    target.innerHTML = '<div class="empty-state"><span>02</span><h3>还没有账号</h3><p>启动核心后，点击“登录 Google 账号”完成本地 OAuth。</p></div>';
    return;
  }
  target.innerHTML = accounts.map((account) => {
    const health = accountHealth(account);
    const initial = (account.email || account.name || "A").slice(0, 1).toUpperCase();
    return `<article class="account-card">
      <div class="account-main">
        <div class="account-id">
          <span class="avatar">${escapeHtml(initial)}</span>
          <div><strong>${escapeHtml(account.email || account.name)}</strong><span>${escapeHtml(account.label || account.name)}</span></div>
        </div>
        <div>
          <div class="health-line"><span class="health-dot ${health.tone}"></span><b>${escapeHtml(health.label)}</b><span>成功 ${account.success} / 失败 ${account.failed}</span></div>
          ${quotaHtml(account)}
        </div>
        <div class="account-actions">
          <button class="button ghost" data-account-toggle="${escapeHtml(account.name)}" data-disabled="${account.disabled}">${account.disabled ? "启用" : "停用"}</button>
          <button class="button danger" data-account-delete="${escapeHtml(account.name)}">删除</button>
        </div>
      </div>
      <div class="quota-meta"><span>额度更新：${escapeHtml(timeText(account.quota?.fetchedAt))}</span><span>令牌刷新：${escapeHtml(timeText(account.lastRefresh))}</span></div>
    </article>`;
  }).join("");
}

function renderModels(models, selected) {
  const select = $("#modelSelect");
  const current = select.value || selected;
  const signature = models.map((model) => model.id).join("|");
  if (select.dataset.signature !== signature) {
    select.innerHTML = models.length
      ? models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName || model.id)}</option>`).join("")
      : '<option value="">等待服务启动</option>';
    select.dataset.signature = signature;
  }
  if (models.some((model) => model.id === current)) select.value = current;
  else if (selected && models.some((model) => model.id === selected)) select.value = selected;
  const chosen = select.value;
  $("#modelChips").innerHTML = models.length
    ? models.map((model) => `<span class="${model.id === chosen ? "selected" : ""}">${escapeHtml(model.id)}</span>`).join("")
    : "<span>尚无模型</span>";
  $("#modelCount").textContent = String(models.length);
  $("#launchModel").textContent = chosen || "等待模型同步";
}

function renderLogs(logs) {
  $("#logWindow").innerHTML = logs.length ? logs.slice().reverse().map((log) => {
    const time = new Date(log.time).toLocaleTimeString("zh-CN", { hour12: false });
    return `<p class="${escapeHtml(log.level)}"><time>${escapeHtml(time)}</time><span>${escapeHtml(log.scope.toUpperCase())}</span>${escapeHtml(log.message)}</p>`;
  }).join("") : "<p><time>--:--:--</time><span>APP</span> 等待运行事件</p>";
}

function loadSettings(data) {
  if (settingsLoaded) return;
  $("#proxyPort").value = data.settings.proxyPort;
  $("#quotaInterval").value = data.settings.quotaIntervalMinutes;
  $("#proxyBinary").value = data.settings.proxyBinary || "";
  $("#codexAppPath").value = data.settings.codexAppPath || "";
  $("#codexHome").value = data.settings.codexHome || "";
  settingsLoaded = true;
}

function render(data) {
  dashboard = data;
  const proxy = data.proxy;
  const online = proxy.running;
  $("#topSignal").classList.toggle("online", online);
  $("#topStatus").textContent = online ? `代理在线 · ${data.accounts.length} 个账号` : "代理离线 · 本地配置未接管";
  $("#metricCore").textContent = online ? "ON" : proxy.installed ? "READY" : "MISSING";
  $("#metricCoreSub").textContent = online ? (proxy.managed ? "本工具托管" : "检测到外部服务") : "CLIProxyAPI";
  $("#metricAccounts").textContent = String(data.accounts.length);
  $("#metricModels").textContent = String(data.models.length);
  $("#metricProfile").textContent = data.codex.active ? "ACTIVE" : "SAFE";
  $("#metricProfileSub").textContent = data.codex.active ? "等待完全退出并重启 Codex" : "尚未应用";
  $("#coreStatus").textContent = online ? "服务运行中" : proxy.installed ? "核心已安装" : "等待安装核心";
  $("#corePill").textContent = online ? "ONLINE" : proxy.install.running ? "INSTALLING" : "OFFLINE";
  $("#corePill").classList.toggle("online", online);
  $("#coreIcon").classList.toggle("online", online);
  $("#toggleCore").textContent = online ? "停止服务" : "启动服务";
  $("#endpointValue").textContent = proxy.endpoint;
  $("#launchEndpoint").textContent = proxy.endpoint.replace(/^https?:\/\//, "");
  $("#binaryPath").textContent = `核心路径：${proxy.binaryPath || "尚未配置"}${proxy.install.message ? ` · ${proxy.install.message}` : ""}`;
  $("#profilePath").textContent = data.codex.configPath;
  $("#launchCodex").querySelector("span").textContent = "应用 API Service 配置";
  $("#prepareProfile").textContent = "仅准备 API Service";
  $("#restoreCodex").textContent = "恢复原 Codex 配置";
  $("#dataPath").textContent = `运行数据：${data.paths.dataDir}`;
  renderAccounts(data.accounts);
  renderModels(data.models, data.settings.defaultModel);
  renderLogs(data.logs);
  loadSettings(data);
  renderBusy();
}

async function refresh(loud = false) {
  try {
    render(await api("/api/dashboard"));
  } catch (error) {
    if (loud) showToast(error.message, true);
  }
}

async function pollOAuth(state, popup) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await api(`/api/oauth/status?state=${encodeURIComponent(state)}`);
    if (result.status === "ok") {
      if (popup && !popup.closed) popup.close();
      showToast("Google OAuth 登录完成，正在同步账号");
      await refresh(true);
      runBusy("quota", () => api("/api/quota/refresh", { method: "POST", body: "{}" })).catch(() => {});
      return;
    }
    if (result.status === "error") throw new Error(result.error || "OAuth 登录失败");
  }
  throw new Error("OAuth 登录等待超时，请重新发起登录");
}

$("#toggleCore").addEventListener("click", () => runBusy("core", async () => {
  const path = dashboard?.proxy?.running ? "/api/proxy/stop" : "/api/proxy/start";
  return api(path, { method: "POST", body: "{}" });
}, dashboard?.proxy?.running ? "代理服务已停止" : "代理服务已启动").catch(() => {}));

$("#installCore").addEventListener("click", () => runBusy("install", () => api("/api/proxy/install", { method: "POST", body: "{}" }), "CLIProxyAPI 核心安装完成").catch(() => {}));

$("#addAccount").addEventListener("click", async () => {
  const popup = window.open("about:blank", "antigravity-oauth");
  if (popup) popup.document.write("<p style='font-family:sans-serif;padding:24px'>正在准备 Google OAuth...</p>");
  try {
    const result = await runBusy("oauth", () => api("/api/oauth/start", { method: "POST", body: "{}" }));
    if (popup) popup.location.href = result.url;
    else window.location.href = result.url;
    await pollOAuth(result.state, popup);
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    showToast(error.message, true);
  }
});

$("#refreshQuota").addEventListener("click", () => runBusy("quota", () => api("/api/quota/refresh", { method: "POST", body: "{}" }), "上游报告额度已刷新").catch(() => {}));

$("#accountList").addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-account-toggle]");
  const remove = event.target.closest("[data-account-delete]");
  if (toggle) {
    const name = toggle.dataset.accountToggle;
    const disabled = toggle.dataset.disabled !== "true";
    runBusy(`account-${name}`, () => api("/api/accounts/status", { method: "PATCH", body: JSON.stringify({ name, disabled }) }), disabled ? "账号已停用" : "账号已启用").catch(() => {});
  }
  if (remove) {
    const name = remove.dataset.accountDelete;
    if (!window.confirm(`删除本地账号凭据“${name}”？这不会撤销 Google 侧授权。`)) return;
    runBusy(`delete-${name}`, () => api("/api/accounts", { method: "DELETE", body: JSON.stringify({ name }) }), "本地账号凭据已删除").catch(() => {});
  }
});

$("#modelSelect").addEventListener("change", () => renderModels(dashboard?.models || [], $("#modelSelect").value));

$("#prepareProfile").addEventListener("click", () => runBusy("prepare", () => api("/api/codex/prepare", {
  method: "POST",
  body: JSON.stringify({ model: $("#modelSelect").value }),
}), "Codex antigravity Profile 已生成").catch(() => {}));

$("#launchCodex").addEventListener("click", () => runBusy("launch", async () => {
  const result = await api("/api/codex/launch", {
    method: "POST",
    body: JSON.stringify({ model: $("#modelSelect").value }),
  });
  showToast("配置与 API Key 已备份并应用。请完全退出 Codex，再双击“启动 Codex API Service.bat”");
  return result;
}).catch(() => {}));

$("#restoreCodex").addEventListener("click", () => {
  if (!window.confirm("恢复接管前的 config.toml 和 auth.json？请先完全退出 Codex。")) return;
  runBusy("restore", () => api("/api/codex/restore", { method: "POST", body: "{}" }), "原 Codex 配置与登录凭据已恢复").catch(() => {});
});

$("#settingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {
    proxyPort: Number($("#proxyPort").value),
    quotaIntervalMinutes: Number($("#quotaInterval").value),
    proxyBinary: $("#proxyBinary").value,
    codexAppPath: $("#codexAppPath").value,
    codexHome: $("#codexHome").value,
  };
  runBusy("settings", () => api("/api/settings", { method: "PUT", body: JSON.stringify(body) }), "设置已保存").catch(() => {});
});

refresh(true);
setInterval(() => refresh(false), 4000);
