---
description: 打包 CWTools VSCode 插件为 .vsix 格式（含 Win/Linux/macOS 三平台）
---

# 打包 CWTools VSCode 插件

所有命令在项目根目录 `c:\Users\A\Documents\cwtools-vscode` 下执行。
最终产物为一个通用 `.vsix` 文件，内含 win-x64、linux-x64、osx-x64 三组自包含服务端。

---

## 1. 编译服务端（三平台，自包含，含 .NET 运行时）

依次为三个平台发布 .NET 服务端。**不可并行执行**，否则 dotnet 会因锁冲突导致构建取消。

// turbo
```powershell
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64
```

// turbo
```powershell
dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/linux-x64
```

// turbo
```powershell
dotnet publish src/Main/Main.fsproj -c Release -r osx-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/osx-x64
```

> **说明**：
> - `PublishReadyToRun=true` 仅用于 win-x64（交叉编译 R2R 在 linux/osx 目标上不支持）
> - `UseLocalCwtools=False` 使用 submodule 中的 cwtools 源码

## 2. 编译客户端（TypeScript）

// turbo
```powershell
npx tsc -p tsconfig.extension.json
```

## 3. 编译 Webview 脚本（Rollup 打包）

// turbo
```powershell
npx rollup -c
```

## 4. 复制 Webview 静态资源

// turbo
```powershell
Copy-Item "client\webview\solarSystemPreview.css" "release\bin\client\webview\" -Force
```

## 5. 打包 VSIX（通用包，含三平台）

不指定 `--target`，生成一个通用 `.vsix`，内含全部三组平台服务端。

// turbo
```powershell
Push-Location release; npx @vscode/vsce package; Pop-Location
```

产物路径：`release/eddy-stellaris-cwt-<version>.vsix`

---

## 注意事项

- `release/package.json` 中包含发布者、版本号等信息，修改后需重新打包
- `.vscodeignore` 已配置排除 `.cwtools/` 缓存目录、`*.js.map` 和 `bin/client/test`
- 打包前确认 `release/__metadata` 字段已移除（会干扰 VSCode 加载）
- 服务端二进制路径在 `client/extension/extension.ts` 中根据 `process.platform` 自动选择：
  - `win32` → `bin/server/win-x64/CWTools Server.exe`
  - `darwin` → `bin/server/osx-x64/CWTools Server`
  - `linux` → `bin/server/linux-x64/CWTools Server`
- 事件流程图功能已于 2026-04-19 移除，相关文件：`graph.ts`、`graphPanel.ts`、`graphTypes.ts`
- 性能分析器功能已于 2026-04-18 移除，相关文件：`performanceHints.ts`
- 星系可视化预览功能于 1.3.0 版本加入，相关文件：`solarSystemParser.ts`、`solarSystemPanel.ts`、`solarSystemPreview.ts`、`solarSystemPreview.css`
- F# 后端 `IGameDispatcher` 多态化分发及 `agentRunner.ts` 代理核心模块化剥离已于 2026-04-25 完成重建，大幅消减了 10 向 `match` 匹配与代码冗余耦合。
// turbo-all