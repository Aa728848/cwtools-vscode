# Agent Note: ~/.cwtools 用户级 providers / agent-models / CWTOOLS.md 指令注入

Status: implemented

## Problem

1. **provider 路由只有内置表一个来源**：`providers.ts` 的 `BUILTIN_PROVIDERS` 是编译期常量，用户想接私有 OpenAI 兼容端点（公司网关、自建代理）只能改代码；凭据只走 VS Code 设置或 SecretStorage，无法沿用 shell 环境里已有的 API key 环境变量。
2. **子代理模型覆盖只有设置一个来源**：`stellarisLanguageServices.ai.orchestrator.agentModels` 是 window 作用域设置，无法做到 Kimi Code / Claude Code 式的「用户级一份全局默认，项目设置按需覆盖」。
3. **个人编码偏好没有注入通道**：项目规则走 `CWTOOLS.md` / `.cwtools/rules`，但用户跨项目通用的个人指令（语言偏好、答复风格）没有落点，只能重复写进每个仓库。
4. 以上三者都必须照搬 [home-dir-skills-and-mcp-config](./2026-10-13-home-dir-skills-and-mcp-config.md) 已确立的模式（`homeConfig.ts` 唯一 home 入口、纯 fs/path loader、校验收窄 + warnings + mtime 缓存），严禁引入新后端或新配置目录。

## Decision

### 1. 新 loader：`client/extension/ai/providerConfig.ts`

纯 `fs/path` + `homeConfig`，不依赖 `vscode`，单测经 `os.homedir` 重定向直接加载。两个 loader 共用「JSON.parse try/catch（容错 BOM）→ 白名单校验收窄 → 非法条目跳过并收集 warnings → 永不 throw → 按 `mtimeMs+size` 缓存」的 mcpConfig 模式：

- **`~/.cwtools/providers.json`**：`{ "providers": { "<id>": { name?, endpoint, models[], defaultModel?, apiFormat?, apiKeyEnv?, requiresApiKey?, supportsVision?, maxContextTokens? } } }`。id 限 `[\w.-]{1,64}` 且**不得撞内置 provider id**（撞名条目跳过 + warning，保证内置永远优先）；endpoint 必须 http/https；`apiFormat` 枚举以 `release/package.json` 的 `customApiFormat` 为准；`apiKeyEnv` 限环境变量名正则 `^[A-Za-z_][A-Za-z0-9_]*$`。缺省：`requiresApiKey: true`、`supportsVision: false`、`maxContextTokens: 128000`、`supportsStreaming/supportsToolUse: true`、`toolCallStyle: 'openai'`、`supportsFIM: false`，`isOpenAICompatible` 按 apiFormat 映射（anthropic/gemini → false）。
- **`~/.cwtools/agent-models.json`**：`{ "agentModels": { "<role>": { provider, model } } }`。`__inherit__` 哨兵跳过；未知 provider 保留 + warning（provider 列表可后装）。
- `mergeAgentModelOverrides(settings, home)`：同名 role **home 整项覆盖**（不做字段级深合并），结果标注 `source: 'settings'|'home'`；`getAgentModelOverrides()` 为空时返回 `undefined` 以保持调用方 falsy 语义。

### 2. provider 路由接线

- `types.ts`：`AIProviderConfig` 新增可选 `apiFormatHint?: CustomApiFormat`（文件源的 apiFormat 落到这个字段，不改既有 `customApiFormat` 设置键语义）。
- `providers.ts`：`getProvider()` 先查 home 文件再回落内置表，最终未知 id 回落 openai 的语义不变；`getProviderApiFormat()` 开头优先读 home 条目的 `apiFormatHint`，其后才走 id switch 与设置。
- `aiService.ts`：凭据顺序 **options override > 环境变量（`apiKeyEnv` 字段，trim 非空才生效）> SecretStorage**；`getConfig()` 的 endpoint 改为 `settings 值（trim 非空）|| home 文件 endpoint`——home 端点只在设置未覆盖时生效，不做反向遮蔽。
- `agentTools.ts`：`dispatch_agents` 的 `builtinProviderIds` 放行集合并入 home provider id；两处 `agentModels` 裸读（另含 `agentRuntime.ts` 的 `configuredModels`）统一包 `getAgentModelOverrides()`。

### 3. 设置面板契约与保存守卫

- `chatSettings.ts` 新增 `SettingsProviderView`（`source: 'builtin'|'home'`、`apiKeyEnv?`）：providers 列表尾部追加 home 条目（`userEndpoint: ''`），`hasKeyMap` 对带 `apiKeyEnv` 的条目按环境变量是否存在计；`settingsData` 附带 `providerFileWarnings`；`orchestrator.agentModels` 下发合并值。
- **保存守卫**：`saveSettings` 在选中 home provider 时跳过 `providerEndpoints[id]` 与 apiKey 两块写回——webview 这些字段是只读展示，回写会把文件值复制进设置并造成「编辑文件静默无效」的陷阱（与 mcpFileServers 不同，这里字段混在同一表单里，守卫设在 host 侧双保险）。`handleDynamicModel` 对 home provider 天然 no-op（内置表查不到），未改。
- webview（`chatPanel.ts`/`chatHtml.ts`/`chatPanel.css`）：provider 下拉 home 条目加 `(~/.cwtools)` 后缀徽章；选中 home provider 时 endpoint/model/API key 输入框 readOnly、删除键禁用、warnings 渲染进 `providerFileWarnings` 提示区；agent-model 行对 `source: 'home'` 的 role 加 `.agent-model-home-badge` 徽章并禁用两个 select，保存收集器跳过这些 role（防止把文件值复制进设置——home 在合并中必胜，UI 覆盖本是死配置）。

### 4. `~/.cwtools/CWTOOLS.md` 用户级指令注入（promptBuilder.ts）

- `PROMPT_TEMPLATE_VERSION` 8 → 9（冻结提示指纹契约变更）。
- `parseHomeRules()` 读 `getCwtoolsHomeDir()/CWTOOLS.md`，mtime 缓存 + `invalidateProjectPromptInputs`/`clearFrozenPromptCache` 同步失效。
- 注入点：`getProjectRulesPrompt`（paradox 域）在**项目规则段之前**插入 `<user-instructions>`（上限 24000 字符）；`getSlimProjectRulesPrompt` 加 `<user-rules>`（12000）；general 域经 `getGeneralInstructionsPrompt()` 把 home 段与 repo 段拼接（`:334` 与指纹 `:586` 共用同一输出串）。slim general 不注入（任务未要求）。
- 指纹契约：paradox 改 `shortSha256(homeRaw + '\n' + rules.raw)`（两者皆无则 `'none'`）；general 把 home 段拼进被 hash 的输出串，保证 home 文件改动触发 `rules_changed` 失效。

## Alternatives considered

1. **home provider 覆盖内置同名条目**：否决。内置条目携带账号体系/订阅池等运行时接线（antigravity、claude-subscription），允许文件覆盖会出现「UI 显示内置、实际走路由文件」的混乱；撞名跳过 + warning 语义单调。
2. **agent-models 字段级深合并（provider 来自 settings、model 来自 home）**：否决。provider+model 是耦合对，拆开合并会产生不存在的组合；整项覆盖与 mcp server 合并语义一致。
3. **apiKeyEnv 解析后把 key 写进 SecretStorage 缓存**：否决。环境变量的价值就在于不落盘、可随 shell 轮换；每次 `getKeyForProvider` 现读 `process.env`，优先级高于 SecretStorage 但低于显式 options override。
4. **webview 允许编辑 home agent-model 行并按「设置覆盖文件」保存**：否决。合并方向是 settings < home，设置里的同名 role 永远不会生效，保存即死配置；禁用 + 跳过收集是唯一不自欺的 UI。
5. **CWTOOLS.md home 段注入到项目规则段之后**：否决。证据层级上用户个人指令应低于项目规则（项目规则可被视作对通用偏好的收窄），且指纹复用同一拼接串要求顺序固定，前插与 Kimi Code 的 user-memory 前置惯例一致。
6. **复用 mcpConfig.ts 直接加三个新字段**：否决。provider/agent-model 与 MCP 是不同域，合并会制造出同时依赖三方的巨型 loader；新建 providerConfig.ts 遵循同一模式但独立缓存与 warnings 通道。

## Consequences

- 用户获得三份与 Kimi Code / Claude Code 对齐的用户级配置：私有端点路由（`~/.cwtools/providers.json` + `apiKeyEnv` 环境变量凭据）、全局子代理模型默认（`~/.cwtools/agent-models.json`）、跨项目个人指令（`~/.cwtools/CWTOOLS.md`）。
- 优先级语义统一：provider **内置 > home 文件**（防覆盖）；agentModels **settings < home**（文件为全局默认的反向语义是故意的——任务契约如此，文件即最终裁决）；endpoint **settings > home**；凭据 **options > env > SecretStorage**。
- 安全边界：apiKey 永不由文件配置直接携带（只携带环境变量名），文件值不会因设置保存而被复制进 VS Code 设置；所有文件输入在边界校验收窄，非法条目只告警不中断。
- 缓存语义：三份文件均按 `mtimeMs+size` 缓存；CWTOOLS.md 改动经指纹触发 `rules_changed` 使冻结提示失效（PROMPT_TEMPLATE_VERSION 9，旧冻结缓存全部自然过期）。
- **已知取舍**：home 来源的 agent-model 行在设置 UI 只读，用户必须编辑文件才能改；`getHomeProviders()` 缓存未命中时每调用一次 `statSync`（仿 mcpConfig，设置面板全量渲染约数百次 statSync，可接受）。
- 验证：`npm run typecheck:test` 干净通过；目标单测 `providerConfig.test.ts`（26 条）+ `promptBuilderHomeInstructions.test.ts`（7 条）+ `webviewSmoke.test.ts` 新增契约断言（共 34 条）全过；批量既有回归（mcpConfig、skills、promptBuilderContext/Experience/Cache/Snapshot/Sprite、chatSettings 系列、agentToolSafety、orchestrator 等）391 条全过。
