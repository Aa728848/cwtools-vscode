# Agent Note: `/skill` 斜杠直呼（Skill 斜杠入口与 allowed-tools 策略预装）

Status: implemented

## Problem

Agent Skill 只能由模型自己调用 `run_skill` 加载：技能名与描述出现在系统提示的索引里，正文要等模型判断「相关」后主动调工具。用户已经明确知道自己要哪个技能时，必须先打一轮模型、指望模型选中正确技能并记得调用 `run_skill`，多一次往返且不可靠。当时并存的 AI Workflow 子系统用动态命令（`/workflow:<id>`）提供过「静态表 + 动态条目」的先例，但那条路径依赖 webview 侧合成命令，技能侧没有等价入口。

> 后续变更：[移除 AI Workflow 子系统](../simplification/2026-10-14-remove-ai-workflow-subsystem.md) 删除了 `/workflow:<id>`，上面的「先例」已不复存在。本笔记的决策不依赖它——Host 侧合成动态命令的理由是「webview 不做文件 I/O，拿不到技能清单」，这一点独立成立。

技能系统的多根扫描与优先级由 [SKILL 与 MCP 支持 home 目录外部配置](./2026-10-13-home-dir-skills-and-mcp-config.md) 拥有，`save_skill` 的写入面由 [save_skill 模型可见工具](./2026-10-13-save-skill-tool.md) 拥有；本笔记只拥有「斜杠入口 + 策略预装」这一层。

## Decision

### 1. 命令形态：一个静态 `/skill` + 每技能一条 `/skill:<name>`

`client/extension/ai/slashCommands.ts`：

- `SlashCommandDescriptor.category` 联合新增 `'skill'`（:14）；`SlashCommandId` 新增 `'skill'`；`DEFINITIONS` 新增 `/skill`（:136-141），取 `risk:'safe'`、`duringRun:'immediate'`、`argumentMode:'required'`、`completion:'execute'`、`acceptsColonArgument:true`。`/skill` 对补全是「执行」而不是「插入」，与 `/side`、`/status` 同型：用户选中即真正起一轮。
- `getSlashCommandDescriptors(locale?, skills = [])`（:251-268）签名扩展为可选第二参，返回「静态表 + 动态 `/skill:<name>` 条目」。第二参缺省时行为与旧调用点逐字节等价，因此既有测试与提示建议（`suggestSlashCommands`）不受影响。
- `buildSkillSlashDescriptors`（:218-248）把已安装技能展开成目录行。名字过不了 `SKILL_COMMAND_NAME = /^[A-Za-z0-9._-]+$/`（:73）的一律不生成条目：带空格或冒号的名字在 `/skill:<name>` 里会被解析器拆成「名字 + 参数」， advertise 出来的命令将无法原样复现。SKILL.md 是不受信输入，目录行只做展示。
- 技能描述同样按不可信输入处理：压成单行并截到 160 字符。目录行直接展示 `listSkills` 解析出的描述，不再对 YAML 折叠标量字面量做降级：`parseFrontmatter` 现已支持 `description: >-` 等块标量（Owner：save_skill 笔记「frontmatter 解析支持块标量」），`YAML_BLOCK_SCALAR` 这层展示层绕过已随之撤除——它只遮得住弹窗，遮不住系统提示的技能索引。

### 2. 解析：`/skill` 的名字与参数分开

`ResolvedSlashCommand` 新增 `skillName?: string`（:192），`argument` 的语义对 `/skill` 收窄为「仅技能参数」。`splitSkillInvocation`（:203-211）只对 `id==='skill'` 生效：按首个空白切分，第一段是名字，其余是参数；其余命令保持「命令 token 之后的全部文本」这一通用语义不变。

因此两种形态解析到同一结果：

| 输入 | definition.id | skillName | argument |
| --- | --- | --- | --- |
| `/skill release-extension` | skill | `release-extension` | `''` |
| `/skill:release-extension` | skill | `release-extension` | `''` |
| `/skill:stellaris-rules-sync foo` | skill | `stellaris-rules-sync` | `foo` |
| `/skill` | skill | `undefined` | `''` |

名字大小写原样透传给 `loadSkill`，匹配规则（大小写不敏感精确匹配）仍由 `loadSkill` 单点拥有，解析层不复制。

`handleSlashCommand` 的 needsInput 判据改为 `!resolved.argument && !resolved.skillName`（chatPanel.ts:2942）——对 `/skill` 而言名字字段同样算「已提供参数」，对其他命令语义不变。`/skill` 无参因此仍回 `needsInput`，用法串取 `/skill` 的 argumentHint（`<skill-name> [arguments]` / `<技能名> [参数]`）。

### 3. 目录下发：Host 侧合成，webview 零行为改动

命令目录由唯一的方法 `sendSlashCommandCatalog(send)` 下发（`chatPanel.ts:2863`），它调 `slashCommandCatalog()`（:2853），后者把 `listSkills` 的结果映射成 `SkillSlashCatalogEntry[]`（:2867）再交给 `getSlashCommandDescriptors`。`slashCommandList` 载荷在全仓库只在此处组装一次。

引导期两处调用：`_restoreViewState`（:393）与 ready 同步 `_syncViewChromeState`（:568），两处都把自己的 `send` 传进去以定向 surface；缺省参数则是 `this.postMessage`。

`skillSlashCatalogEntries` 复用 `this.agentRunner.toolExecutor` 上的 `workspaceRoot/globalStoragePath/extensionPath`，加 `getCwtoolsHomeDir()`，与 `runSkill` 的 `loadSkill` 根完全一致——斜杠入口与 `run_skill` 因此看到同一个技能宇宙，不可能一边有一个一边没有。`listSkills` 抛错时降级为静态表并 `ErrorReporter.warn`，不打断命令弹窗。

`client/webview/chat/slashCommands.ts` 只把 `SlashCommandView.category` 联合加上 `'skill'`（:12）。`buildSlashCommands` 把 Host 下发的**任何**顶级命令纳入补全、`filterSlashCommands` 不看 category，所以 webview 补全自动生效，无需改协议、无需改渲染。

> 后续变更：`buildSlashCommands` 的签名已由 `(hostCommands, workflows)` 收窄为 `(hostCommands)`——`workflows` 参数用于合成 `/workflow:<id>` 条目，随 AI Workflow 一起删除。该函数现在只保留「按命令名大小写不敏感去重」这一真实不变量，`chatPanel.ts` 的调用点与 `chatModels.test.ts` 同步更新；Host 侧合成动态 `/skill:<name>` 条目的决策不受影响。

#### 3.1 热刷新：技能集合一变就重发目录

补全目录过去只在引导期下发，于是会话中途 `save_skill`（或设置页安装/删除）之后，已经打开的命令弹窗仍按旧目录补全，必须重开面板。现在三条会改变技能集合的路径都重发一次目录，全部挂在同一个 `sendSlashCommandCatalog` 上：

| 触发点 | 回调 | 装配点 | 触发位置 |
| --- | --- | --- | --- |
| `save_skill` 成功 | `AgentToolExecutor.onSkillSaved`（agentTools.ts:454） | `chatPanel.ts:297`（与已删除的 `onWorkflowSaved` 同一装配位置，保留了这个写法） | `saveSkill` 的 `result.success` 分支 |
| 设置页 `installSkill` 成功 | `ChatSettingsManager` 第四参 `onSkillCatalogChanged`（chatSettings.ts:336） | `chatPanel.ts:292`（构造 `ChatSettingsManager` 时传入） | `chatSettings.ts:1837`，紧跟 `skillInstallComplete` |
| 设置页 `deleteSkill` 成功 | 同上 | 同上 | `chatSettings.ts:1870`，紧跟成功提示 |

约束：回调只在真正成功后才触发——`save_skill` 走 `result.success` 分支，`install`/`delete` 走各自成功路径；executor 的拒绝（重名未 `overwrite`、未知 `allowed_tools`、缺 `scope`）、`installSkill` 的 catch、`deleteSkill` 的 catch 与「无可删目标提前返回」都不触发。重发只发 `slashCommandList` 一条消息，不碰调度状态、不切 mode。

`ChatSettingsManager` 的新参数是可选的第四参，既有 `new ChatSettingsManager(aiService, postMessageFn)` 两参调用点（`client/test/unit/chatSettingsSave.test.ts`）编译与行为均不变。

### 4. 起一轮正常 turn，技能正文进用户消息

`executeSlashCommand` 新增 `case 'skill'`（chatPanel.ts:3173-3175）转调 `runSkillSlashCommand`（:3295）：

1. `loadSkill(requestedName, <同上四根>, schedulingState.domainProfile)`。失败即 `emitSlashCommandResult(raw,'error',...)` 并列出 `availableSkills`（`loadSkill` 已经返回可用技能名，不额外扫盘）。
2. 正文包壳由 `skills.ts` 新增纯函数 `buildSkillSlashTurnBody(name, content, argumentsText)`（:250）生成，格式与 `run_skill` 返回的 `content` 一致：`<skill name="X">\n…\n</skill>`，有参数时追加 `<skill-arguments>` 块（JSON 文本）。放在 `skills.ts` 而非 `chatPanel.ts`，是为了让注入格式可被单测直接覆盖。
3. 该包壳 + 一行双语指令（`The user invoked /skill X. Follow the SKILL.md above for the current task.` / `用户调用了 /skill X。请按上面的 SKILL.md 执行当前任务。`）作为 `handleUserMessage` 的**用户消息**提交，`displayText` 传原始命令串，于是用户在聊天里看到的是 `/skill release-extension` 而不是几万字正文。

该路径不切 task mode、不改 domain、不改权限档：它只是又发了一条普通用户消息。附件拦截语义完整保留——`/skill…` 由 composer 拦截器（`handleComposerSubmission` 的 `startsWith('/')` 分支）先拦下带附件的情况，注入后的 prompt 以 `<skill` 开头，也不会二次进入斜杠路由。

### 5. allowed-tools 收窄：与 `run_skill` 完全同一套

这是本变更的核心难点，机制如下（**注册点、键、清除时机**）：

- **注册点**：`agentRunner.run()` 内，`runId = runRecord.runId` 之后、Agent 循环之前（agentRunner.ts:1317-1333）。这是第一个「runId 已知且还没有任何工具能执行」的位置。
- **注册方法**：`AgentToolExecutor.preloadSkillPolicy(runId, name, domain)`（agentTools.ts:2965）。内部重新走一次 `loadSkill`（同四根 + 同 domain），取出 frontmatter 的 `allowed-tools`，交给私有 `mergeSkillPolicy`（agentTools.ts:2924）。
- **键**：`run:<runId>`，与 `getSkillPolicyKey(context)` 对本 run 工具调用解析出的键完全一致（工具上下文在 agentRunner.ts 的 `agentToolContext.runnerOptions.runRecord` 上带着同一个 runRecord）。
- **清除时机**：既有 `clearSkillPolicyForRun(runId)`，在 `run()` 的 `finally`（agentRunner.ts:1805 附近）调用，无需新增清理代码。
- **合并语义**：与 `run_skill` 一致——同一 run 上再加载第二个技能时取**交集**，绝不放宽；声明里出现注册表外的工具名则拒绝武装。`mergeSkillPolicy` 是从原 `runSkill` 内联逻辑原样提取的私有函数，`runSkill` 改为调用它，**语义与返回结构不变**（同一份交集算法、同一个 `ACTIVE_SKILL_POLICY_LIMIT = 64` 的淘汰顺序、同一句报错文案）。
- **不报错的情形**：技能没有声明 `allowed-tools` 时 `reason:'no-allowed-tools'`，此时收窄为零、不做任何事，属正常，runner 不打日志；其余 `unknown-skill` / `unknown-tool` / `empty-request` 会 `ErrorReporter.warn`，因为那意味着用户看到的技能约束实际上没有生效。

新增选项 `AgentRunnerOptions.preloadedSkillName`（agentRunner.ts:722）是 Host→runner 的唯一通道。它**不进入 `AgentResumeState`**，所以断点续跑/恢复不会继承一个已死 run 的策略，用户重发一次 `/skill` 即可——这是刻意的保守选择（resume 面不扩大），已写入选项注释。

已知的不确定点：若当前话题存在活跃 durable goal 且本轮被 `agentRuntime` 判为 `goal_continuation`，runner 收到的 `runnerPrompt` 是目标续跑文本而不是技能包壳，但 `preloadedSkillName` 仍在 options 里，于是该续跑步会被技能策略继续约束。语义上可接受（技能约束本就该在朝目标的持续工作中保持），但正文并没有在该步重现，故只记为已知偏差，未加特判。

### 6. 类型

`types.ts` 新增 `SkillPolicyPreloadResult`（:2328）描述「是否武装成功 / 生效技能名 / 生效工具集 / 未武装原因 / 日志细节」。它是跨文件契约（agentTools 返回、agentRunner 判读），不是持久化状态，与 resume 版本号无关。

## Alternatives considered

1. **只在 webview 侧合成 `/skill:<name>` 命令**：否决。webview 不做文件 I/O，拿不到技能清单，合成出来的命令还得把名字回传 Host 再解析一遍，等于把同一份技能宇宙维护两遍。Host 侧下发后，webview 只需扩一个 category 联合类型，补全零改动。
2. **让模型自己再调一次 `run_skill`**（即只注入一句「请调用 run_skill 加载 X」）：否决。这正是本变更要消除的往返——模型可能忽略、改名或选错技能，用户点名的意图没有被确定性地执行。而且工具收窄会在模型调用之后才发生，首个模型步已经跑完了。
3. **把预载策略挂在 `thread:<topicId>` 上**：否决。`thread:` 键会跨 run 存活，而正文只在被注入的那一轮存在，两者生命周期不匹配；一旦续跑/并发就会在没有正文的轮次上残留收窄。`run:` 键随 `finally` 清理，生命周期严格对齐。
4. **把包壳拼装留在 `chatPanel` 私有方法里**：否决（对本次是「否决前一版设计」）。`chatPanel.ts` 依赖 `vscode`，单测只能靠 stub 整个模块图才能加载；把纯格式函数放进无依赖的 `skills.ts`，让「注入内容含 `<skill name=…>` 与正文、截断生效」可以被直接断言。
5. **在本次变更里顺带修 `parseFrontmatter` 的折叠标量 `>-`**：否决（仅限本次边界，`skills.ts` 当时只允许新增纯 helper），避免把一个技能索引语义变更混进入口变更。当时选的折中「只在目录展示层绕过 `>-`」后来被证明不完整——展示层遮得住弹窗、遮不住系统提示的技能索引——因此该修复最终落在 frontmatter 解析层（Owner：save_skill 笔记），展示层绕过同时撤除。
6. **给 `/skill` 增加 `visible:false`、只暴露 `/skill:<name>`**：否决。用户需要 `/skill <name>` 这个可发现的单一入口（简报明确要求两种形态共存），且 `/skill` 无参时的 `needsInput` 本身就是使用提示。

## Consequences

- 用户可直接 `/skill release-extension` 或 `/skill:release-extension`（也可 `/skill:<name> <args>`）起一轮按该技能规范执行的 turn，无需模型先「选择」技能。
- 会话中途保存、安装或删除技能后，命令弹窗立即看到新的 `/skill:<name>`（或立刻失去它），不必重开面板；三个触发点共用同一份重发实现，新增触发点只需再调一次 `sendSlashCommandCatalog`。
- 斜杠路径与 `run_skill` 共享同一份技能查找、大小写匹配、域过滤、正文截断与 `allowed-tools` 收窄/交集语义；两个入口不会出现「一个收窄了另一个没收窄」。
- 命令弹窗会随已安装技能增长。目录构建是每次下发时重新 `listSkills`，与系统提示构建同量级开销；若将来技能数变多，可复用 `skillsDirectorySignature` 做缓存。
- 既有 `getSlashCommandDescriptors(locale)` 调用点（`handleSlashCommand` 的 argumentHint 查询、`suggestSlashCommands`）未传第二参，行为不变。
- 弹窗行的描述与解析层同源：Kimi 风格 `description: >-` 的技能现在显示真实描述（换行压成空格、截到 160 字符），与系统提示的技能索引不再出现分叉。

## 验证契约

- `npm run typecheck:test`：改动前后均 exit 0、无输出（基线先跑过一遍确认不是既有报错）。
- `npx ts-mocha -p tsconfig.json client/test/unit/chatModels.test.ts`：39 passing（基线）→ 44 passing。新增 5 条覆盖：两种形态解析同定义、`/skill:<name> foo` 的 argument 为 `foo`、非 skill 命令的 argument 不受影响、目录含 `/skill` 与各 `/skill:<name>`（含 zh 本地化、不可解析名过滤、重名去重、`>-` 降级）、webview `buildSlashCommands`/`filterSlashCommands`/`renderSlashCommandItems` 对新 category 无回归。（该套件此后又因 AI Workflow 移除而调整：workflow 模型 helper 套件整段删除，`buildSlashCommands` 的目录用例改断言 `/compact` 与 `/status` 的本地化描述。）
- `npx ts-mocha -p tsconfig.json client/test/unit/skills.test.ts client/test/unit/saveSkill.test.ts`：与基线一致（未新增用例）。原验证命令中的 `workflowRegistry.test.ts` / `workflowViewModel.test.ts` 已随 [移除 AI Workflow 子系统](../simplification/2026-10-14-remove-ai-workflow-subsystem.md) 一并删除。
- 新增 `client/test/unit/skillSlashCommand.test.ts`（9 passing）：正文注入与截断、`<skill-arguments>`、未知技能列出可用名、大小写不敏感匹配；`preloadSkillPolicy` 武装后 `write_file` 被 `skillPolicyDenied` 拒绝、与后继 `run_skill` 取交集、run 隔离、`clearSkillPolicyForRun` 后解除、四种未武装原因。
- 全量 `npx ts-mocha -p tsconfig.json "client/test/unit/**/*.test.ts"`：2937 passing / 1 failing。唯一失败是 `claudeSubscription.test.ts` 的「probes forward from the registered callback port」（`No free local port for the Claude sign-in callback`），与本变更无关：`client/test/unit/claudeSubscription.test.ts` 与 `client/extension/ai/claudesub/` 在 `git status` 中均无改动（仍是 HEAD 原状），单独运行该文件同样 28 passing / 1 failing，属运行环境没有可用本地 TCP 端口的既有缺陷。
- 新增 `client/test/unit/skillCatalogRefresh.test.ts`（7 passing）：`save_skill` 成功重发一次且重算目录含 `/skill:<name>`，三类失败（重名冲突/未知 `allowed_tools`/缺 scope）不重发；设置页安装后目录出现、删除后目录消失，两次成功各重发一次；`installSkill` 的 catch 与 `deleteSkill` 的空目标提前返回、抛错的 catch 都不重发；`ChatSettingsManager` 两参构造行为不变；最后一条源码契约用例锁定「`slashCommandList` 载荷只组装一次、两个引导点与两个回调都接到同一个 `sendSlashCommandCatalog`」（面板依赖 `vscode`，无法在单测里加载整个模块图，沿用本仓库既有的面板源码文本契约写法）。
- 真实路径实测（临时在 `<ws>/.agents/skills/` 建带 `allowed-tools` 的技能，验完按名删除）：`/skill release-extension` 与 `/skill:release-extension` 都产出首行 `<skill name="release-extension">`、正文 4263 字符、未截断；`preloadSkillPolicy` 返回 `applied:true, allowedTools:['list_directory','read_file']`；同 run 的 `write_file` 返回 `skillPolicyDenied:true` 且 `allowedTools:['list_directory','read_file']`；`clearSkillPolicyForRun` 后不再受限。