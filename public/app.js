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
  $("#switchModel").disabled = busy.has("switch-model") || !dashboard?.models?.length;
  $("#restoreCodex").disabled = busy.size > 0 || !dashboard?.codex?.restoreAvailable;
  $("#createDiagnostics").disabled = busy.has("diagnostics");
}

function timeText(value) {
  if (!value) return "尚未刷新";
  const normalized = typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function renderHistory(history) {
  const summary = $("#historySummary");
  const target = $("#historyList");
  if (!history?.available) {
    summary.textContent = history?.reason || "当前 Codex Home 没有 state_5.sqlite";
    target.innerHTML = '<div class="empty-state"><span>04</span><h3>没有可读取的历史索引</h3><p>历史文件不会被创建、移动或删除。</p></div>';
    return;
  }
  const providers = (history.providers || []).map((item) => `${item.provider} ${item.count}`).join(" / ");
  summary.textContent = `共 ${history.total} 个历史会话 · ${providers}`;
  target.innerHTML = (history.tasks || []).map((task) => `<article class="history-card ${task.readOnly ? "readonly" : "local"}">
    <div class="history-title"><strong>${escapeHtml(task.title)}</strong><span>${task.readOnly ? "只读" : "可继续"}</span></div>
    <div class="history-tags"><code>${escapeHtml(task.provider)}</code><code>${escapeHtml(task.model)}</code>${task.archived ? "<em>已归档</em>" : ""}</div>
    <p>${escapeHtml(task.policy)}</p>
    <time>${escapeHtml(timeText(task.updatedAt))}</time>
  </article>`).join("");
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
  return `<div class="quota-rings">${rows.map((model) => {
    const percent = Math.round(model.remainingFraction * 100);
    const strokeDash = `${percent}, 100`;
    const toneClass = percent <= 20 ? "low" : percent <= 50 ? "medium" : "good";
    return `<div class="quota-ring-item" title="${escapeHtml(model.displayName || model.id)} · 重置时间：${escapeHtml(timeText(model.resetTime))}">
      <svg class="ring-svg" viewBox="0 0 36 36">
        <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
        <path class="ring-fill ${toneClass}" stroke-dasharray="${strokeDash}" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
      </svg>
      <div class="ring-details">
        <strong class="ring-percent">${percent}%</strong>
        <span class="ring-label">${escapeHtml(model.displayName || model.id)}</span>
      </div>
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
    const proxyBadge = account.assignedProxy
      ? `<span class="proxy-badge" title="该账号请求已锁定至专属节点">🔒 ${escapeHtml(account.assignedProxy.name)}</span>`
      : `<span class="proxy-badge" style="opacity: 0.6;" title="跟随系统默认规则">🌐 默认网络</span>`;
    return `<article class="account-card">
      <div class="account-main">
        <div class="account-header-row">
          <div class="account-id">
            <span class="avatar">${escapeHtml(initial)}</span>
            <div><strong>${escapeHtml(account.email || account.name)}</strong></div>
            <div class="health-line" style="margin: 0 0 0 6px;"><span class="health-dot ${health.tone}"></span><b>${escapeHtml(health.label)}</b></div>
            <div style="margin-left: 8px;">${proxyBadge}</div>
          </div>
          <div class="account-actions">
            <button class="button ghost" style="padding: 4px 8px; font-size: 11px;" data-account-toggle="${escapeHtml(account.name)}" data-disabled="${account.disabled}">${account.disabled ? "启用" : "停用"}</button>
            <button class="button danger" style="padding: 4px 8px; font-size: 11px;" data-account-delete="${escapeHtml(account.name)}">删除</button>
          </div>
        </div>
        <div>
          ${quotaHtml(account)}
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
    ? models.map((model) => `<span class="${model.id === chosen ? "selected" : ""}" data-model-id="${escapeHtml(model.id)}" title="点击切换为此模型">${escapeHtml(model.displayName || model.id)}</span>`).join("")
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
  $("#metricProfileSub").textContent = data.codex.active ? (data.codex.selectedModel || "Antigravity") : "尚未应用";
  $("#coreStatus").textContent = online ? "服务运行中" : proxy.installed ? "核心已安装" : "等待安装核心";
  $("#corePill").textContent = online ? "ONLINE" : proxy.install.running ? "INSTALLING" : "OFFLINE";
  $("#corePill").classList.toggle("online", online);
  $("#coreIcon").classList.toggle("online", online);
  $("#toggleCore").textContent = online ? "停止服务" : "启动服务";
  $("#endpointValue").textContent = proxy.endpoint;
  $("#launchEndpoint").textContent = proxy.endpoint.replace(/^https?:\/\//, "");
  $("#binaryPath").textContent = `核心路径：${proxy.binaryPath || "尚未配置"}${proxy.install.message ? ` · ${proxy.install.message}` : ""}`;
  $("#profilePath").textContent = data.codex.configPath;
  $("#launchCodex").querySelector("span").textContent = "一键启动 Codex";
  $("#restoreCodex").textContent = "恢复原 Codex 配置";
  $("#dataPath").textContent = `运行数据：${data.paths.dataDir}`;
  renderAccounts(data.accounts);
  renderModels(data.models, data.settings.defaultModel);
  renderHistory(data.history);
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

async function loadProxyNodes() {
  try {
    const nodes = await api("/api/proxies/nodes");
    if (Array.isArray(nodes) && nodes.length > 0) {
      const select = $("#proxyNodeSelect");
      if (select) {
        select.innerHTML = nodes.map((node, idx) => {
          const isDefault = idx === 0;
          const label = node.display || `${node.country || "🌐"} ${node.name}`;
          return `<option value="${node.port}" data-name="${escapeHtml(node.name)}" ${isDefault ? "selected" : ""}>${escapeHtml(label)}</option>`;
        }).join("");
        updateModalNodeTip();
      }
    }
  } catch {}
}

function updateModalNodeTip() {
  const select = $("#proxyNodeSelect");
  const title = $("#selectedNodeTitle");
  if (select && title) {
    const opt = select.selectedOptions?.[0];
    if (opt) {
      title.textContent = opt.dataset.name || opt.textContent;
    }
  }
}

$("#proxyNodeSelect")?.addEventListener("change", updateModalNodeTip);

$("#closeOauthModal")?.addEventListener("click", () => $("#oauthModal")?.close());
$("#cancelOauth")?.addEventListener("click", () => $("#oauthModal")?.close());

$("#addAccount").addEventListener("click", async () => {
  await loadProxyNodes();
  const modal = $("#oauthModal");
  if (modal && typeof modal.showModal === "function") {
    modal.showModal();
  } else {
    // 降级传统启动
    startOAuthDirectly();
  }
});

$("#confirmOauth")?.addEventListener("click", async () => {
  const select = $("#proxyNodeSelect");
  const opt = select?.selectedOptions?.[0];
  const proxyPort = Number(select?.value) || 0;
  const proxyName = opt?.dataset.name || "默认网络";

  $("#oauthModal")?.close();
  showToast(`正在调起专属安全浏览器 (节点: ${proxyName})...`);

  try {
    const result = await runBusy("oauth", () => api("/api/oauth/start", {
      method: "POST",
      body: JSON.stringify({ proxyPort, proxyName, launchBrowser: true }),
    }));
    showToast("安全隔离浏览器已调起，请确认出口 IP 后登录", false);
    await pollOAuth(result.state);
  } catch (error) {
    showToast(error.message, true);
  }
});

async function startOAuthDirectly() {
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
}

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

$("#modelChips").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-model-id]");
  if (chip) {
    const model = chip.dataset.modelId;
    $("#modelSelect").value = model;
    renderModels(dashboard?.models || [], model);
    runBusy("switch-model", () => api("/api/codex/model", {
      method: "POST",
      body: JSON.stringify({ model }),
    }), `已切换当前 Codex 模型为 ${model}`).catch(() => {});
  }
});

$("#switchModel").addEventListener("click", () => {
  const model = $("#modelSelect").value;
  if (!model) return;
  runBusy("switch-model", () => api("/api/codex/model", {
    method: "POST",
    body: JSON.stringify({ model }),
  }), `已切换当前 Codex 模型为 ${model}`).catch(() => {});
});

$("#launchCodex").addEventListener("click", () => runBusy("launch", async () => {
  const result = await api("/api/codex/launch", {
    method: "POST",
    body: JSON.stringify({ model: $("#modelSelect").value }),
  });
  showToast("正在退出 Codex、应用配置并启动 API Service 桌面端");
  return result;
}).catch(() => {}));

$("#restoreCodex").addEventListener("click", () => {
  if (!window.confirm("恢复接管前的 config.toml？请先完全退出 Codex。")) return;
  runBusy("restore", () => api("/api/codex/restore", { method: "POST", body: "{}" }), "原 Codex 配置已恢复").catch(() => {});
});

$("#createDiagnostics").addEventListener("click", () => runBusy("diagnostics", async () => {
  const result = await api("/api/diagnostics", { method: "POST", body: "{}" });
  $("#diagnosticsPath").textContent = result.archivePath;
  showToast("脱敏诊断包已生成");
  return result;
}).catch(() => {}));

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

// Theme Toggle Management
function initTheme() {
  const saved = localStorage.getItem("ag_bridge_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved ? saved === "dark" : prefersDark;
  setTheme(isDark);
}

function setTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute("data-theme", "dark");
    const toggleBtn = $("#themeToggle");
    if (toggleBtn) toggleBtn.textContent = "☀️ 浅色";
    localStorage.setItem("ag_bridge_theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
    const toggleBtn = $("#themeToggle");
    if (toggleBtn) toggleBtn.textContent = "🌙 深色";
    localStorage.setItem("ag_bridge_theme", "light");
  }
}

const themeBtn = $("#themeToggle");
if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    setTheme(!isDark);
  });
}

initTheme();

// Network Management
let netLoaded = false;
async function loadNetworkSettings() {
  if (netLoaded) return;
  try {
    const res = await api("/api/network/settings");
    if (res && res.networkSettings) {
      const ns = res.networkSettings;
      const modeRadio = document.querySelector(`input[name="netMode"][value="${ns.mode || 'isolated'}"]`);
      if (modeRadio) modeRadio.checked = true;
      if ($("#netSubUrl")) $("#netSubUrl").value = ns.subscriptionUrl || "";
      if ($("#netCustomIsp")) $("#netCustomIsp").value = ns.customIspText || "";
      netLoaded = true;
    }
  } catch {}
}

const toggleNetBtn = $("#toggleNetPanel");
if (toggleNetBtn) {
  toggleNetBtn.addEventListener("click", () => {
    const body = $("#netPanelBody");
    if (body) {
      const isVisible = body.style.display !== "none";
      body.style.display = isVisible ? "none" : "block";
      if (!isVisible) loadNetworkSettings();
    }
  });
}

const saveNetBtn = $("#saveNetSettings");
if (saveNetBtn) {
  saveNetBtn.addEventListener("click", async () => {
    const selMode = document.querySelector('input[name="netMode"]:checked')?.value || "isolated";
    const subUrl = $("#netSubUrl")?.value || "";
    const ispText = $("#netCustomIsp")?.value || "";
    runBusy("network", async () => {
      const result = await api("/api/network/settings", {
        method: "POST",
        body: JSON.stringify({ mode: selMode, subscriptionUrl: subUrl, customIspText: ispText }),
      });
      showToast(result?.activation?.restartRequired
        ? "配置已写入；请切换配置或重启西游云以加载新端口"
        : "配置已保存，独立端口已开始监听；全链路请单独测速");
      await refresh(true);
    }).catch(() => {});
  });
}

refresh(true);
setInterval(() => refresh(false), 4000);
