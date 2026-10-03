# Agent Note: 规范化 Antigravity 模型别名、过滤编辑器专用模型并接入 Claude 5.5 目录

Status: implemented

## Problem

Antigravity 模型动态发现机制此前将运行时的内部 Pro 别名和仅供编辑器使用的 Tab 补全 ID 直接暴露在 Chat 模型选择器中。如果直接过滤后端 Pro ID，可能导致账号仅有的 Pro 入口被误删；而仅根据 Tab 模型名称无法确定其是否与现有 FIM（Fill-In-the-Middle）代码补全接口兼容。

Google Antigravity 后续上线了 Claude Opus 5.5 与 Claude Sonnet 5.5，需要在不臆测网关参数的前提下把这两款模型接入 `client/extension/ai/antigravity/models.ts` 的目录与运行时分档。

## Decision

1. **模型别名规范化与过滤**：在去重之前，将 Gemini 3.1 Pro 运行时别名统一规范化，并过滤所有以 `chat_` 和 `tab_` 开头的内部条目。
2. **统一配置项名称**：AI 配置中心在保存所选模型时对外暴露规范的 Pro 命名。运行时推理分档（reasoning mapping）保持原有逻辑。
3. **空目录回退保护**：当账号有效但没有可用的 Chat 模型时保持为空，不再盲目回退到硬编码的默认广告目录。
4. **测试与文档解耦**：原生 Tab 补全协议调研与编辑器集成在独立笔记 `../feature/2026-09-06-antigravity-tab-editing.md` 及 `docs/antigravity-tab-protocol.md` 中记录。
5. **回归测试覆盖**：覆盖仅含别名发现、去重机制、内部及 Tab 过滤、纯编辑器账号目录、Provider 作用域内的选中模型规范化，以及 5.5 的兜底目录条目、基 ID 直通、发现结果的原样透传与强制工具选择的既有形态。
6. **Claude 5.5 目录与 ID**：`ANTIGRAVITY_MODELS` 新增 `claude-opus-5-5` 与 `claude-sonnet-5-5`，紧邻既有 `claude-opus-4-6` / `claude-sonnet-4-6`。该常量是**离线或目录刷新失败时的兜底目录**（`oauthService.ts` 的 `getAccountStatus` 在未登录、刷新失败时回落到它），只要 `fetchAvailableModels` 成功返回，发现结果就整体胜出。
7. **5.5 运行时 ID 直通**：`antigravityRuntimeModel` 不为 5.5 追加任何后缀，`claude-opus-5-5` / `claude-sonnet-5-5` 原样下发。网关侧是否存在 `claude-opus-5-5-thinking` 形态**未经实测**：`claude-opus-4-6` 的 `-thinking` 契约来自旧版网关资料，而本机官方 Antigravity 2.19.1 的 `language_server.exe` 只内嵌基础 ID（`claude-opus-4-6`、`claude-opus-4-8`、`claude-opus-5-5`），不内嵌任何 `claude-*-thinking` 字面量，因此该后缀无法由本地官方 agent 佐证。
8. **输出上限保持保守**：`antigravityOutputTokens()` 对所有 `claude-` 前缀模型统一按 64K 截断；共享侧 `providers/models/capabilities.ts` 的 `getModelOutputTokens()` 在 antigravity 下直接复用同一函数，不存在第二份配置。5.5 原厂上限为 128K，但 Google 网关的真实上限未验证，故不在本次放开。
9. **强制工具选择维持网关形态**：`buildAntigravityRequest` 继续把 `tool_choice` 对象翻译为 Gemini 形状的 `functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [...] }`。原厂文档把 “forced tool use 返回 400” 描述在 Messages API 的 `tool_choice` 上；本项目走的是 Google 的 Gemini 形状封装并内部路由到 Vertex AI，是否存在同一约束**未验证**，因此不套用原厂参数，也不把 `ANY` 悄悄降级为 `AUTO` 以免改变用户语义。对应用例只锁定这一既有形态，不代表官方支持该组合。
10. **套餐与退役事实归 README**：5.5 的套餐门槛与旧款 Claude / GPT-OSS 的退役日期属于用户可见事实，单源写在 `README.md` 的 Antigravity 段落（含官方可用性表链接），本笔记只引用不复制。

## 证据来源

| 事实 | 来源 |
| --- | --- |
| Antigravity 提供 Claude Opus 5.5 / Sonnet 5.5（thinking），及套餐矩阵、2026-11-02 退役标注 | <https://antigravity.google/docs/models> |
| 原厂模型 ID `claude-opus-5-5` / `claude-sonnet-5-5`，1M 上下文、128K 输出、Opus 默认 effort `medium` 且 thinking 常开、Sonnet 5.5 为 adaptive 且默认 `high` | <https://platform.claude.com/docs/en/models/opus-5-5/overview> 、<https://platform.claude.com/docs/en/models/sonnet-5-5/overview> |
| 原厂 breaking change：thinking 不可禁用、forced tool use 返回 400、thinking block 绑定模型与上下文 | <https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5> |
| Antigravity 网关为单一 Gemini 形状协议并内部路由到 Vertex AI/Gemini；`claude-opus-4-6-thinking` 与 `claude-sonnet-4-6` 是两个不同的运行时 ID | <https://github.com/cortexkit/antigravity-auth/blob/main/packages/opencode/docs/ANTIGRAVITY_API_SPEC.md> |
| 本机官方 agent 2.19.1 的 `language_server.exe` 内嵌 `claude-opus-5-5` 基础 ID | `%LOCALAPPDATA%\\Programs\\Antigravity\\resources\\bin\\language_server.exe` |

## Alternatives considered

- **直接丢弃 `gemini-pro-agent` 且不作映射**：否决。当后端仅返回该运行时 ID 时，会导致账号丢失 Pro 模型的可用选项。
- **依据 HTTP 200 响应盲目开启 FIM 补全**：否决。实际请求会返回未转义代码、后缀回显或错误预测，暴露出未经校验的兼容契约。
- **使用通用 Chat Prompt 进行代码补全**：否决。语义和框架校验不达标，应采用后续验证过的原生补全协议。
- **按 4.6 类比把 5.5 映射为 `claude-opus-5-5-thinking`**：否决。4.6 的后缀是旧版网关资料的历史契约，本机官方 agent 二进制与官方文档都只给出基础 ID，无法证明 5.5 沿用同一后缀。宁可直通基 ID 让网关给出明确错误，也不要用未验证的映射制造更难排查的失败。
- **提前删除 4.6 / GPT-OSS-120b 兜底项**：否决。官方标注的退役日期（见 README）尚未到期，提前删除会直接砍掉仍在服役账号的可用选项。
- **按原厂 breaking change 把强制工具选择降级为 AUTO 或直接报错**：否决。原厂文档描述的是 Messages API 的行为，Google 封装是否同约束未验证；无实测证据前既不改协议也不改用户语义。
- **把 5.5 输出上限提到 128K**：否决。网关侧未实测；且共享侧是直接复用 `antigravityOutputTokens()`，单边改这一个函数会同时影响所有 Claude Antigravity 模型，而不只 5.5。

## Consequences

- Chat 列表清晰展示单一的 Pro 选项，隐藏内部编辑器专用模型，同时完整保留基于思考档位的模型路由能力。
- Tab 代码补全与 Chat 目录彻底解耦，无需引入任何额外运行时依赖。
- 兜底目录中出现 5.5 **不代表**当前账号一定可用：静态兜底目录不按套餐过滤，实际可用性一律以登录后服务端返回的动态目录为准。
- 发现结果里的未知后缀（例如后端若返回 `claude-opus-5-5-thinking`）原样透传，既不改写也不臆造别名。
- 5.5 走基 ID 直通，若网关要求 `-thinking` 变体，会在真实账号上表现为调用失败；验证方式是在已登录的 Pro/Ultra 账号中选中 5.5 发起一次对话，观察是否返回模型未找到类错误。
- **未落地的审计后续项**：官方 Antigravity CLI 变更日志对重试退避（retry delay ≤ 30s）与日额度快速停止有约定，而本项目 `antigravity/api.ts` 仅实现了 429 端点 failover，没有解析 `retryDelay`。跨层重试属于独立改动，本次不宣称已与官方 agent 全量同步。