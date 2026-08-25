---
description: 构建并打包 Rust-only CWTools VS Code 扩展
---

# Rust-only 打包流程

所有命令在仓库根目录执行。最终 VSIX 使用固定布局：

- Windows: `release/bin/server/win-x64/CWTools Server.exe`
- Linux: `release/bin/server/linux-x64/CWTools Server`
- macOS: `release/bin/server/osx-x64/CWTools Server`

## 本机构建与打包

`npm run pack` 只构建当前宿主平台的 standalone Rust 服务端、TypeScript 客户端和 Webview，生成 host-only 开发 VSIX；它永远不用于正式发布。服务端不可跳过。

```powershell
npm ci
npm run verify
npm run check:rust-only
npm run pack
```

本地打包并安装：

```powershell
npm run pack:install
```

## 三平台发布 artifact

GitHub Actions 的 `rust-release-artifacts` matrix 在 Windows、Linux、macOS 原生 runner 上分别构建并上传三组 Rust 二进制。合并 artifact 后运行 `npm run pack:universal`；该命令在打包前检查三个 staging binary，打包后再检查 PE/ELF/Mach-O 签名、三个不同哈希、rules/version、manifest/README、无 MCP、无 .NET/迁移 runtime。缺少任何平台都会直接失败，不得用其他平台的二进制占位。需要在本地聚合某次 CI run 时使用 `npm run pack:universal:download -- <run-id>`。

## 发布顺序

1. 更新根目录和 `release/package.json` 的版本与 changelog。
2. 完成 TypeScript、Rust core、Rust LSP、MCP、文档与 release gate。
3. 确认三平台 artifact 使用上述最终布局。
4. 执行 `npm run check:rust-only` 并检查 VSIX 文件列表。
5. 只在其他门禁全部通过且仓库 clean 后运行最终 24 小时 soak 与严格报告核验。
6. 为已验证的 clean commit 创建版本 tag；只能用 `npm run pack:release` 发布恰好匹配该 tag/version 且已通过 archive gate 的 universal VSIX。该命令不会自动提交或创建 tag。

VSIX 不包含 MCP；MCP 是独立发布的只读包。任何缓存均不得打包，旧或损坏缓存由 Rust 服务端按 schema/指纹安全重建。
