---
description: 打包 CWTools VSCode 插件为 .vsix 格式（含 Win/Linux/macOS 三平台）
---

# 打包 CWTools VSCode 插件

所有命令在仓库根目录执行。
最终产物为一个通用 `.vsix` 文件（`release/foreverskywalker-stellaris-cwtools-<version>.vsix`），内含 `win-x64`、`linux-x64`、`osx-x64` 三组自包含服务端。

> **全新检出前置条件**：首次打包前需初始化子模块、构建 `cwtools-shared`，并在 `release/` 安装运行时依赖闭包（供 `vsce` 校验）：
> ```powershell
> git submodule update --init --recursive
> npm install
> Push-Location submodules/cwtools-mcp; npm ci; npm run build -w cwtools-shared; Pop-Location
> Push-Location release; npm ci --no-audit --no-fund; Pop-Location
> ```

---

## 💡 自动化打包捷径（推荐）

项目根目录提供了全自动打包与安装脚本 [package.ps1](../../package.ps1)，可通过 `package.json` 中的快捷命令调用：

* **仅一键打包通用包**（依次编译服务端、前端、打包规则、校验文档并生成 VSIX）：
  ```bash
  npm run pack
  ```
* **完整一键打包并本地安装**（打包后强制安装至本地 VS Code，并清理冲突的上游扩展）：
  ```bash
  npm run pack:install
  ```
* **极速前端调试模式**（跳过 .NET 服务端编译，仅重编译 TypeScript 与 Webview 并本地安装；不适用于全新检出）：
  ```bash
  npm run pack:quick
  ```
* **本地回退发布至 GitHub Release**（常规发布请直接推送 `v<version>` 标签由 CI 完成；仅在 CI 不可用时使用）：
  ```bash
  npm run pack:release
  ```

如果需要对流程进行更细粒度的控制，或排查手动编译细节，请依次参阅下述各步：

---

## 0. 更新版本号与变更日志（发布时）

在发版打包前，请确保同时更新根目录 `package.json` 与 `release/package.json` 的 `version` 字段（两者必须一致），并在 `release/CHANGELOG.md` 顶部记录中英双语更新日志。也可通过 `.\package.ps1 -Version <version>` 同步更新两处 `package.json`。

## 1. 编译服务端（三平台，自包含，含 .NET 10 运行时）

依次为三个平台发布 .NET 服务端。**不可并行执行**，否则 dotnet 会因文件锁冲突导致构建取消。版本号应与 `release/package.json` 一致（供能力握手上报）：

```powershell
$ver = (Get-Content release/package.json -Raw | ConvertFrom-Json).version
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/win-x64
dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/linux-x64
dotnet publish src/Main/Main.fsproj -c Release -r osx-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False /p:Version=$ver -o release/bin/server/osx-x64
```

> **说明**：
> - `PublishReadyToRun=true` 仅用于 `win-x64`（交叉编译 R2R 在 Linux/macOS 目标上不支持）。
> - `UseLocalCwtools=False` 确保使用 `submodules/cwtools` 中的源码。

## 2. 编译客户端与 Webview

```powershell
npm run compile
```

该命令依次执行 `tsc -p ./.config/tsconfig.extension.json` 与 `rollup -c`，自动输出扩展宿主 JS、所有 Webview bundle 及对应静态 CSS / `mermaid.min.js`。

## 3. 校验单源文档与生成 Marketplace README

```powershell
npm run build:docs
npm run check:release -- --skip-compile --skip-test
```

`npm run build:docs` 校验根目录双语文档，并从 `docs/marketplace-readme.md` 生成 `release/README.md`。

## 4. 打包 VSIX（通用包，含三平台）

不指定 `--target`，生成一个通用 `.vsix`（`package.ps1` 会先将 `submodules/cwtools-stellaris-config/config` 压缩为 `release/rules/stellaris-rules.zip` 并暂存 `steamworks.js`、`ignore`、`cwtools-shared` 等运行时依赖到 `release/node_modules`）：

```powershell
Push-Location release; npx @vscode/vsce package; Pop-Location
```

产物路径：`release/foreverskywalker-stellaris-cwtools-<version>.vsix`。

## 5. 本地安装

```powershell
$vsix = Get-ChildItem -Path release -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($vsix) {
    code --install-extension $vsix.FullName --force
} else {
    Write-Host "未找到可安装的 VSIX 包！"
}
```

---

## 6. 发布至 VS Code 市场与 GitHub Release

常规发布由标签触发 `.github/workflows/release.yml` 自动完成（在 Windows runner 上构建通用 VSIX、运行 `npm run check:release`、通过 GitHub OIDC Trusted Publishing 发布到 VS Code 市场，并以该版本更新日志创建或刷新 GitHub Release）：

```powershell
$ver = (Get-Content release/package.json -Raw | ConvertFrom-Json).version
$tag = "v$ver"
git tag $tag
git push origin main
git push origin $tag
```

详见 [CONTRIBUTING.md](../../CONTRIBUTING.md#发布版本) 与 [release-extension SKILL](../skills/release-extension/SKILL.md)。

---

## 注意事项

- 版本号以根 `package.json` 与 `release/package.json` 为唯一来源，不要在文档或注释中重复硬编码当前版本。
- `release/.vscodeignore` 已排除 `.cwtools/` 缓存目录、`*.js.map`、`bin/client/test` 与类型专用依赖。
- 服务端二进制路径在 `client/extension/extension.ts` 中根据 `process.platform` 自动选择：
  - `win32` → `bin/server/win-x64/CWTools Server.exe`
  - `darwin` → `bin/server/osx-x64/CWTools Server`
  - `linux` → `bin/server/linux-x64/CWTools Server`
- `package.ps1` 采用原地合并暂存，绝不执行递归删除，避免误伤符号链接或目录联接。