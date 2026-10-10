# Agent Note: AI 设置保存被单条未注册配置项打断

Status: implemented

## Problem

Linux 用户（桌面版 VS Code + GNOME/KDE）点「保存设置」后看到 `[Eddy] [WARN] [ChatPanel] Error handling webview message 'saveSettings'`，且**没有**「设置已保存」提示。这条日志来自 `client/extension/ai/chatPanel.ts` 的消息入口 catch，它把真实异常压成一句话，用户侧看不到任何原因。

根因不在 Linux，也不在 SecretStorage：`ChatSettingsManager.saveSettings`（`client/extension/ai/chatSettings.ts`）过去是一条**无 try 的直写链**——四十余次 `await cfg.update(key, value, ConfigurationTarget.Global)` 顺序执行。VS Code 只接受**已注册**的配置键写入，未注册的键在 `ConfigurationEditingService.validate` 抛 `ERROR_UNKNOWN_KEY`（"Unable to write to {0} because {1} is not a registered configuration."，见 VS Code `configurationEditing.ts` 与本机 `nls.messages.json`）。而扩展清单 `release/package.json` 里缺两个被写入的键：

- `stellarisLanguageServices.ai.reasoningKey`（`chatSettings.ts` 写入，`AIUserConfig.reasoningKey` 与 `agentRunner.ts` 的 `explicitReasoningKey` 读取）——**完全未注册**；
- `stellarisLanguageServices.ai.endpoint`（保存时以 `undefined` 清理历史单端点键）。

键一旦真的被写（推理键非空）或清理动作生效，整次保存就在该行中断：后续键不再落盘，末尾的 `showInformationMessage` 不执行，`openSettingsPage` 也不执行，Webview 因此停在「正在保存…」（`settingsSavePending` 只由 `settingsData` 复位）。

真正的 Linux 主线另有其事：VS Code 在系统钥匙串（gnome-keyring/kwallet/libsecret）不可用时，会把扩展 SecretStorage 静默降级为**内存存储**（`SecretStorageService.initialize`：`Encryption is not available, falling back to in-memory storage`）。此时 `store` 不抛，保存显示成功，但 API Key 重启即丢失。窗口内的 GNOME 提示只在初始化失败时出现，事后难以复现，用户只能看到「存了但没用」。

## Decision

1. **两个键补进清单**（`release/package.json`，AI 核心分类）：`ai.reasoningKey` 与 `ai.endpoint` 都声明为 `scope: window` 的 `string`，默认空值，描述分别走 `package.nls.json` / `package.nls.zh-cn.json` / `package.nls.zh.json`（三份同步）。`ai.endpoint` 的文案明说它只是历史单端点键的兼容壳，端点以按供应商保存的 `providerEndpoints` 为准。
2. **单键失败不再拖垮整次保存**：新增私有 `updateConfig(cfg, key, value)`，逐键 try/catch，失败时用新 SOURCE 名 `ChatSettings` 报一条点名该键的 WARN，并返回 `false`。`saveSettings` 内所有 `cfg.update(…)` 与 web 配置写入（`updateWeb`）都改走该助手。这样即便将来再出现未注册键或写盘/策略拒绝，其余设置仍照常落盘，成功提示照常给出。
3. **失败范围收窄到该键**：`apiKey` 的 SecretStorage 写入**刻意不吞**——钥匙串真的拒绝时必须让用户知道，否则用户会以为供应商已配置好。失败时异常沿原路抛出，保存中止且不给成功提示。
4. **成功提示与重绘解耦**：`showInformationMessage` 先于重绘执行，且信息级提示不会覆盖同期的警告/错误；`openSettingsPage` 的失败单独 catch 并报「设置已保存，但设置页面重绘失败」，不再冒充保存失败。

## Alternatives considered

- **把失败统一弹成 `showErrorMessage`**：否决。设置写入失败时 VS Code 自己就会弹一次错误，重复弹窗只是噪音；输出通道 + 状态栏已足够定位，且日志里带了键名。
- **在 `chatPanel.ts` 的入口 catch 里把异常透出给用户**：否决。那里对所有 Webview 消息生效，等于给每个消息类型都加一个弹窗，会把一次设置失败放大成全局噪音。
- **给 SecretStorage 写失败加内存影子存储以保证「保存成功」**：否决。静默降级正是本次要消除的误解来源：用户必须知道自己的 Key 没有落到钥匙串，而不是拿到一个重启后失效的假成功。
- **在 `buildAndSendSettingsData` 外再包一层 try 让重绘永不失败**：否决。重绘确实会读七条线路的 SecretStorage 与桌面凭据，失败应当可见；把它降级为「已保存但重绘失败」的独立提示即可，不必让保存结果陪着一起失真。

## Consequences

- 未注册键这一整类故障从「静默中断保存」变成「点名一条 WARN + 其余设置照常保存」。
- `reasoningKey` 从「写不进 `settings.json`（但界面里能改）」变成真正持久化的设置；此前该字段只在同一次会话的 `getConfig()` 内存读取中有效。
- 回归测试 `client/test/unit/chatSettingsSave.test.ts` 通过 `module._load` 注入 `vscode` 桩并直接驱动真实 `ChatSettingsManager`：一个用例让 `provider` 模拟未注册键，断言其余键仍写入、成功提示仍出现、WARN 点名该键（把该行改回直写后该用例失败，异常类型与线上一致）；另一个用例让重绘抛错，断言仍报「已保存」。
- 已知余留：VS Code 把 SecretStorage 降级为内存存储时，本扩展不做额外提示（无法从扩展侧可靠探测该降级），用户仍可能在重启后发现 Key 丢失。
