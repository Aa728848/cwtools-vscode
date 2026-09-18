# Agent Note: 智能体工具调用模式 (PTC 与 NATIVE) 支持与子调用流式可视化

Status: implemented

## Problem

在 cwtools-vscode 现有的 Agent 架构中，可编程 `run_code` 仅作为众多暴露工具中的一个普通工具存在（属于混合模式）。在向模型发送请求时，所有可用的原生工具（通常多达 30 到 50 个）的 JSON Schema 会全量序列化并传入 API `tools` 载荷中。这种方式带来了显著痛点：

1. **庞大的 Schema Token 开销**：每次请求都必须携带海量工具的完整 JSON 定义，不仅每轮对话白白消耗数千 tokens，更降低了上下文窗口的有效利用率。
2. **缺乏专注性与执行折叠**：许多高级长输出模型面对几十个原生工具时，往往倾向于单步调用原生工具，无法充分发挥编写脚本进行批量筛选、循环迭代、有界并发的优势；而对于轻量级模型，混合暴露又造成了认知涣散。
3. **缺少对话生命周期状态管理**：无法像 DSH（DeepSeek Harness）那样在对话启动前自由选择 PTC 或 NATIVE 模式，并在首轮输入后将模式锁定，导致同一会话内工具上下文不一致。
4. **动态披露导致的冷启动死锁**：在开启动态工具披露（`dynamicToolDisclosure.enabled`）的默认配置下，若 `run_code` 为延后披露工具，首轮请求将无法提供 `run_code`，导致模型看到原生工具却在 PTC 守卫下全部被拒，形成死锁。
5. **脚本内部执行“黑盒”**：在脚本内部调用原生工具循环读取多个文件时，前端处于静默等待，用户无法实时感知脚本内部的每个具体子调用进度。
6. **模型 TypeScript 语法兼容性**：高级模型编写的代码常包含 `enum`、泛型声明、泛型调用及类型断言，纯 JS QuickJS 沙箱会因语法错误而拒绝执行。

## Decision

我们为 cwtools agent 完整设计并落地了 **PTC 模式（Programmatic Tool Calling）** 与 **NATIVE 模式（标准原生函数调用）** 的呈现分流系统，并深度对齐了 DSH 的语法擦除与子调用流式交互：

1. **类型与配置体系**：
   - 在 `client/extension/ai/types.ts` 中新增 `ToolPresentationMode = 'ptc' | 'native' | 'hybrid'`。
   - 在 `AIUserConfig`、`ChatTopic`、`AgentRunnerOptions` 与 `PanelSettings` 中持久化该模式。
   - 在 `release/package.json` 中注册 `stellarisLanguageServices.ai.toolPresentationMode`，并补齐多语言 NLS 条目。
2. **工具披露与投影保证 (`registry.ts`, `agentRunner.ts`)**：
   - 将 `run_code` 加入 `ALWAYS_DISCLOSED_TOOLS`，确保在开启动态工具披露的默认配置下首轮即永久可用，彻底消除 PTC 首轮死锁风险。
   - 实现 `projectModelFacingTools` 投影路由：
     - 在 `ptc` 模式下，大模型 API 载荷的 `tools` 仅保留唯一一个 `run_code` 工具，其余所有工具全部收敛为内部能力池；同时在 System Prompt 中注入 `PTC_ONLY_INSTRUCTION` 和工具 TypeScript SDK 定义。模型直接发起原生工具调用时被拦截并生成失败结果，由统一发射循环输出标准 `tool_result`，避免多重重复发射。
     - 在 `native` 模式下，过滤掉 `run_code`，仅向模型暴露标准原生工具 Schema，且不注入任何 SDK 提示词。
     - 在 `hybrid` 模式下，保留原有的混合共存行为作为兼容选项。
3. **QuickJS 代码沙箱深度类型擦除 (`runCode.ts`)**：
   - 全面增强 `stripTypeScriptTypes` 处理器：
     - 引入**字符串字面量遮罩池（String Masking Pool）**，转换前隔离所有单双引号与模板字符串，转换后无损还原，杜绝字符串内容被意外误伤；
     - 将 `enum` 枚举安全转换为 `Object.freeze({ ... })` 常量对象；
     - 剥离函数与调用的泛型参数（如 `function foo<T>(...)`、`tools.read_file<T>(...)`）；
     - 剥离非空断言（`!`）与多级类型断言（`as unknown as T`、`as const`）；
     - 剥离 `interface`、`type` 声明及变量与参数的冒号类型标注，同时保护对象字面量与三元运算符。
4. **子调用（Subcall）实时前端流式呈现与 I/O 节流 (`agentRunner.ts`, `codexActivity.ts`, `codexToolRows.ts`, `chatPanel.css`)**：
   - 在 `runNestedToolStep` 执行期间，每次发起内部工具调用时实时发射带有 `subcall: true`、`parentToolName: 'run_code'` 和独立 `invocationId` 的 `tool_call` 与 `tool_result` 步骤；
   - 优化 run ledger 写入：Subcall 步骤仅透传至前端用于流式展示，跳过每步的持久化磁盘 I/O，平滑高频并发压力；
   - Webview 侧活动流水线将其解析为 `[PTC] <工具名>` 独立活动项，修正双重缩进，并通过 CSS（`.codex-activity-subcall`）进行左侧强调线与微弱衬底高亮，实时直观展示脚本内部流水线进度。
5. **前端交互与生命周期控制 (`chatHtml.ts`, `chatPanel.css`, `chatPanel.ts`, `hostProtocol.ts`)**：
   - **输入框上方预选栏 (`#composerPreflightBar`)**：在对话尚未开始前（新话题 / 消息为空时），在 Composer 顶部显示模式选择器（PTC 模式 / NATIVE 模式），支持一键切换。
   - **首轮输入后自动消失与锁定**：一旦用户发送第一条消息或加载已有消息的话题，预选栏立即隐藏（消失不给选），模式随 Topic 绑定并锁定。
   - **顶栏状态徽章 (`#headerModeBadge`)**：在顶部话题标题旁常驻显示当前话题的工具模式，在对话开始后保持清晰可见的状态展示。
   - **协议与代码规整**：在 `hostProtocol.ts` 中将 `toolPresentationMode` 纳入 `loadTopicMessages` 校验器，修复 Webview `case` 语句块作用域，移除弱类型 `as any` 强转。

## Alternatives considered

1. **将沙箱替换为独立的 Node.js 操作系统子进程**：
   - 评估：模仿 DSH 运行外部 Node.js 进程。
   - 未采用原因：VS Code 扩展运行在各种用户环境中（没有全局 Node.js、受限容器、Web 等），且外部 Node 进程若无内核级沙箱则拥有全盘权限，安全性与兼容性远不如零外部依赖的 QuickJS/WASM 虚拟机。
2. **在对话过程中随时允许切换模式**：
   - 评估：允许用户在多轮对话中任意切换 PTC 与 NATIVE。
   - 未采用原因：工具呈现模式的改变会导致模型在同一话题中观察到的工具集合发生剧烈断裂，容易造成历史消息中的工具引用混乱（Tool Call ID 与角色映射不匹配），因此严格采纳了 DSH 的设计，在对话启动前确定模式并随话题锁定。

## Consequences

- 彻底消除动态工具披露机制下 PTC 模式的首轮不可用与死锁隐患。
- 大幅削减了 PTC 模式下的 API Schema Token 占用，每次往返减少海量输入开销。
- 实现了模型 TypeScript 语法的零报错运行与字符串字面量零污染。
- 彻底消除了 PTC 脚本执行期间的黑盒感，用户可实时查看每个子工具调用的执行状态与耗时。
- 保证了与现有会话历史、工作流（Workflows）以及多 Agent 协作架构的完全向后兼容。
