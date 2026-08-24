<a id="english"></a>
# CWTools VS Code

[English](#english) · [中文](#中文)

## English

CWTools VS Code provides a standalone **Rust** language server for Paradox script, CWT rules, localisation, GUI/GFX assets, and Paradox Shader files. The extension bundles the server; end users do not need Rust, .NET, or a separate runtime.

### Features

- UTF-16-correct parsing, overlays, diagnostics, completion, hover, navigation, references, rename, symbols, semantic tokens, formatting, folding, call hierarchy, and code actions.
- CWT parsing, rule IR, scopes, validation, project indexing, full/incremental snapshots, and versioned bounded caches.
- Generic/Custom/Jomini, CK2, CK3, EU4, EU5, HOI4, Imperator, VIC2, VIC3, Stellaris, and CWT-only profiles.
- Rust Shader syntax, preprocessing, include graphs, HLSL symbols, platform variants, reachability, validation, and compile-unit queries.
- Read-only semantic commands used by the extension AI tools and standalone MCP package.

### Install

Install the VSIX or Marketplace extension. Packaged servers live at:

- Windows: `release/bin/server/win-x64/CWTools Server.exe`
- Linux: `release/bin/server/linux-x64/CWTools Server`
- macOS: `release/bin/server/osx-x64/CWTools Server`

### Development

Requirements: Node.js 22+, npm 10+, stable Rust (rustfmt and clippy), Git with submodules, and VS Code 1.90+.

```powershell
git submodule update --init --recursive
npm ci
npm run compile
npm run test:unit
npm run test:rust-core
npm run test:rust-lsp
npm run verify
npm run pack
```

Cache files are schema/fingerprint checked. Old or corrupt cache files are treated as safe misses and rebuilt automatically.

Release acceptance uses `npm run check:rust-only`, all non-long-running gates, then the final `npm run soak:rust-24h` and `npm run soak:rust-verify` report check.

<a id="zh-cn"></a>
## 中文

CWTools VS Code 为 Paradox 脚本、CWT 规则、本地化、GUI/GFX 资源和 Paradox Shader 提供独立的 **Rust** 语言服务。扩展已经包含服务端；最终用户不需要 Rust、.NET 或其他独立运行时。

### 功能

- UTF-16 正确的解析、文档覆盖层、诊断、补全、悬停、导航、引用、重命名、符号、语义标记、格式化、折叠、调用层级和代码操作。
- CWT 解析、规则 IR、作用域、验证、项目索引、全量/增量快照及有界版本化缓存。
- Generic/Custom/Jomini、CK2、CK3、EU4、EU5、HOI4、Imperator、VIC2、VIC3、Stellaris 与 CWT-only 游戏模型。
- Rust Shader 语法、预处理、include 图、HLSL 符号、平台变体、可达性、验证与编译单元查询。
- 供扩展 AI 工具及独立 MCP 包使用的只读语义命令。

### 开发

需要 Node.js 22+、npm 10+、稳定版 Rust（rustfmt、clippy）、支持 submodule 的 Git，以及 VS Code 1.90+。

```powershell
git submodule update --init --recursive
npm ci
npm run compile
npm run test:unit
npm run test:rust-core
npm run test:rust-lsp
npm run verify
npm run pack
```

缓存会检查 schema 与指纹；旧缓存或损坏缓存会安全失效并自动重建。发布验收先运行 `npm run check:rust-only` 与全部非长时门禁，最后运行 `npm run soak:rust-24h`，并用 `npm run soak:rust-verify` 核验报告。
