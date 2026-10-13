# Agent Note: SKILL 与 MCP 支持 home 目录外部配置（~/.cwtools）

Status: implemented

## Problem

1. **SKILL 没有用户级公共目录**：用户 skill 只能装进扩展私有的 `globalStoragePath/.agents/skills`，路径深、随扩展存储迁移，与 Kimi Code / Claude Code 的「用户级配置放 home 目录」习惯不一致，也无法被其它工具共享。
2. **MCP 服务器只有单一配置源**：`stellarisLanguageServices.ai.mcp.servers`（VS Code 设置）。没有 Claude 风格的 `mcp.json` 文件配置，无法做到「用户级一份全局配置 + 项目级随仓库一份配置」。
3. **项目级配置的信任问题**：工作区内的 `.cwtools/mcp.json` 是不可信仓库输入（clone 即得）。若沿用既有「设置里启用即直通」的语义，恶意仓库可以借项目级配置让扩展自动 spawn 任意 stdio 命令。内联补全（`inlineCompletion.includeMcpContext`）更是一条完全没有审批面的自动连接路径。
4. 全仓没有统一的 home 配置目录抽象，`~/.cwtools/agents`（agent profile）是唯一直接拼接 `os.homedir()` 的先例。

## Decision

### 1. 唯一 home 路径入口

新增 `client/extension/ai/homeConfig.ts`：`getCwtoolsHomeDir()` = `path.join(os.homedir(), '.cwtools')`，附 `getCwtoolsHomeSubdir(name)`。所有 home 级配置（skills、mcp.json、以及未来的 agent profile）统一从这里解析。既有 `runner/agentRuntime.ts` 的 `~/.cwtools/agents` 拼接保持原样（不在本次范围内），新代码一律走 homeConfig。

### 2. SKILL 多根扫描与 home 根

`SkillLookupRoots` 新增可选 `homeDir`（`listSkills` 在 `homeDir` 缺省时跳过该根，保证测试确定性；生产调用点全部显式传 `getCwtoolsHomeDir()`）。扫描顺序即优先级（同名按小写名后扫覆盖先扫）：

| 优先级 | 目录 | source | 默认 domain |
|---|---|---|---|
| 低 | `extensionPath/resources/skills` | built-in | paradox |
| ↑ | `~/.cwtools/skills`（新） | user | both |
| ↑ | `globalStoragePath/.agents/skills`（旧，只读兼容） | user | both |
| ↑ | `workspaceRoot/.agents/skills` | project | both |
| 高 | `workspaceRoot/.cwtools/skills` | project | paradox |

旧 globalStorage 根不迁移、不删除，与 home 根并列扫描；同名冲突时仍按原优先级压过 home 根（保持兼容语义单调）。接线点：`promptBuilder.computeSkillsIndexHash`、`promptBuilder.getAgentSkillsPrompt`、`agentTools.runSkill`。skill 索引 hash 参与冻结提示指纹，新增根后指纹自动覆盖 home 技能。

`chatSettings` 的安装/列举/删除同步迁移：

- `installSkill` 目标改为 `~/.cwtools/skills`（先 `mkdir -p`）。本地目录拷贝直接落地；`npx skills add` 因 CLI 无法直接指定 `~/.cwtools/skills`，改为在临时目录中以 `npx skills add <source> -y -a universal --copy` 暂存（universal agent 布局 = cwd 下 `.agents/skills`，`--copy` 避免 symlink 悬空），再把产物拷贝进 home skills 目录并清理暂存。`source` 先经白名单正则（禁止 shell 元字符）才拼进命令——原实现直接插值，存在命令注入面。
- `getSkillsList` 同时列 home 与 legacy 两目录，`skills` 仍是字符串数组（协议兼容），另附 `skillSources: Record<name, 'home'|'legacy'|'both'>`。
- `deleteSkill` 对两个目录都可删（同名两处都在则都删），并用 `resolveSkillDir` 拒绝路径穿越名（原实现直接 `path.join`，可逃逸）。

### 3. MCP 文件配置（mcpConfig.ts）

新增 `client/extension/ai/mcpConfig.ts`（纯 `fs/path` + 类型级 `types` 导入，不依赖 `vscode`，单测可直接加载）：

- `loadMcpServerFileConfigs(workspaceRoot?)`：读 `~/.cwtools/mcp.json`（user）与 `<workspaceRoot>/.cwtools/mcp.json`（project）。Claude 风格格式 `{ "mcpServers": { "<name>": {...} } }`。按不可信输入校验：JSON.parse try/catch（容错 BOM）；根与 `mcpServers` 必须是对象；name 限 `[\w.-]{1,64}`；`type` 缺省时按有无 `url` 推断 sse/stdio；stdio 必须有非空 `command`，sse 必须有 http/https `url`；`args`/`env` 收窄到字符串（非字符串元素丢弃并告警）；未知字段按白名单忽略；`capabilityDomain` 缺省/非法补 `'both'`。非法条目跳过并收集 `warnings`，**永不 throw**。结果按 `mtimeMs+size` 生成 `version` 指纹并以 per-root Map（上限 8）缓存，重复调用只需两次 `statSync`。
- `mergeMcpServerConfigs(settings, home, project)`：同名后者整体覆盖前者（Map by name，不做字段级深合并），每条结果标注 `source: 'settings'|'home'|'project'`（`SourcedMCPServerConfig` 交叉类型，不改 `types.ts` 的 `MCPServerConfig`）。settings 条目原样通过（保留既有的 capabilityDomain 必填语义）。
- `mcpServerSource(server)`：把标注收窄回联合类型（无标注一律视为 `'settings'`）。

### 4. 接线与 project 源审批门

- `aiService.getConfig().mcp.servers` 改为三层合并结果（settings 为最低优先级，project 文件根用 `getProjectWorkspaceRoot()`）。
- `agentTools`：`getMcpClient`、`executeMcpTool`、`getDynamicMcpToolDefinitions` 全部改走 `getMergedMcpServers()`。连接池条目与动态工具缓存都纳入配置指纹：pool 按 server 配置 JSON 指纹失配即重建；动态工具缓存 key 增加 mcp.json `version`（文件改写立即失效，不再只等 5 分钟 TTL）。
- **审批接入点**：`executeMcpTool` 在既有 `evaluateMcpPermission`（server/tool 粒度规则评估，未命中即放行的「启用即直通」路径确实存在）与 domain 检查之后、首次连接之前，对 `source === 'project'` 的 server 执行 `ensureProjectMcpServerApproved`——以「名称 + 配置指纹」记录一次性批准（配置文件改动后需重新批准），主 agent 经 `context.onPermissionRequest` 弹审批卡（riskLevel 3，双语说明来自 `.cwtools/mcp.json`），sub-agent 或无审批面上下文直接拒绝。批准后清空动态工具缓存，让下一轮披露列出该 server 的工具。
- `getDynamicMcpToolDefinitions` 无审批面（披露阶段调用即会 spawn stdio），对未批准的 project 源 server 一律跳过；settings/home 源维持原行为。
- `inlineProvider.updateEnabled` 无任何审批面且会自动连接全部配置 server，明确过滤 `source === 'project'`（内联补全永远不用项目级 MCP）。stdio 继承环境的敏感变量剔除（`mcpClient.ts`）未改动。

### 5. 设置 UI 数据契约

`buildAndSendSettingsData` 中 `current.mcp.servers` 只下发 settings 源条目（逐条标注 `source: 'settings'`）。webview 的保存逻辑是从 DOM 块重建整个数组回写，若混入文件源条目会把它们复制进 VS Code 设置、且对文件源条目的编辑会被文件层静默遮蔽——因此文件源条目单独以 `mcpFileServers`（含 source 标注）随 `settingsData` 下发，`mcpConfigWarnings` 一并附带。消息对象用「加宽字面量 + const」模式携带协议外的额外字段（`fields()` 校验容忍未声明字段），不改 `types.ts` 的 `HostMessage` 联合。

## Alternatives considered

1. **把旧 globalStorage skills 迁移到 `~/.cwtools/skills`**：否决。安装/卸载脚本迁移用户数据有丢失风险；只读兼容 + 新安装落新目录即可平滑过渡，旧目录技能仍可列可删。
2. **webview 设置面板直接渲染合并后的全量 server 列表**：否决。webview 保存时从 DOM 重建全量数组回写 `mcp.servers`，会把 home/project 条目复制进设置并造成「编辑文件源条目静默无效」的陷阱；webview 侧本轮不可改，故采用 settings-only 编辑列表 + 附带只读 `mcpFileServers`。
3. **project 源 server 沿用「启用即直通」不做审批**：否决。`.cwtools/mcp.json` 随仓库分发，clone 打开即触发任意 stdio 命令执行，必须首连审批。
4. **`aiService` 不合并 project 层、只在 agentTools 合并**：部分采纳其安全动机但最终否决。任务契约要求 aiService 输出合并结果（设置 UI 需要展示三层来源）；真正的风险点在 inlineProvider 的自动连接，已用 source 过滤关闭，比让两个配置出口语义分叉更直观。
5. **引入 `@modelcontextprotocol/sdk` 重写客户端**：否决。自研 JSON-RPC 客户端（stdio+sse、30s 超时、env 剔除）已满足需求，更换依赖无收益且扩大回归面。
6. **`npx skills add -g` 借助 CLI 的全局模式安装**：否决。CLI 的 global 只会写到各 agent 自己的 home 目录（如 `~/.agents/skills`），没有 `~/.cwtools/skills` 映射；暂存 + 拷贝是唯一不依赖 CLI 内部行为的路径，且 `-a universal --copy` 让暂存结果确定、无 symlink。

## Consequences

- 用户获得与 Kimi Code / Claude Code 对齐的配置习惯：skills 装到 `~/.cwtools/skills` 全局可见；MCP 可以用户级一份 `~/.cwtools/mcp.json`、项目级随仓库一份 `.cwtools/mcp.json`；合并优先级 settings < home < project，每条 server 都带 source 标注。
- 安全边界：project 源 server 首连必审批（指纹变更重审）、未批准不参与动态工具披露、内联补全永不直连；文件配置在边界严格校验、非法条目只告警不中断；`npx skills` 插值命令注入与 deleteSkill 路径穿越两处既有缺口顺带关闭。
- 兼容性：旧 globalStorage skills 只读保留；settings 中的 MCP 配置语义（capabilityDomain 必填）不变；`HostMessage` 与 webview 协议零改动。
- 缓存语义：mcp.json 加载按 `mtimeMs+size` 缓存并使动态工具缓存失效；连接池按配置指纹重建。`computeSkillsIndexHash` 的缓存校验自 [save_skill 工具变更](../feature/2026-10-13-save-skill-tool.md) 起改用 `skillsDirectorySignature`（子目录名 + `SKILL.md` mtime/size 的 stat 签名），纯新增/删除技能也会使冻结提示指纹失效；本笔记此前「保持既有迟钝行为」的陈述随之作废。
- **webview 侧待补**：`mcpFileServers` 的来源徽标与只读展示、`mcpConfigWarnings` 的展示、`skillSources` 的来源标注（home/legacy/both）——数据已全部下发，webview 渲染尚未实现；`chat/webview` 本轮由其它改动占用，未动。
- **已知残余风险**：`stellarisLanguageServices.ai.mcp.servers` 本身是 window 作用域设置，仓库可经 `.vscode/settings.json` 携带，其信任级与 project 文件相当但本次未纳入审批门（任务范围限定文件配置；如需收口可对 `inspect('mcp.servers').workspaceValue` 部分按 project 同级处理）。
- 验证：`typecheck:test` 通过（仅并行改动中的 `chatPanel.ts` 有 4 个与本改动无关的错误）；目标单测 `mcpConfig.test.ts`（19 条）+ `skills.test.ts`（8 条）全过；相关回归（chatSettings/promptBuilder/agentToolSafety/orchestrator 等 15 个文件 337 条）全过；全量单测 2836 通过、1 失败为 `claudeSubscription.test.ts` 本地端口探测的环境性失败（与本改动无关）。
