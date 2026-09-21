# Agent Note: 聊天 Markdown 数学公式解析与 MathML 渲染

Status: implemented

## Problem

聊天 Markdown 没有数学公式管道，模型输出的 `$...$`、`$$...$$` 直接显示 TeX 源码，用户截图中的中文演算难以阅读。公式内容是不可信文本，必须与代码及 Markdown 强调语法隔离。

## Decision

- `client/webview/chat/math.ts` 提供零外部依赖的常用 TeX 子集到 MathML 的解析。支持中文 `\text`、常用运算符、分式、根式、上下标、希腊字母和简单矩阵；不声称完整 LaTeX 兼容。未知命令保留可见文本。
- 所有文本与属性转义，符号表只接受自身属性；单公式限制 16,000 字符、递归原子深度 64，超限安全回退到源码。
- `markdown.ts` 在强调语法前提取公式，保护代码区和转义美元符号；多行显示公式独立成块，单行公式可嵌入列表及表格。未闭合定界符保持文本。
- `chatPanel.css` 使用主题变量和横向滚动保护窄面板。MathML 由 VS Code 所用 Chromium 渲染，不加载 CDN、字体包或脚本。

## Alternatives considered

- KaTeX/MathJax：兼容范围更大，但需要额外依赖与资源集成。本次为常见演算选择原生 MathML 子集；若需要完整 TeX 语义，应重新评估成熟库，不无限扩展自制解析器。
- 只替换运算符字符串：不能正确表达嵌套分式、根式和上下标，未采用。
- 后端预渲染：增加跨进程传输及生命周期复杂度，当前同步前端渲染足够。

## Consequences

- 无新增 npm 依赖；支持常用演算而非任意 LaTeX 宏包。
- 数学专项测试覆盖截图公式、中文混排、代码与货币保护、HTML 转义、资源上限及异常容错。
