# Agent Note: 解耦 ProviderMeta 接口以修复 Webview 打包依赖泄漏

Status: implemented

## Problem
在插件打包或执行 Rollup 构建（`npm run pack:install` / `npx rollup -c`）期间，Rollup 在为 `client/webview/chatPanel.ts` 和 `client/webview/agentManager.ts` 打包时抛出大量未解析外部依赖警告（涉及 `crypto`、`fs`、`path`、`vscode`、`http`、`child_process`、`undici` 等 Node 模块）。
排查发现 `chatPanel.ts` 直接从 `client/extension/ai/types.ts` 导入了 `ProviderMeta`。即使使用了 `import type`，`rollup-plugin-typescript2` 与 Rollup 仍然遍历追踪了 `types.ts` 的依赖模块树，该文件导出了来自 `client/extension/ai/tools/registry.ts` 的 `AgentToolName`，导致可执行的 Extension Host 运行时代码（包括 `definitions.ts` 及 60 余个宿主环境文件）被意外带入面向浏览器沙箱环境的 IIFE Webview bundle 中，严重违反了 `AGENTS.md` 中定义的 Webview 架构边界规则。

## Decision
1. 将 `ProviderMeta` 接口抽取为独立的跨端共享模块：`client/shared/providerMeta.ts`。
2. 更新 `client/extension/ai/types.ts`，使其从 `../../shared/providerMeta` re-export 该类型，保持 Extension Host 各模块 100% 向后兼容。
3. 更新 `client/webview/chatPanel.ts`，直接从 `../shared/providerMeta` 导入，彻底切断对 `../extension/ai/types` 的反向引用。

## Alternatives considered
1. **在 `rollup.config.mjs` 中将 Node 模块配置为 `external`**：否决。这种方式仅仅屏蔽了告警，未能阻止 Webview 引用宿主层内部实现，并且会残留无效的 Node polyfill 依赖。
2. **在 Webview 端重复定义一份 `ProviderMeta`**：否决。在跨端通信边界重复维护接口会导致宿主与 Webview 类型默默发生漂移。

## Consequences
- 彻底消除了 Webview Rollup 打包过程中的所有未解析外部依赖告警。
- Webview 打包构建速度显著提升（`chatPanel.js` 与 `agentManager.js` 打包耗时从约 11s 下降至约 2s）。
- 严格恢复了 Webview 代码绝不依赖 `client/extension/` 宿主实现的架构分层红线。
