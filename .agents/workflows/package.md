---
description: 打包 CWTools VSCode 插件为 .vsix 格式
---

# 打包 CWTools VSCode 插件

所有命令在项目根目录 `c:\Users\A\Documents\cwtools-vscode` 下执行。

## 1. 编译服务端（自包含，含 .NET 运行时）

// turbo
``powershell
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64
``

## 2. 编译客户端（TypeScript）

// turbo
``powershell
npx tsc -p tsconfig.extension.json
``

## 3. 编译 Webview 脚本（Rollup 打包）

// turbo
``powershell
npx rollup -c
``

## 4. 复制 Webview 静态资源

// turbo
``powershell
Copy-Item "client\webview\solarSystemPreview.css" "release\bin\client\webview\" -Force
``

## 5. 打包 VSIX

// turbo
``powershell
Push-Location release; npx @vscode/vsce package; Pop-Location
``

## 注意事项

- `release/package.json` 中包含发布者、版本号等信息，修改后需重新打包
- `.vscodeignore` 已配置排除 `.cwtools/` 缓存目录和 `*.js.map` 文件
- 打包前确认 `release/__metadata` 字段已移除（会干扰 VSCode 加载）
- 事件流程图功能已于 2026-04-19 移除，相关文件：`graph.ts`、`graphPanel.ts`、`graphTypes.ts`
- 性能分析器功能已于 2026-04-18 移除，相关文件：`performanceHints.ts`
- 星系可视化预览功能于 1.3.0 版本加入，相关文件：`solarSystemParser.ts`、`solarSystemPanel.ts`、`solarSystemPreview.ts`、`solarSystemPreview.css`
// turbo-all