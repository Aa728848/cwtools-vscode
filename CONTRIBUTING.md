# Contributing / 贡献指南

<a id="english"></a>
## English

### Prerequisites

- Node.js 22+, npm 10+
- Stable Rust with rustfmt and clippy
- Git with recursive submodules
- VS Code 1.90+

No .NET SDK or runtime is used by the repository, build, tests, or release artifacts.

### Repository boundaries

- `client/extension/`: VS Code Extension Host and AI orchestration.
- `client/webview/`: browser-sandboxed Webviews.
- `rust/cwtools-lsp/`: standalone stdio Rust LSP server.
- `submodules/cwtools/crates/`: Rust parser, rules, scopes, workspace, cache, game, Shader, and semantic crates.
- `submodules/cwtools-mcp/`: separately released read-only MCP package.
- `submodules/cwtools-stellaris-config/`: Stellaris CWT rules.

Commit changes owned by a submodule inside that submodule first, then update the root pointer. Preserve unrelated work and update English and Chinese UI text together.

### Verification

```powershell
npm run compile
npm run typecheck:test
npm run test:unit
npm run test:rust-core
npm run test:rust-lsp
npm run check:mcp-schema
cd submodules/cwtools-mcp
npm run build
npm run test:contracts
```

`npm run pack` produces only a host-development VSIX. A release must use native CI artifacts for `win-x64`, `linux-x64`, and `osx-x64`, aggregate them with `npm run pack:universal`, pass the archive-level `npm run check:vsix -- --vsix <file>` gate, and publish only through `npm run pack:release` or the tag workflow. Missing or copied platform binaries fail closed. Run `npm run verify`, `npm run check:rust-only`, and all other non-long-running acceptance gates before the final soak. Never run the final 24-hour soak before those gates pass. Cache format changes must preserve safe miss/rebuild behavior.

<a id="zh-cn"></a>
## 中文

### 前置条件

- Node.js 22+、npm 10+
- 带 rustfmt 与 clippy 的稳定版 Rust
- 支持递归 submodule 的 Git
- VS Code 1.90+

仓库、构建、测试和发布产物均不使用 .NET SDK 或 runtime。

### 仓库边界

- `client/extension/`：VS Code Extension Host 与 AI 编排。
- `client/webview/`：浏览器沙箱 Webview。
- `rust/cwtools-lsp/`：独立 stdio Rust LSP。
- `submodules/cwtools/crates/`：Rust parser、rules、scopes、workspace、cache、游戏、Shader 与 semantic crates。
- `submodules/cwtools-mcp/`：独立发布的只读 MCP 包。
- `submodules/cwtools-stellaris-config/`：Stellaris CWT 规则。

子模块拥有的改动应先在子模块内提交，再更新根仓库指针。保留无关用户改动，用户可见文本同时更新中英文。

### 验收

`npm run pack` 只生成当前宿主平台的开发 VSIX。正式发布必须使用 `win-x64`、`linux-x64`、`osx-x64` 三个平台的原生 CI artifact，通过 `npm run pack:universal` 聚合，并通过 `npm run check:vsix -- --vsix <file>` 的归档级检查；只能使用 `npm run pack:release` 或 tag workflow 发布。缺失平台或复制其他平台二进制都会失败。先运行 `npm run verify`、`npm run check:rust-only` 及全部其他非长时门禁，全部通过后才能运行最终 24 小时 soak。缓存格式改变必须保持安全失效和自动重建。
