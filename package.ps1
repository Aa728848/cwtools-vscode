$ErrorActionPreference = "Stop"

Write-Host "Building win-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64

Write-Host "Building linux-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/linux-x64

Write-Host "Building osx-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r osx-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/osx-x64

Write-Host "Compiling TypeScript..."
npx tsc -p tsconfig.extension.json

Write-Host "Compiling Rollup..."
npx rollup -c

Write-Host "Copying assets..."
Copy-Item "client\webview\solarSystemPreview.css" "release\bin\client\webview\" -Force

Write-Host "Packaging VSIX..."
Push-Location release
npx @vscode/vsce package
Pop-Location

Write-Host "Installing to VSCode..."
code --install-extension release/eddy-stellaris-cwt-1.6.7.vsix
