# Agent Note: 索敌权重工具链（计算模块、Agent 工具、MCP 暴露、分析面板、CW290 诊断、修饰符文档接线）

Status: implemented

## Problem

项目没有任何索敌/战斗专用分析能力（webview 无图表面板、MCP 36 工具无战斗类、agent 无计算工具）；`accuracy`/`tracking` 引擎要求 [0,1] 但规则层声明为无约束 `float`，无诊断；CWT 规则里 typed modifier 的 `###` 文档注释被 parseModifier 解析却从未消费（TypeModifier.documentation 死字段）。

## Decision

2026-10-13 落地，全部入口共享同一计算模块 `client/extension/ai/targetingWeights.ts`（纯函数 `computeTargetingChain`，无 vscode/fs 依赖，按设计文档 §2/§3 归一化公式实现；§6 算例 9 项单测复算通过）：

- **Agent 工具 `query_targeting_weight`**：注册五触点（definitions/registry 的 AgentToolName+TOOL_DOMAINS+BASE_READ/agentTools 的 import+TOOL_TIMEOUTS+executeInternal/toolPhrases 双语）+ 单测；toolDefinitions 预算测试（96 工具/32000 token）通过。
- **MCP 暴露**（cwtools-mcp `729c32f`，已推送，**npm 未发布**）：generate-mcp-schema.cjs、names.ts、mcpBridgeServer.ts 三处名单同步 + 生成器产出 generated/mcpTools.ts（37 工具，纯新增 210 行）；子模块 build + 契约测试 39+66 全绿，只读面未破。
- **分析面板** `cwtools.targetWeights.open`：Host（targetWeightPanel.ts，文件 I/O 与扫描上限 2000/根、revealWeapon 白名单回跳）+ webview（targetWeightPreview.ts/css，纯 CSS 条形图、VETO/沿用主目标横幅、主题变量、prefers-reduced-motion、统一 dispose）+ 纯提取模块 targetWeightExtract.ts（顶层类型键 vs 内层 key 的模板 id 修正；单测经实测迭代扩至 31 项）；rollup.config.mjs 追加一个 webview bundle；命令与标题双语（release/package.json + 三个 nls）。
- **面板实测迭代（同日第二轮）**：修复 webview 误读 Host 载荷顶层字段（应为 `message.weapon`）引发的连锁缺陷（分析死路「请先选择模板」、↗ 跳转静默失败、字段渲染 undefined 竖排）；武器列表补工作区来源、本地化名显示（无本地化回退 id）与输入即筛；目标 ship_size 改为扫描工作区+vanilla 的 ship_sizes 顶层 id 完整 datalist；武器字段全部可手编（选模板仅自动填充，缺省标注估算）使无模板也可分析；CSS 网格修复；新增编辑器右键命令 `cwtools.targetWeights.openAtCursor`（光标所在块模板预选，when: stellaris 语言或 component_templates 路径）。release/rules 产物按已提交规则 bcccad4 重新打包。
- **面板实测迭代（第三轮，协调者直接执行）**：修复「vanilla 数据未并入计算」的根因——武器战斗数值存放在 `common/component_templates/*.csv` 而非 txt 模板（rules 注释 "vanilla uses an .csv file"）；`parseWeaponComponentsCsv` 按表头行动态映射列序，`applyCsvWeaponStats` 只补缺口且 txt 显式值优先，补入字段记 `csvKeys` 并在 webview 显示「来自 CSV」徽标（accent 色，区别于「估算」）。目标船型下拉改为真实 ship_size 枚举（`extractShipSizeDetails` 解析 size_multiplier/max_hitpoints/modifier.ship_evasion_add，`@脚本变量` 经 `parseScriptedVariables`+`mergeScriptedVariables` 跨根合并解析）；本地化名先查 IndexService（工作区）再定向扫描 vanilla 语言目录（键试原样+全大写），语言偏好未显式配置时跟随 VS Code 界面语言。下拉首项「自定义/手动」，选船型预填 σ/ε/船体上限。vanilla 冒烟实证：ENERGY_LANCE_1（600/1500/acc 0.85/trk 0/mh 1.5/ms 0.5/ma 2.0）与 battleship（σ=40/hp=4800/闪避 5%）。新增 7 项单测（文件内 38 项全绿），全量单测 2995 通过。
- **CW290 诊断**（src/Main）：WeaponComponentRangeValidation.fs（113 行，只报常量字面量，Warning，英文文案复刻引擎原文）+ Program.fs 三装配点（generic/cached/update）+.cwt 排除；25 项 fsx 回归；docs/diagnostic-codes.md 补 CW290 中英小节；diagnosticI18n.ts 中文映射 + 测试（31 项过）。
- **修饰符文档接线**（cwtools `107dee77`，已推送）：RulesHelpers.fs modifierRuleFromNameAndTypeDef 把 m.documentation 接入 Options.description（combineDescription 合并非覆盖）；8 项 fsx 回归（ModifierDocumentationRuleParsing.Tests.fsx）。

## Alternatives considered

- **面板计算放 webview 共享 bundle**：让 Host 统一计算、webview 纯渲染，避免跨 tsconfig 共享模块的打包复杂度。
- **TS 侧解析 stl.cwb 取真实字段**：二进制反序列化只在 F# 侧（AGENTS.md 边界），需要时走 LSP 只读命令，本期不做。
- **`target_weights` 键的独立诊断**：键已 `<ship_size>` 类型化，错键由类型系统自然报错，不再单做。
- **CW290 用 Error 严重度**：引擎只打日志不拒绝加载，与 CW270/CW271 同族取 Warning。
- **npm 发布 cwtools-mcp 新版本**：用户决策本次不发布；外部 agent 暂不可见新工具，VSIX 内桥接可用。

## Consequences

- 三个入口（Agent 工具 / MCP / 面板）一处修公式全受益；新增工具占用工具预算后仍有余量（toolDefinitions 测试过）。
- `npm run test:fsx` 有 8 个既有环境性失败（缺 `artifacts/bin/Main/debug/FSharp.Data.DesignTime.dll`，HEAD 基线复现相同失败，与本次无关）。
- parseModifier 只取第一条 `##` 注释行进 documentation（既有行为，未改），多行 `###` 修饰符文档仅首行可见。
