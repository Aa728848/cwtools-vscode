# Agent Note: 修复 PTC 模式工具活动流显示、沙箱对象只读报错、输入栏顶部栏视觉规范及计划审批误判边界

Status: implemented

## Problem
近期为 AI 运行时引入的 PTC（Programmatic Tool Calling，代码化工具调用）与 NATIVE 模式在实际使用中暴露出四类核心体验与稳定性缺陷：
1. **工具活动流呈现与多语言不统一**：
   - 外层 `run_code` 卡片在执行完毕后直接暴露了未格式化的原始 JSON 对象（如 `{"success": true, "callsExecuted": 7, ...}`）；
   - 执行脚本期间产生的子调用前硬编码暴力拼接了 `[PTC] ` 文本前缀（如 `[PTC] 读取 ...`、`[PTC] 已运行命令`），中英混杂，与现有工具卡片的规范图标和国际化文案严重脱节。
2. **QuickJS 沙箱属性只读导致运行中频繁报错**：
   - 模型在生成 TypeScript/JavaScript 代码并由 QuickJS 沙箱执行调用工具时，频繁遇到报错 `Cannot assign to read only property 'command' of object '[object Object]'`，导致调用中断并让模型误以为是沙箱语法解析怪癖而陷入无效反复试错；
   - 经排查，沙箱将宿主入参转为 JSON 镜像时使用了 `Object.defineProperty(..., { writable: false, configurable: false })`，而部分宿主工具实现（例如 `run_command` 的 `externalTools.ts`）会对入参进行规范化重写赋值（`args.command = ...`），在严格模式下抛出不可变属性异常；
   - 此外，`stripTypeScriptTypes` 用于保护代码字符串的正则存在笔误 `\[\s\S]`，使得含有转义引号的代码字符串匹配不完整。
3. **输入栏与顶部栏布局不美观、设计不协调**：
   - 原先在输入框上方生硬地添加了一行单独的预选栏（`.composer-preflight-bar`），不仅在输入框上方留白失衡，而且在首轮消息发送后直接被移除，产生明显的布局高度跳变（Layout Shift）；
   - 顶部栏 PTC 模式徽标错误套用了刺眼的朱红色（`--accent: #d95a43`），与整体中性半透明灰白导航顶栏严重冲突。
4. **非计划模式下的常规技术问答误弹计划审批卡**：
   - 用户在常规技术咨询（例如询问“动态修正如何实现的”）时，AI 正常回复技术原理，却被系统强行提取保存为 `Implementation_Plan.md` 并弹出“在线批注/同意执行”审批卡片；
   - 经排查，`executePlanHandoff.ts` 中的 `shouldPauseForInteractivePlan` 与 `shouldRenderInteractivePlan` 包含兜底正则宽松判定（只要带有 Markdown 标题且正文超过 80 字符），将所有在非计划模式（如 `script`、`utility` 等）下的结构化长回复错误拦截为实施计划。

```mermaid
flowchart TD
    subgraph UI ["界面与呈现优化"]
        A[顶部栏状态徽标] -->|半透明微高亮主题色| B[统一设计系统]
        C[底部工具栏嵌入切换按钮] -->|替代上方独立预选栏| D[防高度跳变与锁定态]
        E[去硬编码 PTC 前缀] -->|微型徽标 + i18n 摘要| F[统一活动流渲染]
    end

    subgraph Runtime ["沙箱稳定性修复"]
        G[QuickJS 结果解构] -->|writable: true| H[宿主工具就地变更安全]
        I[字符串遮罩正则] -->|\\\\.|[^"\\\\]| J[转义字符保护]
    end

    subgraph Plan ["审批边界收敛"]
        K[AI 文本流结束] --> L{显式 plan 模式 / 设计蓝图 / 完整合约块?}
        L -->|是| M[拦截并生成计划审批卡]
        L -->|否| N[直接作为普通回复呈现]
    end
```

## Decision
1. **统一工具活动流与国际化文案**：
   - 移除 `client/webview/chat/codexActivity.ts` 中针对子调用的硬编码 `'[PTC] '` 字符串拼接；
   - 在 `client/webview/chat/i18n.ts` 中补充双语词条 `runScript`（运行脚本 / Run script）与 `subcallsCount`（已执行 {count} 次子调用 / {count} subcalls）；
   - 在 `codexActivity.ts` 中针对 `run_code` 主卡片提取 `args.description` 或 fallback 为专有标题，结果摘要展示“已执行 X 次子调用”，失败时展示简要错误信息，彻底杜绝原始 JSON 直接暴露；
   - 在 `client/webview/chat/codexToolRows.ts` 中为子调用行渲染精致的微型徽标 `<span class="codex-subcall-pill">PTC</span>`。
2. **彻底修复沙箱对象只读与正则解析**：
   - 在 `client/extension/ai/tools/runCode.ts` 中将 `toLosslessJson` 构建对象属性时的 `writable` 与 `configurable` 设置为 `true`；
   - 在 `executeRunCodeProgram` 将子调用分发给宿主 `runTool(toolName, ...)` 时，执行 `{ ...argsValue }` 浅拷贝浅解构，保障宿主工具就地重写属性不会遭遇严格模式只读锁定；
   - 修复 `stripTypeScriptTypes` 中的双引号字符串正则为 `/"(?:\\.|[^"\\])*"/g`，单引号正则为 `/'(?:\\.|[^'\\])*'/g`，保证转义字符和代码内容不被破坏。
3. **重构输入栏与顶部栏视觉规范、菜单互斥及像素级基线对齐**：
   - 彻底移除顶部栏的 `#headerModeBadge` 徽标展示，保持顶栏清爽；
   - 废除输入框上方的独立预选条，将模式切换按钮以 `.composer-tool-mode-trigger` 嵌入底部工具栏；
   - **完全统一外观与尺寸**：直接继承 `.composer-model-trigger` 的通用规格（高度 30px、字体 12px、无边框、文字颜色与透明度与 `[🛡 自动审核 v]` 及 `[Paradox v]` 完全一致）；
   - **像素级中轴基线对齐**：统一所有 trigger 的 `box-sizing: border-box; height: 30px; border: 0 !important; line-height: 1;`，并将图标 span 内硬编码的 `vertical-align: -2px` 归零（`vertical-align: 0 !important`），文本 span 统一 `display: inline-flex; align-items: center; line-height: 1;`，彻底消除中英文字体（`PTC` 与 `自动审核`）基线不同造成的 2px 高度视觉落差；
   - **严格菜单互斥机制**：重构所有底部菜单开启函数（`setComposerMenuOpen`, `setDomainMenuOpen`, `setModelMenuOpen`, `setReasoningMenuOpen`, `setWriteModeMenuOpen`, `setPreflightModeMenuOpen`），在打开前无条件统一调用 `closeComposerMenus()`，彻底杜绝两个下拉菜单同时打开重叠遮挡的异常；
   - 修复 `chatPanel.css` 中缺失的闭合大括号 `}`，杜绝样式规则被丢弃导致的界面崩塌缺陷。
4. **严格收敛计划审批判定边界**：
   - 在 `client/extension/ai/executePlanHandoff.ts` 的 `shouldPauseForInteractivePlan` 与 `shouldRenderInteractivePlan` 中，彻底移除宽松的标题正则检查 `^#{1,3}\s+\S+`；
   - 确立严格条件：只有在显式处于 `plan` 模式（且计划内容完整有效）、或工具调用了 `write_design_blueprint`、或正文中包含完整的 `cwtools-plan` 机器合约块时，才允许导出审批计划卡片；其余模式（如 `script`、`utility`、`explore`）下的任何 Markdown 技术长文本一律作为正常回复输出。

## Alternatives considered
- **在宿主每个工具函数中做防御性克隆（`cloneDeep`）**：否决。在工具外部层层克隆既冗余低效，也无法防止未来新增工具再次引入原地修改对象属性的隐患。在沙箱返回层设置 `writable: true` 并在 `runCode` 分发点执行浅拷贝是根因级解决方案。
- **保留输入框上方的预选横条但常驻展示**：否决。输入框上方额外占据垂直高度，使得输入区域显得臃肿，且弱化了输入区域的核心地位；底部工具栏是 VS Code 及主流 AI Agent 存放模式指示与会话级配置的标准位置。
- **用关键词过滤来排除技术解答文章**：否决。关键词黑白名单不可靠且极其脆弱；根据显式运行模式（`planMode`）和严格计划合约块（Contract block）进行守卫才是确定性的架构边界。

## Consequences
- PTC 模式下脚本执行及子调用呈现精美、符合设计规范，中英双语无缝契合，不再暴露大段原始 JSON。
- 彻底消除了 QuickJS 与宿主工具之间的 `read-only property` 严格模式报错，模型能一次性顺畅完成复杂的多步骤工具执行。
- 输入框布局稳定，消除发送后的跳变感；顶部栏模式标识与界面主题协调一致。
- 恢复了计划审批卡的严谨性，非计划模式下的普通技术问答不再被误拦。
- 编译 `npm run compile`、全量类型检查 `npm run typecheck:test` 以及针对性回归测试（41 项测试）全部一次性通过。
