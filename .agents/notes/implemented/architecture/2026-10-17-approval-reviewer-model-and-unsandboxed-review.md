# Agent Note: 审批模型可配置与无沙箱执行的审批归属

Status: implemented

## Problem

1. **审批模型不可配置**：`auto_review` 已经存在，但 `AutoReviewer` 的模型调用用的是当前主模型，没有独立配置项，用户无法把"是否批准"这件事交给一个便宜、稳定、支持 JSON 输出的专用模型。
2. **审批器看不见"离开沙箱"**：`runAutoReview` 从未把 `unsandboxed` 传给 `ApprovalReviewRequest`，payload 里也没有该字段；同时 `routinePolicyReview` 与 `isAgentScratchPythonHelper` 两条"不经模型直接 `approve_once`"的快路径、以及 `PermissionPolicyStore` 的记忆批准，都会在无沙箱执行时静默放行。
3. **自动批准不可追责**：一次无沙箱执行若由模型批准，界面与 run 事件里都看不到"谁批的、用什么模型批的、这次是否离开沙箱"。

## Decision

### 1. 审批模型可配置（设置 + 面板 + 路由）

- 设置项：`stellarisLanguageServices.ai.approvals.reviewerProvider`（enum，含 `""` = 沿用主模型）与 `approvals.reviewerModel`（string，`""` = 用该 provider 默认模型），三语 nls 齐备。
- `PanelSettings.approvals` 扩展为 `{ reviewer?, reviewerProvider?, reviewerModel? }`；`chatSettings.ts` 负责读写。
- `resolveReviewerRoute(provider, model)`（`runner/autoReviewer.ts` 导出，纯函数）：provider 去空白为空 → `{}`（**model 即使非空也丢弃**，防止跨 provider 错配）；provider 非空 → `{ providerId }`；两者都有 → `{ providerId, model }`。
- `chatPanel.getAutoReviewer()` 的 `llmCall` **每次调用都读一次配置**并透传 `providerId`/`model` 给 `aiService.chatCompletion`，因此改设置无需重建 reviewer 或重启扩展宿主。
- 面板：设置页 Agent 区新增 `approvalsReviewerProvider`（下拉，首项"沿用主模型"）+ `approvalsReviewerModelInput`/`approvalsReviewerModelDatalist`（输入 + 候选，沿用 `setupApDropdown` 与 `settingsData` 下发的 providers/ollamaModels，不引入第二套目录来源）；provider 为空时模型输入禁用并提示"继承对话模型"。

### 2. 无沙箱执行进入审批视野

- `ApprovalReviewRequest` 增加 `unsandboxed?: boolean` 与 `sandboxMode?: string`；payload 带 `unsandboxed`；system prompt 增加规则：`unsandboxed=true` 表示本次执行 OS 沙箱关闭、文件系统与网络不受强制约束，只有用户明确要求过这类操作时才可 `approve_once`，否则 `ask_user`；critical 恒 `deny`。
- 两条规则快路径在 `unsandboxed` 时失效（`routinePolicyReview` 返回 `undefined`、`isAgentScratchPythonHelper` 返回 `false`）；`unsandboxed` 决策**不读不写缓存**（`cacheable = !inlineEval && unsandboxed !== true`）。
- 审批漏斗（`chatPanel.requestPermission`）：`run_command` 的 `PermissionPolicyStore.isApproved` 记忆批准短路，在 `preflight.unsandboxed === true` 时跳过——沙箱内授予的同意不能授权同一条命令无沙箱执行。
- **保留的硬闸门**：`escalation` 或 `riskLevel >= 3` 仍强制 `ask_user`。因此模型主动申请的 `unsandboxed=true`（带 escalation）依旧由人决定，只有"无强制后端 → 自动降级"这条 `escalation=false` 的路径交给审批模型裁量。
- 边界不变：审批模型只判批准/拒绝，**不能扩大沙箱**；调用失败、超时、输出非法一律回落用户（fail-closed）。

### 3. 逐次可见

`reviewer_decision`、`permission_resolved` run 事件与 `permissionResolved` 面板消息都携带 `reviewerProvider`/`reviewerModel`/`unsandboxed`；`hostProtocol.ts` 的校验器放行这三个可选字段；时间线渲染为 `权限 · 已允许一次 · 自动审核 <provider>/<model> · 无沙箱执行`，字段缺失时回退到原来的 `reviewer` 文案。

## Alternatives considered

1. **单个文本框填 "provider/model"**：否决。解析歧义、无法用 enum 给用户提示，也无法复用既有 provider 目录。
2. **无沙箱执行一律 `ask_user`（不让审批模型接管）**：否决。用户明确要求把两类卡片都交给审批模型；这会把它重新变成纯人工弹窗。
3. **给 routine 快路径加 `unsandboxed` 条件而不是整体禁用**：否决。静态规则看不到无沙箱契约，"规则自动放行"等于把沙箱边界交给预置规则。
4. **缓存 `unsandboxed` 决策**：否决。无沙箱是每次新契约，缓存会把一次同意扩成后续静默执行。
5. **在 webview 侧自行维护 provider/model 目录**：否决。沿用 `settingsData` 下发的 providers/ollamaModels，避免两套目录漂移。
6. **不做可见性（只留日志）**：否决。自动批准的无沙箱执行必须事后可追责。

## Consequences

- **行为**：开启 `auto_review` 后，普通命令卡与"仅本次无沙箱运行"卡都由配置的审批模型先判；只有 `ask_user`（或调用失败）才落到卡片。
- **安全**：无沙箱执行永远需要一次显式同意——人或审批模型；记忆批准、规则快路径、缓存都不能代替；`escalation` 仍强制人工。审批模型不能扩大沙箱。
- **成本**：未命中规则快路径的每次审批多一次模型调用（主模型或配置的审批模型），计入 `approval_review` 辅助用量。
- **约束**：`reviewerProvider` 为空时 `reviewerModel` 被丢弃；配置按调用读取，改设置即时生效；`zh.json`/`zh-cn.json` 新增文案保持一致。
- **已知张力**：自由裁量意味着"是否允许无沙箱执行"的最终判断可能由审批模型给出，这依赖用户对所配模型与提示规则的信任；审计信息通过时间线与 run 事件保留。
- **验证**：`npm run compile` 0 error；`npm run typecheck:test` 0 error；`npm run test:unit` 3024 passing（含 `approvalBoundary` 新增 9 例：unsandboxed 走模型/不缓存/payload 断言/escalation 硬闸门/路由四条规则）；manifest 与三语 nls 的 %引用% 未解析数为 0。

> 本次改动把[无强制沙箱后端时的审批式降级](../architecture/2026-10-17-command-sandbox-degrade-with-consent-and-subagent-command-capability.md)里"离开沙箱必须由用户逐次同意"收紧为"必须有一次显式同意（人或审批模型）"，安全边界的最终裁定仍由 `escalation` 与 critical 风险闸门守住。
