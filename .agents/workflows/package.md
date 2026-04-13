---
description: 打包 CWTools VSCode 插件为 .vsix 格式
---

# 打包 CWTools VSCode 插件

所有命令在项目根目录 `c:\Users\A\Documents\cwtools-vscode` 下执行。

## 1. 编译服务端（自包含，含 .NET 运行时）

// turbo
```powershell
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64
```

> **重要**：必须使用 `dotnet publish --self-contained`，不能用 `dotnet build`。
> `dotnet build` 生成的是框架依赖型应用，用户机器上没有 .NET 9 就无法启动服务端。

## 2. 编译客户端 TypeScript

// turbo
```powershell
npx tsc -p ./tsconfig.extension.json
```

## 3. 编译 Webview（图表功能）

// turbo
```powershell
npx rollup -c -o ./release/bin/client/webview/graph.js
```

## 4. 安装 release 目录的 npm 依赖

仅首次或依赖变更时需要执行。

```powershell
cd release
npm install --omit=dev
cd ..
```

> **注意**：`release/node_modules` 必须存在，否则插件运行时找不到 `vscode-languageclient` 等依赖会无法启动。

## 5. 打包为 .vsix

```powershell
cd release
npx @vscode/vsce package
cd ..
```

产出文件位于 `release/eddy-stellaris-cwt-{version}.vsix`。

## 6.（可选）部署到本地测试

```powershell
# 将编译产物部署到已安装的插件目录，无需重新安装 vsix
Copy-Item -Path .\release\bin\server\win-x64\* -Destination 'C:\Users\A\.vscode\extensions\eddy.eddy-stellaris-cwt-1.0.0\bin\server\win-x64' -Recurse -Force
Copy-Item -Path .\release\bin\client\extension\* -Destination 'C:\Users\A\.vscode\extensions\eddy.eddy-stellaris-cwt-1.0.0\bin\client\extension' -Recurse -Force
```

部署后重启 VSCode 生效。

## 快速打包（一行命令）

```powershell
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64; npx tsc -p ./tsconfig.extension.json; npx rollup -c -o ./release/bin/client/webview/graph.js; Push-Location release; npx @vscode/vsce package; Pop-Location
```

## 注意事项

- `release/package.json` 中包含发布者、版本号等信息，修改后需重新打包
- `.vscodeignore` 已配置排除 `.cwtools/` 缓存目录和 `*.js.map` 文件
- 打包前确认 `release/__metadata` 字段已移除（会干扰 VSCode 加载）
