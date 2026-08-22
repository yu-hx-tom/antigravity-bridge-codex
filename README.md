# Antigravity Bridge Codex

Windows 桌面端 Bridge，用于管理 Google OAuth 账号、接管 Codex，并通过西游云为不同账号分配不同的代理节点和本地端口。

## 使用条件

- Windows 10/11 64 位
- 已安装、登录并正常运行西游云
- 使用完整发布目录，不要只复制 EXE

## 快速使用

1. 双击 `AntigravityCodexBridge.exe`。
2. 进入“代理配置”，选择“模式 2：高级多出口独立隔离模式”。
3. 填入订阅链接，点击“解析并优选节点”。
4. 使用节点卡片右上角的 ⚡ 测试单个节点，或点击“更新节点”分批刷新全部延迟。
5. 勾选需要的节点，点击“⚡ 一键应用独立通道”。
6. Bridge 会复制完整脚本并切换到西游云。在西游云打开：
   `设置 → 脚本 → Antigravity多端口并发代理脚本 → 编辑`
7. 在编辑器中按 `Ctrl+A`、`Ctrl+V`，然后保存。首次使用如果没有该脚本，请点击 `+` 新建同名脚本。
8. 返回 Bridge 等待自动验证。成功后会显示从 `7892` 开始的独立端口。
9. 在账号页面把不同 OAuth 账号绑定到不同的节点端口。

西游云需要保持运行。Bridge 不会安装或启动额外代理核心，也不会自动重启西游云。

## 重新打开软件

订阅、节点列表、节点选择和最近一次测速结果会保存在本机。重新启动后无需再次导入订阅；节点不会自动重新测速，需要时点击 ⚡ 或“更新节点”。

## 本地构建

```powershell
npm install
npm test
npm run build:exe
```

构建产物位于：

```text
dist/AntigravityCodexBridge/AntigravityCodexBridge.exe
```

将整个 `AntigravityCodexBridge` 文件夹复制到目标电脑即可运行。
