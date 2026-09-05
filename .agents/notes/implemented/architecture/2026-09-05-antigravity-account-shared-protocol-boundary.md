# Agent Note: Antigravity Account Shared Protocol Boundary Extraction

Status: implemented

## Problem
在执行 `npm run compile` / `rollup -c` 打包 Webview 脚本（`chatPanel.js` 与 `agentManager.js`）时，Rollup 输出了长达数十行的未解析依赖警告（`(!) Unresolved dependencies`），提示 `crypto`, `fs`, `path`, `vscode`, `http`, `child_process`, `undici`, `socks` 等模块作为外部依赖处理。
根本原因是 `client/webview/chatPanel.ts` 和 `client/webview/chat/antigravityAccount.ts` 直接从 `client/extension/ai/types.ts` 导入了 `AntigravityAccountStatus`。虽然使用了 `import type`，但 `rollup-plugin-typescript2` 仍将 Extension Host 模块树拉入分析上下文，导致整个 Extension 依赖网络（含 Node.js 原生 API 与 VS Code 依赖）被暴露给 Webview 构建流程，不仅引发告警，还导致 Webview 打包耗时成倍增加。

## Decision
1. 将 `AntigravityQuotaBucket`、`AntigravityAccountStatus` 以及运行时类型守卫 `isAntigravityAccountStatus` 抽离至协议共享目录 `client/shared/antigravityAccount.ts`，严格遵循 `client/shared/subscriptionProxy.ts` 的既有模式。
2. 在 `client/extension/ai/types.ts` 中重新导入并导出该类型与守卫，保障 Extension 内部代码向下兼容。
3. 将 `client/webview/chat/antigravityAccount.ts` 与 `client/webview/chatPanel.ts` 改为从 `shared` 目录引入，彻底切断 Webview 对 `client/extension/` 模块的直接依赖。

## Alternatives considered
- **在 `rollup.config.mjs` 中将所有 node 模块添加到 `external` 列表**：仅抑制了告警，未解决模块树被错误扫描解析的问题，打包耗时依然高且破坏了 Webview 不依赖 Extension 源码的架构边界。
- **在 Webview 内部重复定义 `AntigravityAccountStatus`**：违反了协议类型单点定义的仓库规范，增加后续协议升级时的维护与漂移风险。

## Consequences
- Webview 打包（Rollup）告警彻底消除，构建输出干净。
- `chatPanel.js` 构建耗时从 ~11.1 秒降至 ~2.2 秒，`agentManager.js` 从 ~9.7 秒降至 ~2.3 秒。
- 强化了 Extension 与 Webview 间的模块沙箱边界。
- 全部 2,350+ 个单元测试与 TypeScript 类型检查无损通过。
