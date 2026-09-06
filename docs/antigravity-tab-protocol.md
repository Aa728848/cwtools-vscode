# Antigravity editor models / 编辑器模型

Verified on 2026-09-06 using synthetic code and the installed official IDE client.

## English

`gemini-pro-agent` is the Gemini 3.1 Pro (High) runtime alias. The chat picker combines Pro aliases as `gemini-3.1-pro`; reasoning settings still choose the runtime variant. Editor-only `tab_` IDs stay out of the chat picker.

`tab_flash_lite_preview` predicts the next code edit. Its structured output is adapted to the existing FIM interface as an insertion at the cursor. `tab_jump_flash_lite_preview` predicts a nearby edit; the manual jump command moves the cursor there without changing the file. Their metadata does not establish an underlying public Gemini version.

### Setup

Sign in to **Antigravity (Google OAuth)** in AI Settings, enable inline completion, and select Antigravity with `tab_flash_lite_preview`. An empty inline model uses this editor model independently of the chat model. Example VS Code settings:

```json
{
  "stellarisLanguageServices.ai.enabled": true,
  "stellarisLanguageServices.ai.inlineCompletion.enabled": true,
  "stellarisLanguageServices.ai.inlineCompletion.provider": "antigravity",
  "stellarisLanguageServices.ai.inlineCompletion.model": "tab_flash_lite_preview",
  "stellarisLanguageServices.ai.inlineCompletion.requestTimeoutMs": 3000
}
```

Accept ghost text using VS Code's usual inline-completion keybinding. Run **Stellaris AI: Jump to Next Edit (Antigravity)** in the Command Palette for a jump. It uses the inline provider selection and does not claim the Tab key. Both features apply to `stellaris` and `paradox` documents, share the existing OAuth/proxy, and do not require the official language server at runtime.

Inline suggestions preserve all supplied text outside the cursor. Other edits, incomplete replies, ambiguous targets and malformed output are discarded. Jump prediction uses up to 6,000 characters around the cursor and the previous edit when available, in the current file only. Moving the cursor, changing the document, cancellation or disposal prevents a late jump. General multi-edit application and cross-file navigation are not included.

### Verified protocol and checks

The official IDE's `HandleStreamingCommand` builds document/edit-history context with a `<|cursor|>` marker and a partial model reply inside `<replace_file_content>`. Completion pre-fills through the `ReplacementContent` key; jump pre-fills through `TargetContent`. Replies continue JSON-escaped replacement data, rather than plain insertion text or coordinates. These are next-edit models, not a standard `/completions` FIM endpoint.

The upstream envelope uses `requestType: tab` or `tab_jump` and disables thinking output and budget. Native typing events initialize the edit trajectory; forcing the first request without typing leaves it unavailable. The extension implements the verified wire format directly with a concise edit instruction and strict decoding. It never executes model-emitted tool calls.

Both Tab IDs advertise 16,384 context tokens and 4,096 output tokens. Separate internal `tabModelIds` (`chat_20706`, `chat_23310`) are not exposed as chat models. The [official Tab documentation](https://antigravity.google/docs/ide/tab) describes the corresponding editor features.

Live adapter checks passed for addition, multiline indentation, a Stellaris resource block, preserving an existing suffix, and locating a stale variable use after a rename. Five calls took approximately 0.7–2.5 seconds, including a cold OAuth/project lookup; this is a smoke test, not a latency or quality guarantee. Regression tests cover escaping, CRLF, Unicode boundaries, rejected edits, credential refresh, cancellation, insertion-only behavior and stale editor state.

## 中文

`gemini-pro-agent` 是 Gemini 3.1 Pro (High) 的后台别名。聊天列表将 Pro 别名统一显示为 `gemini-3.1-pro`，推理强度仍控制实际后台档位；仅供编辑器使用的 `tab_` ID 不放入聊天列表。

`tab_flash_lite_preview` 预测下一次代码编辑，经适配后复用现有 FIM 链路，在光标处显示补全。`tab_jump_flash_lite_preview` 预测附近的下一处编辑，手动跳转命令只移动光标，不修改文件。元数据不能确定它们对应哪个公开 Gemini 版本。

### 使用方法

在 AI 设置中登录 **Antigravity (Google OAuth)**，启用行内补全，选择 Antigravity 和 `tab_flash_lite_preview`。行内模型留空时默认使用该编辑器模型，不继承聊天模型。上方 JSON 可用于 VS Code 设置，3,000 毫秒超时给首次账户和项目查询留出余量。

灰字通过 VS Code 原有行内补全快捷键接受。需要跳转时，在命令面板运行 **Stellaris AI：跳转到下一处编辑（Antigravity）**。该命令使用行内补全的提供商选择，不占用 Tab 键。两项功能适用于 `stellaris`、`paradox` 文档，共用已有 OAuth 和订阅代理，运行时无需官方语言服务。

行内建议必须保留光标之外的全部输入文本。其他范围修改、截断回复、重复匹配的目标或格式错误都会被丢弃。跳转查看光标附近最多 6,000 个字符，有记录时参考上一次编辑，范围限于当前文件。光标移动、文档变化、取消或释放服务后，迟到的结果不会触发跳转。本次未接入批量文件修改或跨文件导航。

### 已验证协议与检查

官方 IDE 的 `HandleStreamingCommand` 根据文档和编辑历史构造请求，用 `<|cursor|>` 标记光标，在 `<replace_file_content>` 中预填回复。补全预填到 `ReplacementContent` 键，跳转预填到 `TargetContent` 键。输出是 JSON 转义后的替换数据，不是可以直接插入的文本或行列坐标。因此它们属于下一次编辑模型，不提供标准 `/completions` FIM 接口。

上游请求分别使用 `requestType: tab`、`tab_jump`，关闭思考输出和预算。原生服务依赖输入事件初始化编辑轨迹，第一次直接强制请求会因轨迹缺失返回空结果。本扩展直接实现已验证的请求格式，使用简洁的编辑指令并严格解析结果，不执行模型输出中的工具调用。

目录显示两个 Tab 模型均支持 16,384 token 上下文和 4,096 token 输出；另有内部 `tabModelIds`：`chat_20706`、`chat_23310`，这些不作为聊天模型展示。[官方 Tab 文档](https://antigravity.google/docs/ide/tab)介绍了相关编辑器功能。

真实调用通过了加法补全、多行缩进、Stellaris 资源块、保留现有后缀、参数改名后旧引用定位五项检查，耗时约 0.7–2.5 秒，包含首次 OAuth/项目查询；这是冒烟验证，不构成延迟或整体质量保证。回归测试覆盖转义、CRLF、Unicode 边界、拒绝不安全或歧义编辑、令牌刷新、取消、仅插入适配及编辑器状态过期。
