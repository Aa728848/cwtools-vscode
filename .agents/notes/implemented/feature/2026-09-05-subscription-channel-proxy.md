# Agent Note: 订阅渠道代理（Subscription Channel Proxy）

Status: implemented

## Problem
Codex 订阅渠道与 Antigravity（Gemini OAuth）在企业内网或特定网络环境下，需要为 OAuth 认证和 Provider 流量提供可配置的代理路由，参考 `dsh-chatgpt-subscription` 的交互模型。

## Decision
1. **多模式代理配置**：在双方 AI 设置中增加共享的“自动（auto）/自定义（custom）/直连（direct）”代理设置。机器级模式遵循用户配置；自定义 HTTP、HTTPS 和 SOCKS5 地址（含账号密码鉴权）存储于 `SecretStorage` 中；状态展示与上报时对敏感凭据进行严格脱敏。
2. **自动探测优先级**：自动模式优先读取用户级 VS Code `http.proxy`，其次检查环境变量代理（`HTTPS_PROXY` 等），最后拉取 Windows/macOS 手动系统代理（具有 5 秒检测缓存）；暂不解析复杂 PAC 脚本。
3. **隔离的 Undici 传输通道**：基于 Undici 的单请求分发器（Dispatcher）保留原生的 fetch 流式响应与 AbortSignal 取消能力，绝不篡改全局 Node 进程分发器；SOCKS5 支持远程 DNS 解析及标准 TLS 校验；配置了代理的请求若失败绝不静默回退至直连；旧连接池在活跃流结束后安全退役并限制最大并发闲置连接池数量。

## Alternatives considered
- **修改全局 Dispatcher**：否决。会导致与订阅渠道无关的其他 Provider 及插件普通网络请求被意外代理劫持。
- **将带密码的代理明文保存在普通配置中**：否决。会导致认证凭据在明文配置和 Webview 状态中泄漏。
- **直接使用 Undici 新版 SOCKS agent**：否决。新版需要更高版本的 Node 运行时，使用兼容的 SOCKS 连接器可避免强行抬高 VS Code 运行环境基线。

## Consequences
- 共享代理通道全面覆盖 Token 交换与刷新、模型/账号/配额查询及聊天流式交互。
- 代理变更即时对后续新请求生效；浏览器端 OAuth 登录遵循系统浏览器自身代理，本地回调绑定 loopback。
- 回归测试覆盖脱敏校验、探测优先级、Secret 持久化、非法/丢失代理降级保护、真实 HTTP CONNECT 与 SOCKS5 路由、流式取消及并发配置切换。
