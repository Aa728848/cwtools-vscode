# Agent Note: 移除 Antigravity 供应商与独占补全服务

Status: implemented

> 本决策与历史决策 [集成 Antigravity Google OAuth 订阅渠道 Provider](../../archived/feature/2026-09-05-antigravity-provider.md) 相反。被取代的专属实现笔记已按原分类归档到 `../../archived/` 并在此显式交叉链接；历史发布记录不改写。

## Problem

Antigravity 曾是本项目的一条 Google OAuth 订阅线路，但它并非本项目要长期服务的供应商。其实现横跨内置注册表、封装的 Gemini SSE 请求、账号/项目/模型发现、多账号号池、原生 Tab 补全与 Tab Jump 命令、设置页账号卡、Webview 协议、图片预算、签名消息字段以及发布清单；只要保留任一入口或运行时分支，就会继续影响模型选择器、通用号池、安全读取策略与发布清单，形成无人验证的死代码。

用户要求移除该供应商及对应补全服务支持。已确认决策：整条线路连同独占补全能力彻底移除；旧配置沿用通用未知供应商回退；不主动删除用户 OAuth Token 或号池 SecretStorage 凭据；源码与发布清单都不再提供该供应商或补全命令；历史 CHANGELOG 与发布记录保留。

## Decision

1. **整体删除专属实现**：删除 `client/extension/ai/antigravity/` 全部 8 个模块、共享账号协议文件、Webview 账号渲染器、3 个专属测试与 `docs/antigravity-tab-protocol.md`；按文件名清理 `release/bin` 下的陈旧 JS/map 产物，不使用递归删除。
2. **收口供应商与请求流**：从 `BUILTIN_PROVIDERS`、wire 协议映射、推理能力、模型上下文/输出上限、图片预算与 `authKind` 删除 Antigravity 条目；`aiService` 删除 OAuth 服务、聊天/FIM 分叉与所有 Gemini 签名/JSON Schema/thoughtSignature 特例；通用 Gemini、Anthropic、Responses 与其他 OAuth 线路保持不变。
3. **收口补全与命令**：删除 `AntigravityTabJump` 注册与 `cwtools.ai.antigravityTabJump` 命令；行内补全恢复统一 trim、前缀去重与 overlap stripping 路径。通用行内补全仍供其余供应商使用。
4. **收口数据契约与安全边界**：删除 `ChatMessage.antigravity_content` 及上下文预算、token 估算、用量统计和 transcript 中的相关分支；历史 JSON 的额外字段按未知属性忽略。`resolveReadablePathInput` 不再以 Antigravity 读取模型为名默认放行任意本地路径，未命中工作区、AI 根、配置游戏根或辅助可信根时返回 `isWithinReadableRoot: false`。
5. **收口设置面与发布清单**：删除账号卡、登录/刷新/登出、专属号池消息与 Webview 状态；发布清单删除命令、两处 provider enum 及 enumDescriptions，三个 NLS 目录删除对应键并把订阅代理文案改为通用表述，`check-release.js` 删除 Antigravity OAuth localhost 白名单。
6. **兼容与用户数据**：不为旧 `antigravity` provider/model 值写专用迁移，不删除 SecretStorage 凭据；既有未知 id 回退继续覆盖旧设置。孤儿密钥只失去读写入口，不做不可逆数据操作。
7. **保留共享内核**：`pool/` 的 provider 无关号池、其余订阅线路规格、通用额度、订阅代理、共享号池 UI、Codex 配额组件与其他供应商的账号能力全部保留。
8. **文档与历史**：README、Marketplace README 与订阅计划文档按现状改写；订阅计划中的历史实现叙述标注「已移除」，历史 CHANGELOG 不抹除。9 篇完全失效的 Antigravity 专属笔记归档并与本笔记交叉链接；仍拥有号池、代理或单 Agent 决策的交付态笔记原地修正事实陈述。

### 归档笔记

- `../../archived/feature/2026-09-05-antigravity-provider.md`
- `../../archived/feature/2026-09-06-antigravity-tab-editing.md`
- `../../archived/feature/2026-10-04-antigravity-request-image-budget.md`
- `../../archived/architecture/2026-09-05-antigravity-account-shared-protocol-boundary.md`
- `../../archived/architecture/2026-10-04-multi-account-pool-core-and-antigravity.md`
- `../../archived/bug-fix/2026-09-05-antigravity-gemini-validation.md`
- `../../archived/bug-fix/2026-09-05-antigravity-tool-json-schema.md`
- `../../archived/bug-fix/2026-09-06-antigravity-model-catalog.md`
- `../../archived/simplification/2026-09-05-antigravity-quota-presentation.md`

## Alternatives considered

1. **只移除聊天供应商、保留行内补全与 Tab Jump**：否决。补全命令仍会调用已删除的 OAuth 与请求实现，必须保留一套无人验证的兼容层，且用户已确认彻底移除。
2. **仅隐藏 UI 入口、保留运行时实现**：否决。供应商注册、号池、发布清单与读取策略仍会留下活跃分支；同类移除先例已证明这是死代码而不是兼容层。
3. **为旧 provider 值写迁移并删除 SecretStorage 凭据**：否决。通用未知 id 回退已覆盖读取路径；删除用户密钥不可逆且没有 UI 能表达这次删除。
4. **连同通用号池、订阅代理或通用行内补全一起删除**：否决。这些内核还服务 Codex、Kimi、MiniMax Code、Claude、Command Code 与其他供应商，删除会破坏无关能力。
5. **抹掉历史 CHANGELOG、发布笔记与计划文档中的 Antigravity 字样**：否决。发布史与当时的设计取舍应可审计；只改现状、归档失效决策、保留带标注的历史叙述。
6. **删除 `cwtools-mcp` 子模块中的 Antigravity IDE 宿主说明**：否决。那是 MCP 支持的编辑器宿主，不是本项目 AI 供应商；子模块有独立所有权与发布周期。
7. **用递归删除清理 `release/bin` 陈旧产物**：否决。构建目录可能含链接与用户数据，按文件名逐个删除是唯一安全做法。

## Consequences

- 设置页、发布清单、命令面板与源码都不再把 Antigravity 作为可选供应商或补全服务；旧配置不会导致启动错误，用户改选一条现存供应商即可。
- 其他供应商、通用行内补全、共享号池与订阅代理行为不变；删除 Antigravity 专属签名消息字段后，历史话题仍可打开，额外字段只是被忽略。
- 安全读取路径恢复为可信根白名单：未配置的游戏目录、工作区或辅助根之外的普通本地文件默认拒绝，敏感凭据仍单独拒绝。
- 测试面收敛为现存线路，并通过「旧 id 回退」「清单不暴露」「账号卡不存在」「外部路径拒绝」等回归断言锁定移除后的公共行为。
- 后续若要重新支持该线路，需要重新实现凭据、目录、封装请求与补全协议；归档笔记保留了当时的网关实测结论与被否决方案，可供审计与复用。
