# Antigravity Codex Bridge

一个面向 Windows 的轻量本地桥接工具，用来管理 Antigravity Google OAuth 账号、读取上游报告额度，并通过 CLIProxyAPI 向 Codex 桌面端提供 OpenAI Responses API 兼容接口。

> 当前仓库是 2026-08-15 已验证可工作的稳定基线。后续开发应先保持本页“稳定配置契约”，再逐项扩展功能。

## 当前状态

- 项目版本：`0.1.0`
- 运行平台：Windows 10/11
- 运行时：Node.js 18 或更高版本
- npm 依赖：无，只使用 Node.js 标准库
- 本地管理页：`http://127.0.0.1:8787/`
- 本地 Responses API：`http://127.0.0.1:8317/v1`
- Codex Provider：`antigravity_local`
- 已验证模型：`gemini-3.7-flash-high`
- 验证时代理返回模型数：13，实际数量以后端账号和 CLIProxyAPI 返回结果为准
- 自动化测试：11 项全部通过
- 真实链路验证：向 `/v1/responses` 请求 `gemini-3.7-flash-high`，成功返回 `completed / OK`

## 功能范围

当前版本已经实现：

- 启动、停止、检测 CLIProxyAPI 本地核心。
- 从 GitHub Release 安装或更新 Windows 版 CLIProxyAPI。
- 发起 Antigravity Google OAuth，并轮询登录结果。
- 管理多个本地 OAuth 账号，包括启用、停用和删除本地凭据。
- 从 Antigravity 使用的 Google 内部接口读取模型额度报告。
- 从代理 `/v1/models` 动态生成 Codex 模型目录。
- 生成独立的 `antigravity_local` Codex Provider。
- 备份并切换 Codex 的 `config.toml` 和 `auth.json`。
- 启动 Microsoft Store 版 Codex 后重新应用暂存配置。
- 一键恢复接管前的 Codex 配置和认证文件。

当前版本明确不实现：

- 不实现 Codex 多开。
- 不把 Antigravity 伪装成官方 OpenAI Provider。
- 不改写旧的官方 Codex 历史会话请求。
- 不保证旧 Provider 创建的会话能继续用 Antigravity 模型发送消息。
- 不提供公开 Gemini API Key 模式；当前链路使用 Antigravity OAuth 和 Google 内部接口。
- 不保证上游报告额度等同于实际可调用额度或订阅账单余额。

## 架构

```text
Browser dashboard
    http://127.0.0.1:8787
              |
              v
Node.js bridge server
    server.mjs
              |
              | management API
              v
CLIProxyAPI
    http://127.0.0.1:8317/v1
       |                    |
       | Google OAuth       | OpenAI Responses API
       v                    v
Antigravity / Google     Codex desktop
internal endpoints       provider: antigravity_local
```

管理服务和代理服务都只监听 `127.0.0.1`。浏览器管理 API 需要页面注入的 `X-Bridge-Key`，Codex 到代理的请求使用本地随机 API Key。

## 目录结构

```text
antigravitywork/
├─ core.mjs                         纯函数、配置生成和响应解析
├─ server.mjs                       HTTP 服务、CLIProxyAPI 管理和 Codex 接管流程
├─ launch-codex-api-service.ps1     稳定版 Codex Store 启动器
├─ 启动.bat                          启动管理服务并打开浏览器
├─ 启动 Codex API Service.bat        调用 PowerShell 启动 Codex API Service
├─ public/
│  ├─ index.html                    管理页面结构
│  ├─ app.js                        页面状态、API 调用和交互逻辑
│  └─ styles.css                    页面样式
├─ test/
│  ├─ core.test.mjs                 配置、模型和额度解析测试
│  └─ server.test.mjs               管理 API 与 Store 启动器测试
├─ package.json
├─ .gitignore
└─ README.md
```

项目没有 `node_modules`，也不需要执行 `npm install`。

## 环境要求

1. Windows 10 或 Windows 11。
2. Node.js 18 或更高版本，`node.exe` 可通过 `PATH` 找到。
3. Microsoft Store 版 Codex/ChatGPT 桌面客户端。
4. CLIProxyAPI Windows 可执行文件。
5. 能完成 Antigravity Google OAuth 的 Google 账号。
6. 可以访问 GitHub Release 和相关 Google 服务的网络环境。

CLIProxyAPI 是独立的第三方运行核心，不是 npm 包，也不是本项目源码的一部分。管理页的“安装 / 更新核心”会下载 `router-for-me/CLIProxyAPI` 的最新 Windows Release；也可以在高级设置里直接填写已有的 `cli-proxy-api.exe` 路径。

## 快速启动

### 1. 启动管理页

双击：

```text
启动.bat
```

或者在项目目录运行：

```powershell
npm.cmd start
```

默认会打开 `http://127.0.0.1:8787/`。

### 2. 准备 CLIProxyAPI

首次使用时执行其中一种方式：

- 点击“安装 / 更新核心”，自动从 GitHub Release 下载。
- 在“高级设置”里填写现有 `cli-proxy-api.exe` 的绝对路径。
- 把可执行文件放到 `%LOCALAPPDATA%\AntigravityCodexBridge\bin\cli-proxy-api.exe`。
- 把可执行文件加入 `PATH`。

点击“启动服务”，确认页面显示：

```text
http://127.0.0.1:8317/v1
```

### 3. 登录 Google 账号

1. 点击“登录 Google 账号”。
2. 在 Google 页面确认显示的是预期账号和 Google Antigravity 应用。
3. 完成授权后等待管理页自动同步。
4. 账号卡显示“代理就绪”后，点击“刷新额度”。

OAuth 凭据只保存在本机运行数据目录。删除账号只删除本地凭据，不会撤销 Google 账号侧的授权。

### 4. 接管 Codex

推荐严格按以下顺序操作：

1. 在管理页选择一个代理返回的模型。
2. 完全退出所有 Codex 窗口和托盘中的 `ChatGPT.exe`。
3. 保留浏览器管理页，在 Codex 完全退出后点击“应用 API Service 配置”。
4. 双击 `启动 Codex API Service.bat`。
5. 启动器通过 Microsoft Store AppID 打开 Codex。
6. 等待启动器在桌面端启动 3 秒后重新写入暂存的 API Service 配置。
7. 在 Codex 中新建对话进行测试。

成功时，桌面端应使用 `Codex API Service` / `antigravity_local`，模型列表来自当前 Antigravity 代理，而不是官方 OpenAI 账号模型。

不要用 Antigravity Provider 继续发送旧的官方 OpenAI 会话。当前稳定版只保证新建会话工作。

### 5. 恢复官方配置

1. 完全退出 Codex。
2. 在管理页点击“恢复原 Codex 配置”。
3. 正常启动 Codex。

恢复操作会依据首次接管时生成的 manifest 原样恢复 `config.toml` 和 `auth.json`。重复应用 API Service 配置不会覆盖第一次保存的官方配置备份。

## 稳定配置契约

当前可工作的 Codex 配置必须保持以下关键结构：

```toml
model_provider = "antigravity_local"
model = "<从代理返回的模型>"
model_catalog_json = "<运行数据目录>/codex-model-catalog.json"

[model_providers.antigravity_local]
name = "Codex API Service"
base_url = "http://127.0.0.1:8317/v1"
experimental_bearer_token = "<本地随机密钥>"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
supports_websockets = false

[windows]
sandbox = "unelevated"
```

配套 `auth.json`：

```json
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "<与代理配置一致的本地随机密钥>"
}
```

模型目录中的每个模型必须提供非空 `base_instructions`。缺少该字段时，Codex 桌面端可能无法正确创建或运行会话。

`createActiveCodexConfig()` 只替换以下受管理内容，并保留其他用户设置：

- 顶层 `model_provider`
- 顶层 `model`
- 顶层 `model_catalog_json`
- 遗留的顶层 `openai_base_url`
- `[model_providers.antigravity_local]`
- `[windows]` 中的 `sandbox`

## 为什么启动器要二次写入配置

Microsoft Store 版 Codex 启动时可能同步官方 Profile，并覆盖刚写入的 Provider 配置。稳定启动器采用最小流程：

1. 确认当前配置已经是 `antigravity_local`。
2. 等待现有 `ChatGPT.exe` 完全退出。
3. 通过 `explorer.exe shell:AppsFolder\<AppID>` 启动 Store 应用。
4. 等待 `ChatGPT.exe` 出现。
5. 再等待 3 秒。
6. 把暂存的 `config.toml` 和 `auth.json` 重新复制到真实 Codex Home。

不要直接从 `C:\Program Files\WindowsApps` 对 `ChatGPT.exe` 调用 `Start-Process`。该方式在实际环境中出现过“拒绝访问”和 Windows 设置/UAC 页面，稳定版已经改为 Store AppID 启动。

## 运行数据

默认运行数据目录：

```text
%LOCALAPPDATA%\AntigravityCodexBridge
```

主要内容：

```text
AntigravityCodexBridge/
├─ settings.json                    端口、路径和本地随机密钥
├─ config.yaml                      生成的 CLIProxyAPI 配置
├─ auths/                           Google OAuth 凭据
├─ bin/cli-proxy-api.exe            下载的第三方核心
├─ quota-cache.json                 上游额度缓存
├─ codex-model-catalog.json         动态生成的 Codex 模型目录
├─ codex-home/
│  ├─ antigravity.config.toml       独立 Profile
│  ├─ config.toml                   启动时重新应用的暂存配置
│  └─ auth.json                     暂存 API Key 认证文件
├─ backups/
│  ├─ codex/                        暂存 Profile 的历史备份
│  └─ codex-live/                   真实 Codex Home 的接管前备份
├─ launch-codex-api-service.cmd     管理服务生成的启动脚本
└─ launch-codex-api-service.ps1     管理服务生成的 PowerShell 启动器
```

如果 `%LOCALAPPDATA%` 不可写，`启动.bat` 会回退到项目目录下的 `.data`。

以下内容包含敏感信息，不能提交、分享或打入源码包：

- `settings.json`
- `config.yaml`
- `auths/`
- `codex-home/auth.json`
- `backups/`
- `quota-cache.json`
- 日志文件

## Codex Home 检测

真实 Codex Home 按以下顺序确定：

1. `BRIDGE_CODEX_HOME`
2. `CODEX_HOME`
3. 项目所在盘根目录的 `\codex-home`，前提是其中已有 `config.toml`
4. `%USERPROFILE%\.codex`

也可以在管理页高级设置里填写绝对路径。当前验证环境使用 `D:\codex-home`。

## 环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `BRIDGE_PORT` | 管理页面端口 | `8787` |
| `BRIDGE_DATA_DIR` | 运行数据目录 | `%LOCALAPPDATA%\AntigravityCodexBridge` |
| `BRIDGE_CODEX_HOME` | 强制指定真实 Codex Home | 自动检测 |
| `CODEX_HOME` | Codex Home 兼容环境变量 | 自动检测 |
| `CODEX_APP_PATH` | 辅助推导 Store AppID 的桌面端路径 | 自动检测 Store 包 |
| `BRIDGE_NO_OPEN` | 设为 `1` 时不自动打开浏览器 | 未设置 |

## 管理 API

所有 `/api/*` 请求都必须携带页面 meta 标签提供的 `X-Bridge-Key`。非 GET/HEAD 请求必须使用 `Content-Type: application/json`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dashboard` | 返回代理、账号、模型、额度、Codex 和日志状态 |
| `POST` | `/api/proxy/install` | 下载并安装 CLIProxyAPI |
| `POST` | `/api/proxy/start` | 启动本工具托管的代理进程 |
| `POST` | `/api/proxy/stop` | 停止本工具托管的代理进程 |
| `POST` | `/api/oauth/start` | 创建 Antigravity OAuth 会话 |
| `GET` | `/api/oauth/status?state=...` | 查询 OAuth 完成状态 |
| `POST` | `/api/quota/refresh` | 刷新全部账号或指定 `authIndex` 的额度 |
| `PATCH` | `/api/accounts/status` | 启用或停用本地账号 |
| `DELETE` | `/api/accounts` | 删除本地账号凭据 |
| `PUT` | `/api/settings` | 更新端口、路径和额度检查间隔 |
| `POST` | `/api/codex/prepare` | 只生成暂存 Profile，不替换真实配置 |
| `POST` | `/api/codex/activate` | 备份并应用真实 Codex 配置 |
| `POST` | `/api/codex/launch` | 当前等同于 activate，返回需要手动重启 |
| `POST` | `/api/codex/restore` | 恢复接管前配置 |

桥接服务通过 CLIProxyAPI 管理端点使用以下能力：

- `/auth-files`
- `/auth-files/status`
- `/antigravity-auth-url`
- `/get-auth-status`
- `/api-call`
- `/v1/models`
- `/v1/responses`

CLIProxyAPI 升级后如果这些管理端点或字段发生变化，应优先更新 `server.mjs` 的适配层，并增加测试，不要直接在页面代码里兼容。

## 额度实现

额度刷新流程：

1. 从 CLIProxyAPI `/auth-files` 读取可用 Antigravity 账号。
2. 通过 `v1internal:loadCodeAssist` 尝试解析 Google Cloud 项目标识。
3. 按 sandbox、daily、正式域名顺序调用 `v1internal:fetchAvailableModels`。
4. 解析 `remainingFraction` 和 `resetTime`。
5. 将结果缓存到 `quota-cache.json`。

需要正确理解额度数据：

- 它是上游接口的报告值，不是 Google 官方账单或订阅余额。
- 报告仍有额度时，生成接口也可能因 429、模型容量或风控失败。
- `401/403` 通常表示需要重新授权。
- `429` 可能是额度、频率、模型容量或账号冷却。
- 页面同时显示代理健康状态和额度报告，不能只看百分比。

## 开发和测试

语法检查：

```powershell
npm.cmd run check
```

运行测试：

```powershell
npm.cmd test
```

运行隔离测试服务：

```powershell
$env:BRIDGE_DATA_DIR = "$env:TEMP\ag-bridge-dev"
$env:BRIDGE_CODEX_HOME = "$env:TEMP\ag-codex-home"
$env:BRIDGE_PORT = "18787"
$env:BRIDGE_NO_OPEN = "1"
node server.mjs
```

测试使用 Node.js 内置 `node:test`，不需要安装测试框架。新增非平凡解析或配置逻辑时，优先在 `core.mjs` 中写成纯函数并补一个最小测试。

真实代理链路的最小验证目标：

```text
POST http://127.0.0.1:8317/v1/responses
model: gemini-3.7-flash-high
input: Reply with exactly OK.
expected: status=completed, output=OK
```

不要把实际 API Key 写入测试、README、日志或提交记录。

## 已知问题和排查

### 浏览器访问 `/v1` 显示无法访问

`http://127.0.0.1:8317/v1` 不是网页首页。应检查管理页状态或带认证请求 `/v1/models`，不能用浏览器空 GET 是否渲染页面作为服务健康依据。

### Google OAuth 回调显示 `localhost` 拒绝连接

先确认桥接服务和 CLIProxyAPI 在 OAuth 全程都没有退出。OAuth 状态由 CLIProxyAPI 管理端点轮询，不能在授权过程中关闭启动窗口或代理进程。

### 显示官方账号、官方模型或官方额度

说明桌面端启动时覆盖了配置，或当前不是 `antigravity_local`：

1. 完全退出 Codex 和托盘进程。
2. 回到管理页重新点击“应用 API Service 配置”。
3. 使用 `启动 Codex API Service.bat` 启动。
4. 新建会话检查 Provider 和模型。

### `unknown provider for model ...`

通常是 Provider、模型目录和旧会话模型不一致。稳定配置不包含 `gpt-5.6-sol` 映射，也不使用 `model_provider = "openai"`。恢复本页的稳定配置后新建会话。

### `Selected model is at capacity`

这是上游所选模型暂时满载，不代表本地桥接一定损坏。切换另一个代理可见模型，或稍后重试。

### `Requests ending with a model turn are not supported`

这是旧会话请求结构与当前代理 Responses 适配不兼容。当前稳定策略是不改写历史请求，直接新建 Antigravity 会话。

### `Thinking level MINIMAL is not supported for this model`

当前模型不支持旧会话带来的 `MINIMAL` 推理级别。稳定模型目录不声明推理等级；新建会话，不要强制注入该参数。

### Windows 设置/UAC 页面或 `Start-Process` 拒绝访问

不要直接执行 `WindowsApps` 下的 `ChatGPT.exe`。使用当前脚本中的 `shell:AppsFolder` Store AppID 启动方式。

### GitHub 返回 403

安装器已经实现 GitHub API 失败后改用 Releases 页面，但网络、代理或 GitHub 限流仍可能导致下载失败。可以手动下载匹配架构的 CLIProxyAPI Release，并在高级设置中填写可执行文件路径。

## 不要重新引入的回归方案

以下方案已在真实 Codex 桌面端上造成错误，除非先做隔离实验和协议级验证，否则不要重新加入稳定分支：

1. 不要把 Provider ID 改为 `openai`。
2. 不要依赖顶层 `openai_base_url` 接管桌面端。
3. 不要把 `gpt-5.6-sol` 等官方模型别名映射到 Gemini。
4. 不要为了继续旧历史会话而改写 Responses 请求结尾角色。
5. 不要向不支持的模型强制发送 `MINIMAL` thinking level。
6. 不要添加持续覆盖配置的 watchdog。
7. 不要在 Store 应用启动前反复复制配置；稳定流程只在启动后延迟 3 秒重写一次。
8. 不要直接启动 `WindowsApps` 中的 exe。

如果以后要兼容历史会话，应先单独研究 Codex 桌面端的会话存储、Provider 绑定、模型能力声明和 Responses payload，再设计可回退的迁移，不要在代理层猜测和重写请求。

## 安全边界

- 服务仅监听 loopback，但本地同一用户下的其他进程仍可能读取运行数据。
- OAuth token、本地 API Key 和管理密钥目前以文件形式保存在本机，没有使用 Windows DPAPI 加密。
- 日志写入前会尝试遮蔽 Bearer token、OAuth token、回调 code 和 token 查询参数。
- 管理页不会完整返回管理密钥和 API Key。
- 删除本地账号不会撤销 Google 侧授权，需要用户自行在 Google 账号安全页面撤销。
- Antigravity 通道使用 Google 内部接口，不是公开 Gemini API，可能受到服务条款、风控和接口变更影响。
- 建议只使用专门的非关键测试账号，不要使用承载重要数据的主账号。

## 后续开发建议

建议按风险从低到高推进：

1. 增加“导出脱敏诊断包”，包含版本、端口、结构化错误和配置摘要，不包含凭据。
2. 固定并显示 CLIProxyAPI 版本，升级前后运行契约测试。
3. 增加代理进程 PID、退出码和日志文件入口。
4. 为不同模型维护明确的 capability 映射，而不是猜测 thinking 参数。
5. 使用 Windows DPAPI 或 Credential Manager 保护 OAuth 和本地密钥。
6. 将备份、应用、恢复做成可验证的事务状态机。
7. 最后再研究历史会话兼容；必须提供开关和完整回退路径。

## 源码包规则

用于交接的源码压缩包应包含本仓库全部工程文件，但排除：

- `.data/`
- `node_modules/`
- `*.log`
- `%LOCALAPPDATA%\AntigravityCodexBridge`
- OAuth 凭据、API Key、备份和额度缓存
- 下载的 CLIProxyAPI 二进制和临时安装包

源码包不包含 Google 账号状态，也不会改变当前机器上已经工作的运行数据。

## 发布前事项

当前项目还没有开源许可证。公开发布前至少需要：

1. 选择并添加项目许可证。
2. 核对 CLIProxyAPI 的许可证、分发条件和商标说明。
3. 明确 Antigravity/Google 内部接口的使用风险和免责声明。
4. 在全新 Windows 用户环境完成一次从零安装测试。
5. 确认压缩包和提交历史中没有 OAuth token、API Key、邮箱或本地绝对隐私路径。

