# Antigravity Bridge Codex (ABC)

**Antigravity Bridge Codex (简称 ABC)** 是一个专为 Windows 环境打造的高性能、企业级透明桥接与桌面控制台系统。它无缝打通 **Google Antigravity (Google Cloud Code Assist)** 内部多模型生态与 **OpenAI Codex Desktop / ChatGPT Desktop**，提供 Responses API 级协议兼容、事务级配置接管与安全回滚、双周期额度精准监控（5小时突发 + 周度全局）以及首字延迟（TTFT）与 Token/s 实时性能遥测。

---

## 🌟 核心特性与架构亮点

1. **Windows 原生高清桌面控制台 (Native Cockpit GUI)**：
   - 基于 C# .NET Framework 4.8 + WPF 纯代码构建（零第三方 XAML/NuGet 运行时依赖）。
   - 完美适配 `PerMonitorV2` 4K/高分屏 DPI 无损缩放与 ClearType 亚像素文字抗锯齿。
   - 系统级单实例互斥锁（`SingleInstance_Mutex`），重复双击自动唤醒并激活前台窗口，避免多开托盘。
   - 原生托盘常驻，支持最小化到托盘、右键快捷菜单、一键退出。

2. **Antigravity 官方 `quota_summary` 双周期配额桶引擎**：
   - 深度联动 Google Cloud 内部配额机制与 Antigravity 本地数据快照；
   - 独立解耦计算 **5小时滑动突发限额（如 95%）** 与 **周度全局限额（如 74%）**；
   - 智能跨天/跨小时倒计时显示（如 `14:04 (4小时50分后刷新)`、`8月21日 (5天后刷新)`）；
   - 支持多账号与单账号自由切换，自动侦测 Google OAuth 401/403 失效并提供一键重登与物理移除。

3. **实时任务性能与测速监控 (Telemetry & Analytics)**：
   - 全程拦截并实时统计请求的首字延迟（**TTFT - Time to First Token**）与流式生成吞吐速率（**Tokens/s**）。
   - 任务级会话追踪，直观掌握耗时、Token 消耗与模型响应质量。

4. **Codex Desktop 事务级无感接管与绝对安全回滚**：
   - 自动检测并安全接管 Codex Desktop 的 `config.toml` 与 `auth.json`；
   - 采用多文件快照与 SHA-256 校验和机制，确保退出或异常中断时 100% 自动恢复用户原生配置；
   - 工具调用（Tool Calling / Functions）Protobuf 关键字清洗，抹平 Gemini 与 OpenAI Codex 协议差异。

5. **西游云多出口与账号固定出口**：
   - 每个已选节点生成一个仅监听 `127.0.0.1` 的 Mihomo `mixed` Listener（从 `7892` 起连续分配），Listener 的 `proxy` 字段固定到唯一节点，不使用负载均衡；
   - 自定义美国住宅 ISP 自动生成代理项，并通过 `dialer-proxy` 绑定到真实的新加坡 IEPL/IPLC/专线节点，形成“国内 → 新加坡专线 → 美国住宅落地”；
   - OAuth 账号保存独立的 `proxy_url`，专属端口未监听时禁止回退到默认端口，避免账号出口串线；
   - 只有已绑定独立 Listener 的节点才显示“通道全链路”实测值；未激活节点明确显示暂无数据，不再把国内 BGP 入口的 2–4ms 冒充节点延迟；
   - 官网登录会自动拉取订阅且不保存密码；失败时从 `%APPDATA%\com.appshub\XiyouYun\shared_preferences.json` 中读取本机登录会话的订阅地址兜底。

---

## 🏗️ 架构概览

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Windows 原生 WPF 桌面客户端 (DesktopApp.exe)         │
│          (高DPI抗锯齿 / 单实例锁 / 托盘管理 / 双周期额度 / 测速监控看板)     │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 本地 REST API (127.0.0.1:8787)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Node.js Bridge Backend (server.mjs)                  │
│  ├─ 账户与凭据管理 (OAuth, DPAPI, 凭据移除)                               │
│  ├─ 配额同步引擎 (quota_summary 双配额桶, live probing)                  │
│  ├─ Codex 事务接管 (快照备份, SHA-256 校验, 安全回滚)                     │
│  └─ 性能监控遥测 (TTFT 统计, Tokens/s 吞吐速率, 会话生命周期)               │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ Responses API 数据通道           │ 代理控制 / 账户鉴权
                   ▼                                 ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│         OpenAI Codex Desktop         │  │   CLIProxyAPI (127.0.0.1:8317)│
│  (provider: antigravity_local)       │  │ (Google Cloud Code Assist)   │
└──────────────────────────────────────┘  └──────────────┬───────────────┘
                                                         │ HTTPS (OAuth 2.0)
                                                         ▼
                                          ┌──────────────────────────────┐
                                          │ Google Antigravity Upstream  │
                                          │ (Gemini 3.7 / 3.6, Claude)   │
                                          └──────────────────────────────┘
```

---

## 📂 项目工程目录与文件分工

| 文件/目录 | 核心作用与职责 |
| :--- | :--- |
| **`server.mjs`** | **网桥核心服务端**：HTTP API 网关、Codex 配置事务接管、账户管理、配额探测合并、性能测速遥测。 |
| **`core.mjs`** | **核心逻辑库**：代理配置生成、模型规范化、配额数据提取、单/多账号调度逻辑。 |
| **`protocol.mjs`** | **协议层转换**：Antigravity ↔ Codex 协议转换、工具 Schema 清洗过滤、思维链（Thought）签名保护。 |
| **`transaction.mjs`**| **事务保护模块**：Codex 配置文件快照捕获、原子写入、SHA-256 完整性校验、崩溃自动回滚。 |
| **`history.mjs`** | **任务历史审计**：以只读模式安全解析 Codex 本地 SQLite 与 Session 任务元数据。 |
| **`subscription.mjs`** | **节点与出口规划**：订阅解析、地区过滤、节点评分、Listener 端口规划及 `dialer-proxy` 链式配置生成。 |
| **`src/DesktopApp.cs`**| **Windows 原生客户端源码**：纯 C# WPF 桌面控制台，包含抗锯齿 UI、单实例锁、托盘、测速卡片。 |
| **`src/app.manifest`**| **应用清单**：声明 Windows 10/11 `PerMonitorV2` 高 DPI 感知，根治字体模糊。 |
| **`scripts/build-exe.mjs`** | **发布构建脚本**：自动化调用 `csc.exe` 编译桌面 GUI，组装单机便携免安装发行包。 |
| **`scripts/inject-xiyou-script.mjs`** | **西游云脚本注入工具**：备份偏好设置后，将多 Listener 与链式代理覆写脚本写入当前脚本槽。 |
| **`public/`** | **Web 管理前端**：原生 HTML5/CSS3/ES6 现代化响应式控制面板（供浏览器访问）。 |
| **`test/*.test.mjs`** | **自动化测试套件**：覆盖配置、事务、恢复、协议、配额、订阅解析与链式代理生成。 |
| **`dist/AntigravityCodexBridge/`** | **最终交付物**：绿色独立运行目录，包含 `AntigravityCodexBridge.exe` 与所需运行资源。 |

---

## 🤖 如果需要把项目交给其他 AI 完善，应提供哪些文件？

如果您要将该项目提供给另一个 AI 助手继续开发或修复 Bug，请按照以下优先级提供文件：

### 1. 核心必读文件（最重要，理解全部业务逻辑）
1. **`server.mjs`** —— 整个网桥的服务端控制中枢（路由、配额、账号、遥测、事务）。
2. **`core.mjs`** —— 配额解析、模型映射、配置生成的核心纯函数库。
3. **`protocol.mjs`** —— 协议转换、SSE 流式事件与工具调用兼容层。
4. **`src/DesktopApp.cs`** —— Windows 原生 GUI 客户端的完整实现（UI 布局、状态轮询、操作交互）。
5. **`transaction.mjs`** —— 涉及 Codex 配置接管与安全回滚的核心机制。

### 2. 辅助参考文件（按需提供）
* 若涉及 **Web 界面调整**：提供 `public/app.js`、`public/index.html`、`public/styles.css`。
* 若涉及 **打包构建与清单**：提供 `scripts/build-exe.mjs`、`src/app.manifest`。
* 若涉及 **测试与验证**：提供 `test/core.test.mjs`、`test/bridge.test.mjs`。

---

## 🚀 快速上手与本地开发

### 环境要求
* **操作系统**：Windows 10 / Windows 11 (64-bit)
* **运行时环境**：Node.js 22.0.0+ (ESM 模块支持)
* **编译环境**：Windows 自带的 .NET Framework 4.8 编译器（位于 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，无需额外安装 Visual Studio）

### 常用命令

```powershell
# 1. 运行全部自动化测试
npm test

# 2. 语法与静态代码检查
npm run check

# 3. 编译 Windows 原生客户端并生成免安装独立发行包
npm run build:exe

# 4. 启动后端服务 (开发模式)
npm start
```

---

## 🛡️ 安全与合规说明

1. **非官方桥接通道**：本项目使用的 Antigravity 接口为 Google 内部云端模型通道，非公开发行版 API。接口与额度规则可能会随上游策略变化。
2. **本地凭据隔离**：所有 OAuth 令牌与管理秘钥均保存在当前 Windows 用户 `%LOCALAPPDATA%` 目录中，支持一键物理删除。
3. **零侵入保护**：对 Codex 原生配置的所有修改均基于原子事务与本地快照，任何退出动作均会无损恢复原生环境。
