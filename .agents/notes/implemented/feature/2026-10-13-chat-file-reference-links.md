# Agent Note: 对话文本 path:line 引用渲染为可点击跳转链接

Status: implemented

## Problem

模型在回复中引用工作区文件位置（如 `events/kuat_missions_events.txt:399-414`）时只是纯文本，用户需手动找到文件并跳行，断裂了「阅读 → 核验」链路。

## Decision

采用**渲染后 DOM 后处理**方案，不改动 `client/webview/chat/markdown.ts` 字符串渲染器：

- `client/webview/chat/fileReferences.ts`（新模块）：纯函数 `findFileReferences(text)` 返回命中数组（file、1 基 startLine、可选 endLine、index、text）。扩展名白名单：txt yml yaml gui gfx asset mod md json cwt loc pdxtxt shader fxh rules ps1 py js ts（大小写不敏感）；路径段允许词字符/点/连字符并以 `/` 分层；负向后行断言阻断 URL 或更长路径的粘连匹配；`kuat_missions.12:129-132` 这类无白名单扩展名的形式不匹配；`foo.txt:443 / :447` 只链接完整形态；单次匹配上限 500 条防病态输入。
- `chatPanel.ts` 的 `linkifyFileReferences(container)`（定义于 `enhanceCodeBlocks` 旁）：TreeWalker 遍历 `.markdown-body` 内文本节点，跳过 `a`、`pre`/`button`/`script`/`style`、`.md-codeblock` 与已处理的 `.file-ref-link`；`code` 元素仅当其位于 `p/li/td`（行内代码）时才参与。命中片段替换为 `<button type="button" class="file-ref-link" data-file data-line data-end-line>`，按钮文字即原文本。在 `buildAssistantMessage` 与 `renderCodexLiveTurn` 两处现有增强调用点随 `enhanceCodeBlocks` 一起调用。
- **点击链路**：chatArea 事件委托读 dataset 后 `postMessage({ type: 'openFileAtLine', filePath, startLine?, endLine? })`；`types.ts` 的 `WebViewMessage` union 新增该消息，`webviewProtocol.ts` 用 `fields({ filePath: isString }, { startLine: optional(isInteger), endLine: optional(isInteger) })` 校验；`bridge.ts` 分发时构造 `FileContext`（`FileContext` 同步补充可选 `startLine`/`endLine` 字段）并复用 `provider.contextReferences.openReference`——工作区包含校验、相对路径解析、1 基行号 clamp、selection + revealRange 全部沿用既有实现。
- **样式与文案**：`.file-ref-link` 继承行内 code 外观（等宽字体、底色、圆角）+ `--vscode-textLink-foreground` 主题链接色、hover 下划线、无边框背景；tooltip 文案（'Open file and jump to line' / '打开文件并跳转到行'）进 `chat/i18n.ts` 的新 `links` 节。

## Alternatives considered

- **在 markdown 字符串渲染器中内联链接化**：否决。渲染器输出 HTML 字符串，在其中注入交互元素要重新处理转义与代码区保护，风险高于渲染后 DOM 遍历；DOM 后处理天然跳过代码块与已有链接。
- **自定义 scheme/Command URI 跳转**：否决。webview 消息 + 既有 `openReference` 通道已具备工作区边界校验，无需新 URI 协议面。
- **无扩展名路径也尝试匹配**：否决。`name.12:129` 这类形式无法与「任意文本:数字」区分，误报率高；白名单扩展名把误报压到接近零。

## Consequences

- 助手消息与流式 codex 回合中的 `path:line(-line)` 文本可点击，经 `openFileAtLine` 消息在工作区内打开并选中跳转对应行；工作区外路径由 `openReference` 既有逻辑警告拒绝。
- 测试：`chatFileReferences.test.ts`（新）覆盖匹配正例/边界/负例；`chatProtocol.test.ts` 增加 openFileAtLine 正例与三类负例；`webviewSmoke.test.ts` 增加 linkify 接线、跳过规则、样式与双语文案的源码契约断言。
