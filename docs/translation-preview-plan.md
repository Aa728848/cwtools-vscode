# Translation Preview Implementation Plan

Status update: the implemented scope is selection-only comment translation.
Users explicitly select code, the command extracts only `#` comments from that
selection, and the AI returns a read-only preview. Hover translation and inline
decorations are future work.

Current model routing: translation preview can use its own AI provider/model in
the AI Settings panel. Empty provider/model values inherit the chat settings.
The target language is chosen when the preview command runs.

## 中文

### 范围更新

第一版只制作“选区注释翻译预览”：用户显式选中代码并运行命令，扩展只抽取
选区中的 `#` 注释交给 AI，生成只读预览。Hover 翻译和行尾译文装饰暂时不做，
作为后续增强。

当前模型路由：AI 设置面板中可以为翻译预览单独指定 provider/model；留空时继承
对话模型设置。
目标语言在执行预览命令时选择，不放在设置栏中。

### 背景

当前扩展已经有本地化补全和 AI 翻译/润色入口，但这些入口偏向
“生成可写入文本”。用户新的需求是：在阅读原版或 MOD 内容时，把注释、
本地化值、规则说明等内容临时翻译出来，帮助理解；译文只显示在界面中，
绝不写回文件。

这个方向比把原版文件镜像进全局搜索更轻：它只处理当前打开文件、当前可见
范围、悬停位置或选区，不扫描整个游戏目录，不落大规模磁盘缓存。

### 目标

- 提供只读的翻译显示层，不修改用户文件，不改变保存状态。
- 第一版优先支持从选区中提取 `#` 注释并预览翻译。
- 后续可支持 `.yml` 本地化值、CWT 规则说明、悬停翻译，以及可选的行尾译文装饰。
- 避免后台全量翻译 workspace，所有翻译都必须由可见范围或用户动作触发。
- 对云端/AI 翻译保持显式开关和清晰提示，避免隐私与费用意外。
- 保留 Stellaris/Paradox 语法中的占位符、颜色码、图标、作用域表达式和转义。

### 非目标

- 不做全局搜索原版内容。
- 不生成或同步 vanilla 文件镜像。
- 不把译文写入 `.txt`、`.yml`、`.cwt` 或任何用户文件。
- 不自动翻译整个 workspace、整个游戏目录或整个 vanilla cache。
- 不依赖 VS Code proposed API。
- 第一版不承诺机器翻译质量达到可发布本地化水平；它是阅读辅助，不是最终译稿。

### 用户体验

第一版推荐以选区翻译预览为主：

- 用户选中一段文本并运行 `CWTools: Preview Translation`。
- 扩展逐行提取未被引号包住的 `#` 注释，只把这些注释发送给 AI。
- 扩展打开只读预览面板，显示原文注释和译文。
- 预览面板不提供直接写入按钮；如后续需要写入，必须走现有本地化 AI 写入流程。

Hover 翻译：

- 暂不实现。
- 后续如恢复该方向，再提取当前位置所在的注释、字符串值、本地化值或短块。

行尾译文装饰：

- 默认关闭。
- 开启后只处理当前可见范围内的短注释或短本地化值。
- 超长文本只显示短提示，例如 `Translation available in hover`。

### 信息架构

建议新增一个扩展 Host 侧模块：

```text
client/extension/translationPreview/
  index.ts
  settings.ts
  extractor.ts
  provider.ts
  cache.ts
  hover.ts
  decorations.ts
  previewPanel.ts
  sanitise.ts
```

职责划分：

- `settings.ts`: 读取功能开关、提供商、长度限制、是否允许远程请求。
- `extractor.ts`: 从 VS Code 文档和光标位置提取可翻译片段。
- `sanitise.ts`: 保护 PDX/本地化特殊语法，构造翻译前后的占位符映射。
- `provider.ts`: 翻译提供商接口和实现分发。
- `cache.ts`: 内存 LRU 缓存和失效策略。
- `hover.ts`: 注册 `HoverProvider`。
- `decorations.ts`: 管理行尾译文装饰。
- `previewPanel.ts`: 只读 Webview 预览选区译文。
- `index.ts`: 注册命令、provider、事件监听和 dispose 逻辑。

### VS Code API 选择

使用稳定 API：

- `vscode.languages.registerHoverProvider`
- `vscode.window.createTextEditorDecorationType`
- `TextEditor.setDecorations`
- `vscode.window.createWebviewPanel`
- `vscode.commands.registerCommand`
- `workspace.onDidChangeTextDocument`
- `window.onDidChangeVisibleTextEditors`
- `window.onDidChangeTextEditorVisibleRanges`
- `workspace.onDidChangeConfiguration`

避免：

- `TextSearchProvider` / `FileSearchProvider` proposed API。
- 虚拟 workspace 搜索实现。
- 自动写入 API。

### 可翻译文本提取

第一版支持这些文件类型：

- Stellaris/Paradox script: `paradox`, `stellaris`
- localisation: `stellaris-localisation`
- CWT rule config: `cwt` 或普通文本中的 `.cwt`
- Markdown 文档可选支持，仅用于预览命令，不默认 hover 翻译。

提取规则：

- `# comment`: 翻译 `#` 后文本，保留缩进和 `#` 本身不参与翻译。
- `.yml` 本地化行：只翻译引号内 value，不翻译 key、`:0`、缩进。
- PDX 字符串值：只翻译引号内自然语言；普通脚本 ID 不翻译。
- CWT 规则注释：按注释处理。
- 选区：第一版只提取未被引号包住的 `#` 注释，避免把代码和长 ID 一起送去翻译。

跳过规则：

- 空白、纯符号、纯数字。
- 明显的 ID、路径、文件名、scope 链、变量名。
- 超过 `maxCharsPerRequest` 的片段，除非用户显式运行选区预览命令。
- 含未闭合引号或明显语法破损的行，避免误提取。

### PDX 语法保护

翻译前把不可翻译片段替换成占位符，翻译后恢复：

- 本地化引用：`$KEY$`, `$KEY|Y$`
- Scripted loc: `[Root.GetName]`, `[event_target:foo.Owner.GetName]`
- 图标：`£energy£`
- 颜色码：`§Y`, `§!`
- 转义序列：`\n`, `\"`, `\\`
- 格式化变量和常见 placeholder。

占位符格式建议使用不易被翻译模型改写的形式：

```text
__CWTP_0__
__CWTP_1__
```

恢复后要检查：

- 所有占位符都成功恢复。
- 输出中没有残留 `__CWTP_`。
- 若恢复失败，丢弃译文并显示安全提示，而不是展示破损译文。

### 翻译提供商

接口草案：

```ts
export interface TranslationRequest {
  text: string;
  sourceLanguage?: string;
  targetLanguage: string;
  documentLanguageId: string;
  reason: 'hover' | 'decoration' | 'selectionPreview';
  timeoutMs: number;
}

export interface TranslationResult {
  text: string;
  provider: string;
  cached?: boolean;
  warnings?: string[];
}

export interface TranslationProvider {
  readonly id: string;
  translate(request: TranslationRequest, token: vscode.CancellationToken): Promise<TranslationResult>;
}
```

第一阶段提供：

- `disabled`: 默认，无请求，只显示功能未启用提示。
- `aiChat`: 复用当前扩展内的 AI 能力，但只返回预览结果，不触发写入。
- `externalCommand`: 后续可选，让高级用户配置本地翻译命令。

不建议第一版内置免费在线翻译接口，原因是稳定性、隐私、限流和服务条款不可控。

### 设置项

建议新增设置：

```jsonc
{
  "stellarisLanguageServices.translationPreview.enabled": false,
  "stellarisLanguageServices.translationPreview.provider": "aiChat",
  "stellarisLanguageServices.translationPreview.enableHover": true,
  "stellarisLanguageServices.translationPreview.enableInlineDecorations": false,
  "stellarisLanguageServices.translationPreview.allowRemoteRequests": false,
  "stellarisLanguageServices.translationPreview.maxCharsPerRequest": 1200,
  "stellarisLanguageServices.translationPreview.maxVisibleDecorations": 80,
  "stellarisLanguageServices.translationPreview.cacheEntries": 500
}
```

默认策略：

- 总开关默认关闭。
- 目标语言在每次执行选区预览命令时由用户选择。
- Hover 默认随总开关启用。
- 行尾装饰默认关闭。
- 远程请求默认关闭；如果 provider 需要网络或云端 AI，首次使用时提示用户确认。

### 命令

建议新增命令：

- `cwtools.translationPreview.toggle`
- `cwtools.translationPreview.previewSelection`
- `cwtools.translationPreview.clearCache`
- `cwtools.translationPreview.configure`

用户可见命令和设置必须同步更新英文/中文 manifest 文案。

### 缓存设计

只使用有界缓存：

```text
key = providerId + targetLanguage + documentLanguageId + normalizedTextHash + protectedTokenHash
```

缓存内容：

- 原文 hash
- 译文
- provider id
- 创建时间
- 最近访问时间
- 警告信息

策略：

- 默认最多 500 条。
- 内存 LRU；第一版不落盘。
- 文档修改时按 URI 清理相关可见范围状态。
- 设置变化、目标语言变化、provider 变化时清空缓存。
- 超时和失败结果不长期缓存，最多短时间防抖。

### 性能预算

Hover：

- 提取文本应在 5ms 级别完成。
- 缓存命中应立即返回。
- 未命中请求默认超时 8s。
- 同一 hover 文本 1s 内只发一次请求。

行尾装饰：

- 只处理当前可见范围。
- 每个编辑器最多显示 `maxVisibleDecorations` 条。
- 可见范围变化后 250ms debounce。
- 后台翻译并发上限 2。
- 单条装饰文本超过 120 字符时截断。

选区预览：

- 允许更长文本，但受 `maxCharsPerRequest` 或单独的 `maxSelectionChars` 控制。
- 预览面板显示进度和错误状态，不阻塞编辑器输入。

### 隐私和安全

- 明确区分本地 provider 和远程/AI provider。
- 远程 provider 首次使用必须提示：将发送所选文本或悬停文本用于翻译。
- 不自动发送整个文件。
- 不发送工作区路径，除非用户打开 debug 日志并显式允许。
- 日志中不记录原文和译文，只记录长度、provider、耗时和错误类别。
- 翻译结果永远不自动写回文件。

### 国际化

需要同步更新：

- `package.nls.json`
- `package.nls.zh-cn.json`
- `release/package.nls.json`
- `release/package.nls.zh-cn.json`
- 扩展内提示字符串对应的 i18n helper 或本地 `localize(en, zh)`。

用户可见文案包括：

- 设置说明。
- 命令标题。
- Hover 中的状态和错误提示。
- 远程请求确认提示。
- 预览面板标题和按钮。

### 实现阶段

#### Phase 0: 技术验证

- 在一个小模块中验证 `HoverProvider` 可以异步返回翻译结果。
- 验证 decoration 在大文件可见范围滚动时不会明显卡顿。
- 验证取消 token、debounce 和超时行为。

完成标准：

- 手工打开 `.txt`、`.yml`、`.cwt`，悬停短注释能够显示 mock 译文。
- 滚动 5000 行文件时无明显卡顿。

#### Phase 1: 核心 MVP

- 新增 `translationPreview` 模块。
- 实现设置读取。
- 实现注释和本地化行提取。
- 实现 PDX 占位符保护和恢复。
- 实现内存 LRU 缓存。
- 实现 `HoverProvider`。
- 实现 `mock` 或 `disabled` provider，用于测试和无 AI 场景。

完成标准：

- 功能默认关闭。
- 开启后 hover 能显示只读译文。
- 文档不变脏，保存状态不变化。
- 特殊 token 翻译前后保持不变。

#### Phase 2: AI provider 和选区预览

- 接入当前扩展 AI 能力，确保只返回译文，不创建写入任务。
- 新增 `Preview Translation` 命令。
- 新增只读 Webview 预览面板。
- 增加远程/AI 请求确认逻辑。

完成标准：

- 选区预览可显示原文/译文。
- 取消请求不会留下悬空 promise 或面板错误。
- AI 输出中的占位符恢复失败时显示安全错误。

#### Phase 3: 可选行尾译文

- 实现可见范围 decorations。
- 增加并发限制和防抖。
- 增加过长文本截断。
- 增加 `clearCache` 和 `toggle` 命令。

完成标准：

- 默认关闭行尾译文。
- 开启后只翻译可见范围短文本。
- 快速滚动不会堆积请求。

#### Phase 4: polish 和发布准备

- 完成 manifest 配置和中英文文案。
- 补齐测试。
- 更新 README 或功能说明。
- 确认 release manifest 同步。

完成标准：

- `npm run compile`
- targeted unit tests
- `npm run build:docs` 如更新发布文档
- 手工验证 VS Code Extension Development Host 中 hover、预览、关闭开关、清缓存。

### 测试计划

单元测试：

- `extractor`: 注释、本地化值、字符串值、跳过 ID/路径。
- `sanitise`: `$KEY$`、`[Root.GetName]`、`£icon£`、`§Y...§!`、转义序列保护和恢复。
- `cache`: LRU、设置变更、provider/语言隔离。
- `settings`: 默认值和无效配置回退。

集成/扩展测试：

- Hover 不改变文档 dirty 状态。
- 关闭功能后 provider 不触发。
- 大文件可见范围 decoration 不超过上限。
- 取消 token 能停止过期请求。

手工测试样例：

```pdx
# This event fires when the planet owner changes.
country_event = {
  id = test.1
  title = "test_event_title"
}
```

```yaml
l_english:
 test_event_title:0 "§Y$PLANET$§! has changed ownership."
```

预期：

- 注释被翻译。
- 本地化 value 被翻译。
- `$PLANET$` 和 `§Y` / `§!` 原样保留。
- key、`:0`、缩进不参与翻译。

### 风险与应对

| Risk | Impact | Mitigation |
| --- | --- | --- |
| AI/远程翻译泄露用户文本 | 隐私风险 | 默认关闭远程请求，首次使用确认，不发送路径和整文件 |
| 翻译改坏 PDX token | 误导用户 | 占位符保护，恢复校验，失败时不展示破损译文 |
| 行尾译文导致卡顿 | 编辑体验下降 | 默认关闭，只处理可见范围，debounce，并发上限 |
| 译文质量不稳定 | 用户误解 | 明确标注为 preview，不作为最终本地化 |
| 大量缓存占内存 | 性能/内存风险 | LRU 上限，默认不落盘 |
| 与现有 AI 写入流程混淆 | 误写文件 | 命令命名和 UI 文案强调 Preview，预览面板不提供写入 |

### 代码触点

可能需要修改：

- `client/extension/extension.ts`: 注册 translation preview 模块。
- `client/extension/localisationAiCommands.ts`: 复用或拆分翻译 prompt 约束。
- `client/extension/localisationCompletions.ts`: 复用本地化 token 知识，避免重复维护。
- `client/webview/chat/i18n.ts` 或扩展侧本地化 helper: 用户可见文案。
- `package.json` 和 release manifest: 命令与设置贡献。
- `client/test/unit/`: 新增 extractor/sanitise/cache/settings 测试。

尽量避免修改：

- LSP/F# 后端。
- MCP read-only server。
- vanilla cache 加载流程。
- workspace 搜索和虚拟文件系统。

### 验收清单

- [ ] 默认安装后不会发送任何翻译请求。
- [ ] 开启后 hover 能翻译当前行或当前短块。
- [ ] 选区预览只读展示译文。
- [ ] 文件 dirty 状态不变化。
- [ ] PDX token、颜色码、图标和变量引用原样保留。
- [ ] 关闭功能后所有 decorations 消失。
- [ ] 清缓存命令有效。
- [ ] 大文件滚动无明显卡顿。
- [ ] 用户可见文案有英文和中文。
- [ ] 单元测试覆盖提取、保护、缓存和设置。
