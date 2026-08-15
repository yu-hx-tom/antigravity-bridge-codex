# Antigravity Codex Bridge

面向 Windows 的轻量本地桥接器。它管理 Antigravity Google OAuth 账号和额度报告，通过 CLIProxyAPI 向 Codex Desktop 提供 OpenAI Responses API 兼容端点，并以可验证事务临时接管 Codex 的 `config.toml` 与 `auth.json`。

> 这是非官方接入路径。Antigravity 通道使用 Google 内部接口，不是公开 Gemini API；接口、账号策略和服务条款可能变化。建议仅使用专门的测试账号。

## 版本与回滚

- 当前开发版本：`0.2.0`
- 稳定基线提交：`6aa3853`
- 稳定标签：`stable-v0.1.0`
- 当前开发分支：`feature/reliability-v0.2`
- 已验证 Codex CLI：`0.142.0`
- 锁定 CLIProxyAPI：`7.2.132`，commit `78f0c407`
- 锁定二进制 SHA-256：`433ddc18d6fe163fa863579a5400eebf6178d685af6ab9524059b12d396f9e9c`

回到改造前可用版本：

```powershell
git -c safe.directory=D:/claude-code-space/antigravitywork switch --detach stable-v0.1.0
```

不要用 `git reset --hard` 回滚含有用户改动的工作区。

## 当前能力

- 本地管理页仅监听 `127.0.0.1:8787`。
- CLIProxyAPI 对外端点默认为 `http://127.0.0.1:8317/v1`。
- Google OAuth 登录、多账号启停、本地凭据删除和额度报告。
- 动态读取 `/v1/models`，生成 Codex 可解析的模型目录。
- Codex Desktop 可显示并切换 13 个 Antigravity 模型；目录已通过 Codex app-server 隔离解析。
- 一键执行“退出 Codex、启动代理、事务应用配置、启动 Store 桌面端、启动后重写一次配置”。
- 失败自动恢复；代理异常退出和管理服务正常关闭时恢复接管前文件。
- `config.toml` 与 `auth.json` 使用单文件原子替换、事务状态和 SHA-256 验证。
- 客户端 Key、管理 Key、页面控制 Key 使用 Windows DPAPI 保存。
- Codex Provider 使用 `auth.command` 动态读取客户端 Key，真实 Key 不写入 `config.toml` 或 `auth.json`。
- OAuth 文件在代理停止时收入 DPAPI 保险库；代理运行前临时解封。
- EFS 可用时额外加密 `auths` 和 `secure` 目录；不可用时管理页报告警告，不伪装成功。
- CLIProxyAPI 配置包含 Key，但核心读取配置并健康后立即删除该文件。
- 只读历史任务清单显示标题、原始 Provider、模型、归档状态和继续策略。
- 脱敏诊断 ZIP 不包含 OAuth、Key、对话正文或完整 Codex 配置。
- Responses API 和 Codex 工具调用验收脚本。

## 尚未完成的在线验收

当前 `127.0.0.1:8317` 离线，因此本轮没有消耗真实账号额度，也没有把以下项目写成已通过：

- Responses API 流式文本。
- 函数工具调用。
- shell、`apply_patch` 和并行工具调用。
- 多轮长对话和上下文压缩。
- 图片输入。
- 请求取消、客户端超时、重试与断线重连。
- 各模型 capability 的实测确认。

`modelCapabilities()` 当前采用保守静态声明，并标记 `verification: "unverified"`。升级锁文件或调整能力前必须运行在线验收。

管理 API 的 401、403、429、模型满载和额度耗尽已转换为中文错误。Codex 到 CLIProxyAPI 的数据面仍是直连，流式响应中的上游错误不会经过 Node 管理服务二次转换；若需要统一改写，必须单独引入经过故障注入测试的流式网关，不能只改字符串。

## 架构

```text
Browser dashboard
  127.0.0.1:8787
          |
          v
Node bridge server
  account / quota / transaction / history / diagnostics
          |
          v
CLIProxyAPI 127.0.0.1:8317/v1
       |                    |
       | Google OAuth       | Responses API
       v                    v
Antigravity internal     Codex Desktop
Google endpoints         provider: antigravity_local
```

Codex 自定义 Provider 使用官方配置项 `model_provider`、`model_catalog_json`、`wire_api = "responses"` 和 Provider `auth.command`。参考 [OpenAI configuration reference](https://developers.openai.com/codex/config-reference)。

## 环境要求

1. Windows 10/11。
2. Node.js 22 或更高版本。历史只读清单使用内置 `node:sqlite`；其他功能可在较低版本运行，但本项目按 Node 22+ 验收。
3. Microsoft Store 版 Codex/ChatGPT Desktop。
4. 可完成 Antigravity Google OAuth 的账号。
5. 能访问锁定 GitHub Release 与 Google 服务的网络。

项目无 npm 运行依赖，不需要 `npm install`。

## 快速使用

### 1. 启动管理页

双击 `启动.bat`，或运行：

```powershell
npm.cmd start
```

默认打开 `http://127.0.0.1:8787/`。

首次由 `0.1.0` 升级时，服务会把 `settings.json` 中的旧明文密钥迁移到 `secure/secrets.dpapi`，随后从 `settings.json` 删除密钥字段。

### 2. 安装并启动核心

点击“安装 / 更新核心”只安装 `cliproxy.lock.json` 锁定的版本，不再查询 latest。安装器会校验解压后的 EXE 哈希；不匹配时拒绝替换。

也可以在高级设置中指定现有 `cli-proxy-api.exe`。未匹配锁文件的自定义二进制会显示为不兼容，不能视为已经验收。

### 3. 登录 Google 账号

1. 点击“登录 Google 账号”。
2. 在 Google 页面确认账号和 Google Antigravity 应用。
3. 完成授权并等待管理页同步。
4. 刷新额度。

额度百分比是内部接口报告，不等于官方账单余额。报告仍有额度时，请求也可能因 429、模型容量或风控失败。

### 4. 一键启动 Codex API Service

1. 在“Codex 模型”选择默认模型。
2. 点击“一键启动 Codex”。
3. 启动器先请求所有 `ChatGPT.exe` 主窗口正常关闭，10 秒后只终止残留的同名托盘进程。
4. 代理健康后创建并验证原配置快照。
5. 原子应用 API Service 配置。
6. 使用 `shell:AppsFolder\<AppID>` 启动 Store 应用。
7. 桌面端出现 3 秒后再次原子应用暂存配置，抵消启动时的官方配置同步。
8. 任一步失败都会调用恢复接口。

也可双击运行时目录生成的 `launch-codex-api-service.cmd`。不要直接执行 `WindowsApps` 中的 `ChatGPT.exe`。

成功后新建任务。不要用 Gemini 继续官方 OpenAI Provider 创建的旧任务。

### 5. 恢复官方配置

点击“恢复原 Codex 配置”。恢复会校验备份 SHA-256，并按接管前状态恢复文件；接管前不存在的文件会被删除。

管理服务正常退出或托管代理异常退出时也会恢复。硬断电时无法执行退出钩子；下次桥接器启动会读取事务清单，恢复中断事务，或为 active 接管重新启动代理，失败则回退配置。

## 模型显示与切换

旧目录缺少 `supports_reasoning_summaries`、非空推理等级、输入模态等 Codex `0.142.0` 所需字段。Codex 会拒绝该目录并静默回退官方模型，所以此前虽然请求使用默认 Gemini，界面仍无法显示或切换模型。

当前目录已通过：

```powershell
npm.cmd run verify:catalog
```

验收必须返回完整 Antigravity 模型列表，且不能包含 `Invalid configuration` 或 `failed to parse model_catalog_json`。

## 历史任务策略

- 使用原 Codex Home，不删除 `sessions`、`archived_sessions`、SQLite 或索引文件。
- 管理页以 SQLite `readOnly` 模式读取 `threads` 元数据，不读消息正文。
- `model_provider = "antigravity_local"` 的任务标记为可继续。
- 其他 Provider 创建的任务标记为只读，保留原 Provider/模型。
- 不把 `openai`、官方模型名或旧 reasoning 参数映射到 Gemini。
- 历史迁移入口默认关闭。

历史迁移以后只能作为独立实验功能实现。实验前至少完整备份：

```text
state_5.sqlite*
sessions/
archived_sessions/
session_index.jsonl
.codex-global-state.json
```

实验必须使用副本、记录变更清单，并提供完整回退；不得直接修改用户当前 SQLite。

## 配置事务

活动备份位于：

```text
%LOCALAPPDATA%\AntigravityCodexBridge\backups\codex-live\<timestamp>
```

`manifest.json` 记录：

- `liveHome`
- 接管前文件是否存在
- 接管前 SHA-256
- `prepared / applying / active / restoring / restored / recovered` 状态
- 当前模型和接管后哈希

多文件系统不能保证两个文件在同一 CPU 指令中同时替换。本项目采用单文件原子重命名加事务日志；第二个文件失败时，立即按验证过的快照回滚第一个文件。

## 密钥与 OAuth

运行目录：

```text
%LOCALAPPDATA%\AntigravityCodexBridge
├─ settings.json                 非敏感设置，不含 Key
├─ secure/
│  ├─ secrets.dpapi              当前 Windows 用户 DPAPI 密文
│  ├─ oauth-vault.dpapi          代理停止时的 OAuth 密文保险库
│  └─ get-client-token.ps1       不含 Key，只负责 DPAPI 解密
├─ auths/                        仅代理运行时临时解封
├─ bin/
│  ├─ cli-proxy-api.exe
│  └─ version.json
├─ codex-home/                   暂存 Provider、占位 auth.json 和模型目录
├─ backups/                      接管前配置快照
└─ diagnostics/                  用户主动生成的脱敏 ZIP
```

安全边界：

- DPAPI 防止其他 Windows 用户直接读取密钥，但当前同一用户下的恶意进程仍可能调用 DPAPI。
- CLIProxyAPI 运行时必须读取 OAuth 文件，因此无 EFS 时存在运行期明文窗口；停止后会封存。
- EFS 是否可用必须看管理页安全状态，不能仅因执行了 `cipher.exe` 就认定成功。
- 删除本地凭据不等于撤销 Google 授权；撤销需在 Google 账号安全页完成。

## 诊断包

管理页点击“生成脱敏诊断包”，输出到 `diagnostics/`。ZIP 仅包含：

- 应用、Node、CLIProxyAPI 版本和哈希。
- 端口与进程状态。
- Provider、模型、配置文件哈希。
- DPAPI/EFS 状态。
- 历史 Provider 计数。
- 已脱敏的内存日志和错误。

不包含 OAuth、API Key、管理密钥、`auth.json` 内容、`config.toml` 内容、任务标题或消息正文。

## 协议验收

语法、单元和集成测试：

```powershell
npm.cmd run check
npm.cmd test
```

Codex 模型目录解析：

```powershell
npm.cmd run verify:catalog
```

低成本在线协议测试：

```powershell
npm.cmd run verify:live
```

额外消耗额度的长对话测试：

```powershell
npm.cmd run verify:live:extended
```

隔离临时目录中的 Codex shell、`apply_patch`、并行工具测试：

```powershell
npm.cmd run verify:tools
```

`verify:live` 覆盖非流式、SSE 流式、函数调用、多轮、图片、取消和客户端超时。重试与断线重连需要可控故障注入网关；普通成功请求不能证明这两项，因此脚本会标记 `not-simulated`。

## 管理 API

所有 `/api/*` 请求需要页面注入的 `X-Bridge-Key`。非 GET/HEAD 请求必须使用 `Content-Type: application/json`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/dashboard` | 聚合代理、账号、模型、历史、安全和接管状态 |
| `GET` | `/api/history` | 强制刷新只读历史元数据 |
| `GET` | `/api/proxy/compatibility` | 检查锁定版本、commit 和 EXE 哈希 |
| `POST` | `/api/proxy/install` | 安装锁定 CLIProxyAPI |
| `POST` | `/api/proxy/start` | 解封 OAuth 并启动托管代理 |
| `POST` | `/api/proxy/stop` | 停止代理并封存 OAuth |
| `POST` | `/api/oauth/start` | 发起 Antigravity OAuth |
| `GET` | `/api/oauth/status` | 查询 OAuth 状态 |
| `POST` | `/api/quota/refresh` | 刷新额度报告 |
| `PATCH` | `/api/accounts/status` | 启用或停用本地账号 |
| `DELETE` | `/api/accounts` | 删除本地账号凭据 |
| `PUT` | `/api/settings` | 更新安全设置 |
| `POST` | `/api/codex/prepare` | 只生成暂存配置 |
| `POST` | `/api/codex/activate` | 事务应用配置，不启动桌面端 |
| `POST` | `/api/codex/launch` | 启动受监控的一键流程 |
| `POST` | `/api/codex/reapply` | 桌面端启动后原子重写一次 |
| `POST` | `/api/codex/restore` | 恢复接管前配置 |
| `POST` | `/api/diagnostics` | 生成脱敏诊断 ZIP |

## 常见问题

### 浏览器访问 `/v1` 失败

`/v1` 不是网页。使用管理页状态或带认证的 `/v1/models` 判断服务健康。

### `Selected model is at capacity`

表示所选上游模型暂时满载。切换模型或稍后重试，不代表本地桥接器一定损坏。

### `unknown provider for model ...`

通常是旧任务仍绑定官方模型。恢复原 Provider 查看旧任务，或新建 Antigravity 任务；不要把官方模型别名映射到 Gemini。

### 历史任务不显示

先看管理页只读历史清单。数据通常仍在 `state_5.sqlite` 和 `sessions`，桌面端可能按 Provider、索引或 Profile 过滤。不要通过重写 Provider 修复可见性。

### GitHub 403

安装器直接下载锁定 Release，不调用 GitHub latest API。若直链仍返回 403，只能检查网络/代理，或手动提供哈希完全匹配的 EXE。

### Windows 设置/UAC 页面

不要直接启动 `WindowsApps` 内的 EXE。当前启动器只使用 Store AppID。

## 工程结构

```text
core.mjs                         Provider、模型目录、配额解析
history.mjs                      SQLite 只读历史清单
protocol.mjs                     能力声明、Responses 辅助和友好错误
security.mjs                     DPAPI、OAuth 保险库和 EFS
transaction.mjs                  原子写入、快照、哈希和恢复
server.mjs                       管理服务、代理、OAuth、一键接管、诊断
scripts/verify-codex-catalog.mjs Codex app-server 目录验收
scripts/verify-live.mjs          Responses 在线验收
scripts/verify-codex-tools.mjs   Codex 工具调用验收
public/                          本地管理页面
test/                            Node 内置测试
cliproxy.lock.json               第三方核心版本锁
```

## 发布前检查

1. 全新 Windows 用户执行从零安装、OAuth、一键启动、恢复。
2. 运行全部本地和在线验收并保存脱敏诊断。
3. 确认锁文件、Release 文件名和两个架构哈希。
4. 检查提交历史和压缩包不含 `secure/`、`auths/`、备份、诊断、账号邮箱和绝对隐私路径。
5. 添加开源许可证，并核对 CLIProxyAPI 的许可证与分发条件。
6. 明确 Google 内部接口和账号风险，不宣传为官方 Gemini API。
