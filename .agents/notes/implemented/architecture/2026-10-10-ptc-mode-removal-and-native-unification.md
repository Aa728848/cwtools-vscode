# Agent Note: 移除 PTC（程序化工具调用）模式，统一为 NATIVE 标准函数调用

Status: implemented

## Problem

PTC（Programmatic Tool Calling）自 `2026-09-18-tool-presentation-mode-ptc-and-native.md` 落地以来一直是 `aiService.ts` 的默认呈现模式：模型可见面收窄为 `run_code`（外加豁免直连的 `ask_user_question`），其余 90 余个工具全部收敛为 QuickJS/WASM 沙箱脚本内的内部能力池。

该设计的收益只有一项——每轮省下原生工具 Schema 的 token；代价却由宿主长期承担，并在实际使用中持续暴露缺陷：

1. **工具结果在进入模型前被二次裁剪且不告知**。`budgetToolResult`（`contextBudget.ts`）在结果超预算时对 `matches`/`instances` 等数组按键去重与分段，模型看到的是被折叠后的样本，而 `totalMatches` 只统计成功入列的条数，没有任何字段说明真实总数。
2. **脚本会把失败当成数据继续跑**。`runCode.ts` 的 `runCodeToolSucceeded` 只把 `success === false` / `ok === false` / `status === 'error' | 'unavailable'` 判为失败；`run_command` 在沙箱后端缺失时返回的是 `{ stdout: '', stderr: '...沙盒不可用...', exitCode: 1 }`——既非 `success:false` 也无 `status`，于是脚本"正常返回"了一段错误文本，模型据此以为命令可用。
3. **运行时全部自研且缺陷密度高**。`runCode.ts`（508 行）+ `typeErasure.ts`（2618 行手写词法擦除器）仅 PTC 相关提交就有 10 次，而围绕它的修复记录包括类型擦除误伤对象字面量（`{ isRegex: false }` 被改写为 `{ isRegex }` 导致 `ReferenceError`）、沙箱入参只读属性报错、以及 `ask_user_question` 四道门同时关闭导致提问不可达。
4. **能力面残缺**。`RUN_CODE_BLOCKED_TOOLS` 使 `dispatch_agents`、`manage_process`、`write_design_blueprint` 等 16 个工具在 PTC 下根本不可达。

真正省 token 的机制是**动态工具披露**（`dynamicToolDisclosure.enabled`，`ALWAYS_DISCLOSED_TOOLS` 仅 7 项 + `select_tools` 按需披露），它与 PTC 无关，在 NATIVE 下同样生效。因此 PTC 的边际收益不抵其维护与缺陷成本。

## Decision

**彻底移除 PTC，只保留 NATIVE 单一调用路径**，并同步解耦全部关联代码与 UI。

### 1. 运行时删除
- 删除 `client/extension/ai/tools/runCode.ts`、`client/extension/ai/tools/typeErasure.ts` 与 `client/test/unit/toolPresentationMode.test.ts`。
- 删除 `run_code` 工具：`definitions.ts` 的定义对象、`registry.ts` 的 `AgentToolName`/`TOOL_DOMAINS`/`ALWAYS_DISCLOSED_TOOLS`/各 MODES 集合/`noFlatten`、`agentTools.ts` 的 `executeRunCode` 与 `case 'run_code'` 分派。
- 删除 `agentRunner.ts` 的 PTC 专属机制：`PTC_DIRECT_TOOLS`、`isPtcDirectCallBlocked`、`projectModelFacingTools` 的 ptc/hybrid 分支、直连拦截、SDK 提示词注入、`runNestedTool` / `runNestedToolStep` / `runCodeToolDefinitions` 接线。
- 删除 `effectiveToolPolicy.ts` 的 `run_code` 子代理能力分支、`agentProfileCatalog.ts` 与 `agentProfileSources.ts` 的 `runCode` 能力声明（含 `subagentRunCode` frontmatter 解析）。
- 移除 `package.json` / `release/package.json` 的 `quickjs-emscripten` 依赖，并同步两个 lockfile（`npm install --package-lock-only`）。

### 2. 类型契约与配置收口
- 删除 `ToolPresentationMode` 类型及其在 `AIUserConfig`、`ChatTopic`、`TopicSummary`、`TopicStats`、`PanelSettings`、`AgentRunnerOptions` 上的全部字段。
- 删除 `aiService.ts` 的 `toolPresentationModeOverride`、`setToolPresentationModeOverride` / `getToolPresentationModeOverride`、`normalizeToolPresentationMode`。
- 删除 `AgentToolContext.runNestedTool` / `runCodeToolDefinitions` 与 `AgentStep.subcall` / `parentToolName`。
- 删除 HostMessage 的 `quickChangeToolPresentationMode`、`loadTopicMessages.toolPresentationMode`、`setToolPresentationMode`，以及 `webviewProtocol.ts` 的对应校验器与 `chat/bridge.ts` 的分派分支。
- 删除 `release/package.json` 的 `stellarisLanguageServices.ai.toolPresentationMode` 配置贡献项，以及 `package.nls.json` / `package.nls.zh.json` / `package.nls.zh-cn.json` 三个文件各自的 4 条词条。
- `promptBuilder.ts` 的 `DEEPSEEK_SUPPLEMENT` 中删除指导模型使用 `run_code` 的整句；`PROMPT_TEMPLATE_VERSION` 6 → 7（提示词文本变更必须使冻结缓存失效）。

### 3. 界面删除（UI 与运行时同批协调）
- 删除输入栏的「工具调用模式」触发器 `#preflightModeTrigger` 与其下拉 `#preflightModeMenu`（含 PTC / NATIVE 两项及双语描述），以及 `setPreflightModeMenuOpen`、`currentToolPresentationMode`、`isToolPresentationModeLocked`、`updateToolPresentationModeUi` 与三组事件绑定。
- 删除设置面板的「工具调用模式」三选一下拉 `#toolPresentationMode` 与说明文字，以及 `chatSettings.ts` 的对应读写。
- 删除 `.composer-tool-mode-trigger` / `.is-locked`、`.codex-activity-subcall`、`.codex-subcall-pill` 三组 CSS 规则。
- **历史记录整体不渲染**：在 `codexActivity.ts` 的流水线入口新增 `isRetiredToolStep()` 并 `.filter()` 掉 `run_code` 步骤与 `step.subcall === true` 的子调用行。这是**有意的运行期兜底**——已持久化的旧话题里仍存有这些步骤，过滤谓词读取的是 webview 本地 `StepLike`，不依赖已删除的 `AgentStep.subcall` 类型。
- 删除 i18n 的 `activity.runScript` / `activity.subcallsCount`（interface + EN + ZH 三处同步）。

### 4. 旧数据兼容策略
`chatTopics.ts` 的 `readStoredTopic` 是**白名单式对象字面量重建**而非 `{...value}` 展开。移除 `toolPresentationMode` 的解析分支后，历史 JSON 里残留的 `"ptc"` / `"hybrid"` 键既不会被拷贝进 `ChatTopic`、也不会触发校验失败，并在下一次保存时自然消失。无需迁移脚本，无需写回。

## Alternatives considered

1. **仅把默认值改为 `native` 并隐藏设置项（停用而非删除）**：否决。保留了 3000+ 行自研运行时与 `quickjs-emscripten` 依赖，PTC 分支仍会在 `projectModelFacingTools`、直连拦截、能力池门禁处持续参与判定，属于"关掉开关但没解耦"，与本次目标（消除关联）相悖。
2. **保留 PTC 并只修上述 4 类缺陷**：否决。缺陷只是症状——根因是"把工具调用搬进一个有界沙箱"这一架构选择本身引入了结果裁剪、失败语义丢失、能力面残缺三类结构性问题，逐条打补丁不改变结构。
3. **迁移到 Kimi Code / DSH 等外部宿主，不再自研 agent**：否决（本次范围外）。迁移需要重写 94 个工具背后的全部 Stellaris 语义逻辑；且纯 MCP 出口只覆盖 36 个只读工具，会丢掉 `typed_pdx_write`、`candidate_transaction`、`find_scope_bridge`、`extract_archetype_slots` 等核心能力，属于能力倒退。
4. **只删代码不删 `release/package.json` 的配置贡献项**：否决。设置界面仍会展示「工具调用模式」且默认值指向已不存在的模式，形成"看起来还在、改了没反应"的静默失效。
5. **历史 `run_code` 行仅删样式、保留渲染**：否决。会渲染出没有 PTC 徽标与缩进语义的裸行，反而比隐藏更难理解；用户明确选择整体不渲染。

## Consequences

- **单一调用路径**：模型每轮直接看到原生工具 Schema，工具结果按原样进入上下文，不再经过沙箱与二次裁剪，`exitCode` 等失败信号不再被吞。
- **净删除约 3000 行**（`runCode.ts` 508 + `typeErasure.ts` 2618 + 各处接线），并移除 `quickjs-emscripten` 及其 5 个 `@jitl/quickjs-*` 传递依赖。
- **已知代价**：原生工具 Schema 每轮随请求发送。缓解机制是既有的动态工具披露（默认开启，首轮仅 7 个常驻工具），与 PTC 无关；本次未改动该机制。
- **旧话题安全降级**：含 `"ptc"` / `"hybrid"` 的历史话题正常打开，PTC 步骤在渲染前被过滤。
- **回归覆盖**：`executePlanHandoff.test.ts` 移除 `subcall` 双值循环（保留正文交接断言）；`vanillaGrepRootScope.test.ts` 的陈旧注释不再引用已删除的 `toolPresentationMode.test.ts`。
- **验证**：`npm run compile` 退出码 0；`npm run typecheck:test` 0 error；`npm run test:unit` **2793 passing / 0 failing**；`npm run lint` 0 error；`npm run check:release -- --skip-compile --skip-test` 通过（含 NLS key 三文件同步校验）。
- **未做**：没有为「含 legacy `toolPresentationMode` 的 JSON 被静默忽略」补一条专门的回归用例。该行为由 `readStoredTopic` 的白名单重建结构保证，并已由 `runLedger.test.ts` 的持久化往返用例间接覆盖（同一用例同时证明兄弟字段 `modeOverride` 仍正常往返）。
