# Agent Note: save_skill 模型可见工具（AI 自保存 Agent Skill）

Status: implemented

## Problem

Agent Skill 只能由用户手工放置文件或经设置面板从外部安装，AI 在会话中沉淀出的可复用流程无法落成技能；当时并存的 `save_workflow` 只覆盖 AI Workflow 面，技能面没有对应的模型可见写入工具。技能系统本身的多根扫描与优先级由 [SKILL 与 MCP 支持 home 目录外部配置](./2026-10-13-home-dir-skills-and-mcp-config.md) 拥有。

> 后续变更：[移除 AI Workflow 子系统](../simplification/2026-10-14-remove-ai-workflow-subsystem.md) 已删除 `save_workflow` 及其整条接线。本笔记所有「对照 `save_workflow`」的表述随之失效，但**决策本身不变**：`save_skill` 是现在唯一的模型可见技能沉淀入口，其每一层接线（home 目录、`onSkillSaved` 热刷新、plan 模式放行、general 域守卫、`SUB_AGENT_EXCLUDES`、`FILE_SCOPED_WRITE_TOOLS`、`getAgentToolTargetFiles` 不上报目标路径）在该变更中一行未改。

## Decision

### 1. 写入器 `skillsWriter.ts`

新增 `client/extension/ai/skillsWriter.ts`（纯 `fs/path` + `homeConfig` + `skills` 类型，不依赖 `vscode`，单测直接加载），导出 `saveSkill(options)`：

- 校验：`name` 小写化后必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`；`description` 必填且 ≤500 字符；`body` 必填且 ≤`SKILL_BODY_CHAR_LIMIT`（30000，从 `skills.ts` 导出复用）；`capabilityDomain` 只接受 `general|paradox|both`。
- 保存路径：`scope: 'project'` → `<workspaceRoot>/.agents/skills/<name>/SKILL.md`（Kimi Code 项目技能约定目录，`listSkills` 已扫描、默认 domain `both`，外部 agent 亦可发现同一文件）；`scope: 'user'` → `<homeDir>/skills/<name>/SKILL.md`（`homeDir` 缺省取 `getCwtoolsHomeDir()`，测试可注入）。`.cwtools/skills` 保持为 paradox 域限定的扫描源，不作为保存目标。project scope 要求 `workspaceRoot` 已存在。
- 防穿越：名称正则已排除路径分隔符，仍做 `path.resolve` 后 `path.dirname(skillDir) === resolvedRoot` 的纵深校验。
- 冲突：目标已存在且 `overwrite !== true` → 返回 `{ success:false, alreadyExists:true }`。
- 原子写：`mkdir -p` 后写 `.<name>.SKILL.md.<pid>.<ts>.tmp` 再 `renameSync`，失败清理 tmp；UTF-8 无 BOM；写前回调 `onBeforeWrite(filePath, previousContent)`（当时与 `saveProjectWorkflow` 共用同一快照链；后者已删除，该回调现在是技能写入的唯一切入点）。
- frontmatter 生成：`name` / `description` 必填，`capability-domain` / `run-as` / `allowed-tools` 按需追加；值一律单行双引号转义形式。写入侧保持单行是刻意的稳定选择：读取侧 `parseFrontmatter` 现在也接受 YAML 折叠/字面块标量（见 Consequences），单行写法仍然两侧兼容，且省掉一层块标量语义的耦合。

### 2. 技能索引缓存失效修复（promptBuilder）

`skills.ts` 的扫描根列表收敛为 `skillRootDirs()` 单一来源，并新增 `skillsDirectorySignature(roots)`：对每个根做 `readdirSync`（仅子目录名）+ 每个 `SKILL.md` 的 `mtimeMs:size`（stat，不读文件内容）。`promptBuilder.computeSkillsIndexHash` 的缓存校验从「stat 已知技能文件」改为该目录签名——旧实现看不到纯新增/删除（新保存的技能不会使冻结提示指纹失效），新实现下保存技能后下一轮系统提示构建即以 `skills_changed` 失效重算。hash 主体仍保留 per-file `mtimeMs:size`，因为 frontmatter 缺 description 时索引描述会从正文首行推导，纯正文编辑也必须换 hash。

技能索引是**文件系统投影**（`buildSkillIndexPrompt(roots)` 直接扫 `<cwd>/.agents/skills` 等根），因此它随检出物的技能集合变化。测试侧的两条约束：

- `client/test/unit/promptBuilderContext.test.ts` 的两条模式中立性断言（utility 模式提示不得出现 `Paradox|PDXScript|CWTools|CWT`）必须把技能索引一并剔除，否则开发者检出的技能描述（如本项目 `stellaris-rules-sync` 的说明含「CWT」）会决定断言结果。该套件通过 `require.cache` 替换 `skills` 模块把索引钉为空，并在 `withoutRepositoryInstructions` 中兜底剥掉 `\n## Installed Agent Skills\n` 起的尾部区块；
- 索引内容本身由 `skills.test.ts` 的端到端用例覆盖，不在模式模板测试里断言。

### 3. 工具全链路接线

> 写作时以 `save_workflow` 为对照逐层对齐；该对照工具已随 [移除 AI Workflow 子系统](../simplification/2026-10-14-remove-ai-workflow-subsystem.md) 删除，下列清单中 `save_skill` 的每一项仍然成立且是当前唯一来源。

- `tools/definitions.ts`：`save_skill` 定义紧随 `run_skill`；参数 `name/description/body/capability_domain/run_as/allowed_tools/scope/overwrite`，required 为 `name, description, body, scope`。
- `tools/registry.ts`：`AgentToolName` 联合、`TOOL_DOMAINS.save_skill='shared'`、加入 `EDIT`（自动获得 effect `workspace_write`、riskLevel 2、`per-file-write`、`isWrite`、mutating）、加入 `GENERIC_FILE_WRITE_TOOLS`（归入 `file_write` 披露组，确保所有 `workspace_write` 执行轮次默认自动披露 `save_skill`，无需模型盲猜工具名）、`SUB_AGENT_EXCLUDES`（子代理不可保存技能）、`FILE_SCOPED_WRITE_TOOLS`、`PLAN/EXPLORE/REVIEW/LOC/ORCHESTRATOR/SCRIPT` 各模式集显式列出、`GENERAL_SAVE_SKILL_SCHEMA`（general 域把 `capability_domain` 收窄到 `general|both`）。
- `runner/agentProfileCatalog.ts`：`explore`、`planner`、`reviewer` 内置 Profile 的 `tools` 白名单显式包含 `run_skill` 与 `save_skill`；`agentTools.ts` 的 `authorizationAllowsEffect` 门禁对 `save_skill` 放行（交由模式集与 `enforcePolicy` 的 `read-only` preset 守卫把关），使其在 `plan`/`explore`/`review` 模式下同样可用。
- `skills.ts` 与 `prompt/sections/modePrompts.ts`（`PROMPT_TEMPLATE_VERSION = 10`）：`buildSkillIndexPrompt` 与 `TASK_EXPERIENCE_USAGE_RULE` 明确声明保存/更新技能必须调用 `save_skill`，且工作区经验库（`experience.json` / `experience.md`）由宿主自动蒸馏管理，禁止直接用 `write_file`/`edit_file` 读写。
- `workspaceSandbox.ts` 与 `tools/fileTools.ts`：`SHARED_AI_STORAGE_SEGMENTS` 扩展为 `['project', 'skills', 'experience.md', 'mcp.json', 'hooks.json']`，且裸 `.cwtools` 与上述共享段在 `normalizeAgentWorkspacePath` 与 `resolveAiStorageAlias` 中均保持指向工作区 `<workspace>/.cwtools`，不再在启用私有 topic 存储时被误重写到 `workspaceStorage/.../topics`。
- `agentTools.ts`：`TOOL_TIMEOUTS.save_skill = 30s`；dispatch `case 'save_skill'`；handler 收窄输入（`allowed_tools` 逐项校验必须存在于 `TOOL_REGISTRY`）后调 `saveSkillFile`，成功时经 `context?.onStep` 发双语 thinking（`aiText`：「技能已保存：<name>（项目级/用户级），可用 run_skill 调用。」）；general 域守卫：禁止保存 `capability_domain: 'paradox'` 或声明 paradox 域工具的技能。
- 外围清单跟随：`planModeGuard` 显式放行、`runnerPolicy.NON_DELIVERY_WRITE_TOOLS`、`executePlanHandoff.NON_PROJECT_WRITE_TOOLS`、`autoReviewer.ROUTINE_WRITE_TOOLS`、`experienceStore.ACTION_TOOL_NAMES`。

### 4. 策略面：刻意不向策略引擎上报目标路径 + 通用写工具误写技能/经验路径的可恢复重定向

`getAgentToolTargetFiles` **不加** `save_skill` case。若上报：project scope 目标命中 `DEFAULT_PROTECTED_PATHS` 的 `.agents/**`（protected_path 硬拒、无升级通道），user scope 目标在 writableRoots（仅 workspaceRoot）之外（outside_writable_roots 硬拒、无升级通道），两个 scope 在默认 preset 下都会全灭。不上报目标后，`enforcePolicy` 走 `baseAction('ask')` → workspace_write 属 selfManaged → 放行，与 `save_memory` 等「专用窄写入工具自校验」同型；工具自身以名称正则 + resolve 目录约束限定写入面（只能写 `<skills根>/<合法名>/SKILL.md`），`.agents/**` 对通用写工具的保护不削弱。read-only preset（WRITE_LIKE 拒 edit）与受限模式（workspace_write+mutating 拦截）仍然生效。per-file-write 在无目标时退化取全局锁。

同时，当非 `read-only` preset 下模型误用 `write_file`/`edit_file`/`replace_lines` 直接写技能目录（`.agents/skills`、`.cwtools/skills`、`~/.cwtools/skills`）或宿主私有经验存储（`experience/<key>/experience.json`、`.cwtools/experience.md`）时，`enforcePolicy`（`isManagedSkillOrExperienceTarget`）拦截并返回 `recoverable: true` 的引导错误（提示改用 `save_skill`），`execute()` 不打 `policyDenied: true` / `terminalOutcome: 'policy_denied'`，从而避免整轮对话因 `Target '...' is outside the writable roots.` 直接中止。

### 5. MCP 面

`tools/generate-mcp-schema.cjs` 使用只读工具白名单，`save_skill` 不在其中；运行 `npm run generate:mcp-schema` 后 `submodules/cwtools-mcp` 零 diff，无需子模块提交。

## Alternatives considered

1. **project scope 写 `.cwtools/skills`**（最初简报方案）：被用户修订否决。`.agents/skills` 是 Kimi Code 的项目技能约定（本仓库 `.agents/skills/` 下即有实例），写入后本扩展与外部 agent 都能发现，实现互通；`.cwtools/skills` 保留为 paradox 域扫描源。
2. **收窄 `DEFAULT_PROTECTED_PATHS` 的 `.agents/**` 以豁免 `.agents/skills/`**：否决。保护 glob 是硬边界且无 allow 覆盖机制，收窄会同时放开 `write_file` 等通用写工具对 agent 治理目录的写入面；专用工具自校验的暴露面更窄。
3. **写入的 frontmatter 采用 Kimi Code 的 `description: >-` 折叠式**：否决，否决的只是**写入格式**。当初的理由是扩展的 `parseFrontmatter` 是行式解析、会把折叠值读成字面量 `>-`；该读取缺陷已修复（见 Consequences「frontmatter 解析支持块标量」），本条不再因读不出而成立，但写入仍保持单行双引号值：它对扩展与外部 agent 的解析器都兼容，且不把写入格式绑到块标量语义上。
4. **允许子代理调用 save_skill**：否决，跟随当时 `save_workflow` 的既有 `SUB_AGENT_EXCLUDES` 策略（技能沉淀是主代理职责）。该排除项本身保留了下来。
5. **user scope 单独走审批卡**：否决。简报要求写策略与 save_workflow 保持一致（`onBeforeFileWrite` 快照、无额外审批）；`~/.cwtools/skills` 与 chatSettings 安装目录相同，信任级一致。

## Consequences

- AI 可在会话中把可复用流程沉淀为技能：保存后立刻被 `listSkills` 发现、经 `run_skill` 加载，并在下一轮系统提示构建时以 `skills_changed` 使冻结提示指纹失效（本变更顺带修复了纯新增技能不刷新指纹的既有缺陷，Owning Note 中「保持迟钝」的陈述已同步更新）。
- 设置 UI 的技能列表（`chatSettings.getSkillsList`）仍只扫 home 与 legacy 两个用户目录，项目级技能不出现在设置列表——可接受，与本变更范围一致。
- frontmatter 解析支持块标量（修复既有残余缺陷）：`skills.ts` 的 `parseFrontmatter` 当时是 SKILL.md 与 `.cwtools/workflows/*.md` **共享的解析层**（`workflowRegistry.ts` 直接调用它，没有第二份实现）。它识别 `>`、`>-`、`>+`、`|`、`|-`、`|+` 六种块标量头：折叠族把续行按空格连接（块内空行变成段落换行，比块缩进更深的行保留换行），字面族保留全部换行；块缩进取首个非空续行的缩进，块在遇到列 0 的行、比块缩进更浅的行、或 `---` 结束符时终止，其后的 key 各自独立解析。`-` / `+`（以及默认 clip）三种 chomping 不区分取值：读取结果统一去掉首尾空白与尾部换行，因为这些 frontmatter 只喂单值提示字段（技能索引、斜杠目录）。加引号的 `">-"` 仍是字面字符串。正文里的 `---` 只影响 body，不会被吞进块或截断 frontmatter。无 frontmatter、`endIndex < 0`、普通单行值（含去引号、大小写键归一）三类既有行为逐字节不变。AI Workflow 删除后 `parseFrontmatter` 只剩 SKILL.md 一个调用方，块标量语义与断言全部保留。
- executor 级测试无法覆盖 user scope（handler 固定走 `getCwtoolsHomeDir()`，测试不可写真实 home）；user scope 由 writer 单测以注入 `homeDir` 覆盖。
- 验证：`typecheck:test` 全绿；新增 `client/test/unit/saveSkill.test.ts` 14 条全过（writer 8 + executor 5 + 缓存失效 1）；`skills.test.ts`、`agentToolSafety.test.ts`（127 条合计）及 promptBuilder/planMode/runnerPolicy/toolScheduler/experienceStore/executePlanHandoff 等受影响套件全过；全量单测与 MCP schema 零 diff 见变更说明。块标量修复的验证：`client/test/unit/skills.test.ts` 新增 11 条（六种块标量头、块后仍有 key、块位于末尾、块内空行、CRLF、列 0 行与浅缩进终止、空块回退首行正文、带引号 `">-"` 仍为字面量、单行行为与两种 fallback 不变、索引真实描述）、`skillSlashCommand.test.ts` 新增 1 条（斜杠目录行带折叠描述且仍截到 160 字符）；`npm run typecheck:test` exit 0。另一处验证点 `workflowRegistry.test.ts` 新增 2 条（`getWorkflow` 读到折叠与字面 description）已随 AI Workflow 删除，这两个用例覆盖的解析行为现由 `skills.test.ts` 的 11 条单独承担。
