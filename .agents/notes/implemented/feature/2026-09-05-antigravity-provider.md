# Agent Note: 集成 Antigravity Google OAuth 订阅渠道 Provider

Status: implemented

## Problem
CWTools 缺少对 Antigravity 渠道的支持（该渠道已在本地 dsh-chatgpt-subscription 方案中得到验证）。仅仅在列表中添加一个 Provider 条目无法处理复杂的 Google OAuth 认证、项目动态发现、封装的 Gemini SSE 流式传输以及带签名的工具调用连续性机制。

## Decision
1. **注册与双语流程**：将 Antigravity 接入现有的 HTTP Provider 注册表与双语设置流程中。
2. **宿主层接管认证与凭据**：Extension Host 统一负责基于本地环回回调（loopback callback）的 PKCE 登录、VS Code `SecretStorage` 凭据存储、排队串行刷新与登出、项目/模型列表发现及配额状态展示。OAuth 请求使用固定的 Google 原点并显式禁用重定向。
3. **协议流与状态持久化**：生成请求复用 Gemini 消息映射器，应用参考模型路由，解析封装的 SSE 流，并支持取消、空闲超时与响应大小上限限制；签名数据段（signed parts）能够在会话克隆和工具返回轮次中完整保留并参与 Token 估算；端点故障转移（failover）仅切换后端地址，绝不静默更改用户选中的模型。

## Alternatives considered
- **作为 OpenAI 兼容端点接入**：否决。Antigravity 使用 Google OAuth 及完全不同的自定义请求/响应封装信封。
- **复用外部本地文件凭据存储**：否决。会导致凭据管理混乱，将 Token 暴露在 VS Code `SecretStorage` 安全沙箱之外。
- **全量拷贝 DSH 适配器源码**：否决。会造成与现有 Gemini 转换逻辑重复，并引入无关的宿主依赖。
- **模型失败时自动回退至备选模型**：否决。不可在未经用户授权的情况下悄悄替换所选模型。

## Consequences
- 用户可通过 Google 账号登录并使用 Antigravity 进行流式文本生成、图像理解与 Agent 工具调用，在设置面板中直观查看模型目录与配额。
- 回归测试覆盖 PKCE/状态校验、并发刷新排队、登出竞争、畸变数据防护、端点故障转移、流式错误与取消、带签名多工具回放及双语界面呈现。
