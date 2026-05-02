Write-Host "Publishing win-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64
Write-Host "Publishing linux-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/linux-x64
Write-Host "Publishing osx-x64..."
dotnet publish src/Main/Main.fsproj -c Release -r osx-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/osx-x64

Write-Host "Compiling frontend..."
npx tsc -p tsconfig.extension.json
npx rollup -c

Write-Host "Copying assets..."
Copy-Item "client\webview\solarSystemPreview.css" "release\bin\client\webview\" -Force
Copy-Item "client\webview\chatPanel.css" "release\bin\client\webview\" -Force

Write-Host "Packaging VSIX..."
Push-Location release
npx @vscode/vsce package
Pop-Location

Write-Host "Installing VSIX..."
$vsix = Get-ChildItem -Path release -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($vsix) {
    code --install-extension $vsix.FullName --force
    Write-Host "Installation complete!"
} else {
    Write-Host "未找到可安装的 VSIX 包！"
}
