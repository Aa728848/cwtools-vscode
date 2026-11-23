---
description: 打包 CWTools VSCode 插件为 .vsix 格式（含 Win/Linux/macOS 三平台）
---

# 打包 CWTools VSCode 插件

所有命令在仓库根目录执行。最终产物为通用 `.vsix`（`release/foreverskywalker-stellaris-cwtools-<version>.vsix`），内置 `win-x64`、`linux-x64`、`osx-x64` 自包含服务端。

> **全新检出前置条件**：
> ```powershell
> git submodule update --init --recursive
> npm install
> Push-Location submodules/cwtools-mcp; npm ci; npm run build -w cwtools-shared; Pop-Location
> Push-Location release; npm ci --no-audit --no-fund; Pop-Location
> ```

## 一键脚本（推荐）

由根目录 [package.ps1](../../package.ps1) 驱动：

- `npm run pack` — 构建三平台服务端、编译前端、打包规则、校验文档并生成 VSIX。
- `npm run pack:install` — 打包并强制安装到本地 VS Code（清理冲突的上游扩展）。
- `npm run pack:quick` — 复用已有服务端二进制，仅重编前端并本地安装（不适用于全新检出）。
- `npm run pack:release` — 仅作 CI 不可用时的本地 GitHub Release 回退。

## 手动分步命令（排障参考）

1. **同步版本号与日志**：保持根 `package.json` 与 `release/package.json` 一致（可用 `.\package.ps1 -Version <ver>` 同步），在 `release/CHANGELOG.md` 顶部补充双语更新日志。
2. **串行发布三平台 .NET 10 服务端**（不可并行，否则文件锁冲突；仅 `win-x64` 开启 ReadyToRun）：
   ```powershell
   $ver = (Get-Content release/package.json -Raw | ConvertFrom-Json).version
   dotnet publish src/Main/Main.fsproj -c Release -r win-x64   --self-contained true /p:PublishReadyToRun=true  /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/win-x64
   dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/linux-x64
   dotnet publish src/Main/Main.fsproj -c Release -r osx-x64   --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/osx-x64
   ```
3. **编译前端与校验文档**：
   ```powershell
   npm run compile
   npm run build:docs
   npm run check:release -- --skip-compile --skip-test
   ```
4. **打包 VSIX**（`package.ps1` 会先打包 `release/rules/stellaris-rules.zip` 并原地合并暂存运行时依赖，不执行递归删除）：
   ```powershell
   Push-Location release; npx @vscode/vsce package; Pop-Location
   ```
5. **本地安装**：
   ```powershell
   $vsix = Get-ChildItem -Path release -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
   if ($vsix) { code --install-extension $vsix.FullName --force }
   ```
6. **发版**：推送与两份 `package.json` 一致的 `v<version>` 标签即可触发 `.github/workflows/release.yml` 自动构建与发布。完整发版 SOP 见 [release-extension SKILL](../skills/release-extension/SKILL.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md#发布版本)。
