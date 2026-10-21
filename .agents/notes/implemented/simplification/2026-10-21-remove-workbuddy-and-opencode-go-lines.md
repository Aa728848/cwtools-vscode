# Agent Note: 移除 WorkBuddy 与 OpenCode Go 两条订阅线路

Status: implemented

## Problem

仓库里曾有两条与用户诉求无关的 AI 供应商线路：

- `workbuddy-subscription`（腾讯 WorkBuddy / CodeBuddy 订阅）：自带模块目录
  `client/extension/ai/workbuddy/`（凭据、网关客户端、实时模型目录、离线兜底表、额度、身份、
  每日签到调度器），并横跨 `aiService`、`chatSettings`、`chatHtml`、webview `chatPanel`、
  `chat/*` 协议与号池原型；
- `opencode-go`（OpenCode Go 套餐）：一条独立的 OpenAI 兼容线路，自带协议格式函数、13 条模型
  上限表、13 条计价键、缓存折扣分支、弃用模型表与发布清单枚举。

两条线路都需要长期维护（账号、区域、网关契约、模型目录），而它们并不是本项目要服务的对象。
只要保留 UI 入口或运行时分支，它们就会继续影响模型选择器、号池调度、计价与发布清单，因此
**只摘 UI 不摘实现**不可行：剩下的分支会成为无人验证的死代码。

## Decision

整体删除两条线路及其全部残留，同时保留共用的号池 / 额度内核与 `opencode`（OpenCode Zen）。

### 删除范围

| 层 | 处理 |
| --- | --- |
| 供应商注册 | `BUILTIN_PROVIDERS` 删除 `workbuddy-subscription` 与 `opencode-go` 两个条目 |
| 协议路由 | 删除 `getOpenCodeGoApiFormat`、`getProviderApiFormat` 的 Go 分支、WorkBuddy 的逐模型推理档位分支 |
| 模型能力 | 删除 `OPENCODE_GO_MODEL_LIMITS`（含 `MODEL_CONTEXT_TOKENS` 合并项与输出上限分支） |
| 计价 | 删除 `pricingData.json` 的 13 条 `opencode-go:*` 与 `getCacheDiscountFactor` 的 Go 分支 |
| 缓存能力 | `GATEWAY_PROVIDERS` 移除两个 id |
| 推理参数 | 4 条 `THINKING_RULES` 与两处 `opencode \|\| opencode-go` 联合条件收窄为只剩 `opencode` |
| 运行时 | `aiService` 删除 WorkBuddy 的字段、构造期初始化、号池 case、凭据解析分支、身份头合成、仅流式 + 强制前置 system 的请求改写，以及 8 个公开方法 |
| 号池 | 删除 `subscriptionPools` 的 WorkBuddy 凭据原型与身份键 |
| 设置面 | `chatSettings` 删除账号汇总、目录预热、上下文窗口映射与三个登录/签到入口；`chatHtml` 删除整块设置卡；`types.ts` 收窄 `authKind` 与 `settingsData`；`bridge` / `webviewProtocol` 删除三条消息 |
| Webview | `chatPanel` 删除四个按钮绑定、账号/签到/额度渲染与协议字段回写；`hostProtocol` 删除两个可选校验器 |
| 发布清单 | `release/package.json` 的 4 处 enum 与 4 处 enumDescriptions、3 个 nls 文件的 `opencode-go` 标题 |
| 测试 | 删除 3 个 WorkBuddy 专属测试，其余 7 个文件中摘除相关断言 |

### 刻意保留

- `opencode`（OpenCode Zen）：`getOpenCodeApiFormat`、`OPENCODE_MODEL_LIMITS`、
  `MODEL_CONTEXT_TOKENS` 的 `opencode:` 合并项、56 条 `opencode:*` 计价与缓存折扣分支全部保留。
- 号池内核（`pool/accountPool.ts`、`oauthAccountPool.ts`、`poolRegistry.ts`、`quotaWindows.ts`）
  与其余五条订阅线路（Codex、Kimi、Claude、MiniMax Code、Command Code）的规格、seed、额度面。
- `subscriptionOutputCap`：WorkBuddy 分支删除后仍被 Command Code 使用。
- 共享 UI（号池面板、`codex-quota-status` 等样式、`refreshSettingsOverview` 等工具）不动。

### 兼容与数据

- 旧设置里指向这两条线路的 provider 值不会迁移：`getProviderConfig` 对未知 id 已有通用回退，
  运行时不抛错、按默认条目继续，用户改选一条现存线路即可。
- `cwtools.ai.workbuddy.pool.v1` 这个 SecretStorage 键不再被读写；老用户的孤儿 secret 不主动
  删除——删用户密钥属于不可撤销的数据操作，且没有任何 UI 能表达这次删除。

### 文档与历史

- `docs/subscription-providers-plan.md` 属现状文档：加「已移除」说明、把两条线路从现状表移除，
  历史实现叙述保留并就地标注。
- `release/CHANGELOG.md` 的既有版本条目与已实现笔记中的历史事实**不改写**：发布史与当时的
  决策原因不是需要清理的残留。
- 原 `implemented/feature/2026-10-04-workbuddy-subscription-line.md` 归档到
  `archived/feature/`，其中的区域、桌面凭据、目录与档位实测结论由本笔记显式继承（见
  Alternatives considered 与被归档笔记的交叉链接）。

## Alternatives considered

1. **只删 `opencode-go`，保留 WorkBuddy**：否决。用户的诉求是两条一起移除；保留一条就要继续
   维护签到、区域与网关契约。
2. **只摘 UI 入口、保留运行时实现**：否决。号池调度、计价、模型目录仍会作用于这两条线路，
   且没有任何入口能让用户验证它们——这正是「残留代码」的定义。
3. **只删 WorkBuddy、保留 `opencode-go`**：否决（同上，且 Go 的 13 条上限/计价是纯维护负担）。
4. **连 `opencode`（Zen）一起删**：否决。用户明确要求移除的是 GO 线路；Zen 有自己的目录与
   计价，删除会波及其它无关能力。
5. **把历史 CHANGELOG 与旧笔记里的线路名一并抹掉**：否决。那等于改写发布史，让「当时为什么
   这么设计」永久失传；只清现状、保留历史才是可审计的做法。
6. **把 `withSubscriptionIdentityHeaders` 留成恒等函数**：否决。删除后它对所有剩余线路都恒等，
   留着只会让下一个读者以为某处仍需要它；三个调用点改为直传。
7. **顺手删除 SecretStorage 里的孤儿池 secret**：不做。删除用户凭据是不可逆操作，且与「移除
   代码」不是一件事；代价只是一个不再被读的键。
8. **为旧 provider 值写迁移逻辑**：否决。通用回退已经覆盖，专门迁移只会为两条已删除的线路留下
   永久的兼容代码。

## Consequences

- 设置页不再出现这两条线路；已选过它们的用户会落到通用回退，重新选一条现存线路即可。
- 号池、额度与请求路径对剩余五条订阅线路的行为不变；`opencode`（Zen）的模型上限、计价与
  缓存折扣完全不受影响。
- 发布清单的 provider 枚举与描述、nls 目录同步收窄，安装后设置项不再列出这两条线路。
- 测试面从「三条新增线路 + 六条号池线路」收敛为现存线路：删除 3 个专属测试文件，其余文件里的
  断言按现存线路重写，覆盖率不靠 `.skip` 维持。
- 后续再想支持这两条线路，需要重新实现凭据、目录与请求契约；被归档笔记里记录的网关实测结论
  （区域即凭据属性、`/v1/models` 404、仅流式与首条 system、档位并列向上）仍可复用。
