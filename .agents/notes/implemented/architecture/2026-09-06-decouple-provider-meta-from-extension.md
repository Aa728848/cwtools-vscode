# Agent Note: Decouple ProviderMeta from Extension Types to Fix Webview Bundling

Status: implemented

## Problem
During extension packaging (`npm run pack:install` / `npx rollup -c`), Rollup emitted extensive unresolved external dependency warnings (`crypto`, `fs`, `path`, `vscode`, `http`, `child_process`, `undici`, etc.) when bundling `client/webview/chatPanel.ts` and `client/webview/agentManager.ts`.
Investigation revealed that `chatPanel.ts` imported `ProviderMeta` directly from `client/extension/ai/types.ts`. Even with `import type`, `rollup-plugin-typescript2` and Rollup traced the module tree of `types.ts`, which exported `AgentToolName` from `client/extension/ai/tools/registry.ts`. That brought in executable runtime code (`definitions.ts` and over 60 Extension Host files) into the browser-targeted IIFE bundle, violating the webview architectural boundary documented in `AGENTS.md`.

## Decision
1. Extracted `ProviderMeta` interface into a standalone shared module `client/shared/providerMeta.ts`.
2. Updated `client/extension/ai/types.ts` to re-export `ProviderMeta` from `../../shared/providerMeta`, maintaining 100% backward compatibility for Extension Host modules.
3. Updated `client/webview/chatPanel.ts` to import `ProviderMeta` from `../shared/providerMeta` instead of `../extension/ai/types`.

## Alternatives considered
1. **Adding Node modules to Rollup `external` in `rollup.config.mjs`**: Rejected. This would merely silence the warnings while leaving webviews importing Extension Host internals and pulling dead Node polyfill references into the browser bundle.
2. **Duplicating `ProviderMeta` in `client/webview/chatPanel.ts`**: Rejected. Duplicating communication interfaces across boundaries leads to silent type drift between the Extension Host and Webviews.

## Consequences
- Completely eliminated all unresolved dependency warnings during Rollup webview bundling.
- Webview bundle time dropped significantly (~11s down to ~2s for `chatPanel.js` and `agentManager.js`).
- Restored strict boundary separation where Webview code never references `client/extension/`.
