#Requires -Version 5.1
<#
.SYNOPSIS
    CWTools VSCode Extension Package and Publish Automation Script.
.DESCRIPTION
    Compiles .NET LSP server (win/linux/osx), compiles typescript client and webviews,
    copies static resources, packs vsix, and optionally installs the extension locally.
.PARAMETER Version
    Specifies a new version (e.g. 2.2.3) to update in release/package.json.
.PARAMETER Install
    Force installs the newly generated VSIX package to the local VSCode instance.
.PARAMETER SkipServer
    Skips the F# .NET server compilation step to save time.
.PARAMETER SkipClient
    Skips typescript and webview Rollup compilation.
.EXAMPLE
    .\package.ps1 -Install
.EXAMPLE
    .\package.ps1 -Version 2.2.3 -Install
.EXAMPLE
    .\package.ps1 -SkipServer -Install
#>

[CmdletBinding()]
param (
    [string]$Version,
    [switch]$Install,
    [switch]$SkipServer,
    [switch]$SkipClient
)

$StartTime = Get-Date

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "         CWTools VSCode Extension Build Tool           " -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Update Version in package.json
if ($Version) {
    Write-Host "[*] Updating version to $Version ..." -ForegroundColor Yellow
    $PackageJsonPath = Join-Path $PSScriptRoot "release/package.json"
    if (Test-Path $PackageJsonPath) {
        $JsonContent = Get-Content -Path $PackageJsonPath -Raw | ConvertFrom-Json
        $OldVersion = $JsonContent.version
        $JsonContent.version = $Version
        $JsonContent | ConvertTo-Json -Depth 100 | Out-File -FilePath $PackageJsonPath -Encoding utf8
        Write-Host "[✓] Successfully updated release/package.json: $OldVersion -> $Version" -ForegroundColor Green
        Write-Host "[!] Remember to log the updates in release/CHANGELOG.md!" -ForegroundColor Yellow
    } else {
        Write-Error "Could not find release/package.json"
        exit 1
    }
}

# 2. Compile F# Server (win-x64, linux-x64, osx-x64)
if (-not $SkipServer) {
    Write-Host "[1/5] Compiling F# server (3 platforms, sequentially)..." -ForegroundColor Yellow
    
    # win-x64 (ReadyToRun optimization)
    Write-Host ">>> Publishing win-x64 (ReadyToRun=true)..." -ForegroundColor Cyan
    dotnet publish src/Main/Main.fsproj -c Release -r win-x64 --self-contained true /p:PublishReadyToRun=true /p:UseLocalCwtools=False -o release/bin/server/win-x64
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to publish win-x64 server!"
        exit $LASTEXITCODE
    }
    Write-Host "[✓] win-x64 server published successfully." -ForegroundColor Green

    # linux-x64
    Write-Host ">>> Publishing linux-x64..." -ForegroundColor Cyan
    dotnet publish src/Main/Main.fsproj -c Release -r linux-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/linux-x64
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to publish linux-x64 server!"
        exit $LASTEXITCODE
    }
    Write-Host "[✓] linux-x64 server published successfully." -ForegroundColor Green

    # osx-x64
    Write-Host ">>> Publishing osx-x64..." -ForegroundColor Cyan
    dotnet publish src/Main/Main.fsproj -c Release -r osx-x64 --self-contained true /p:PublishReadyToRun=false /p:UseLocalCwtools=False -o release/bin/server/osx-x64
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to publish osx-x64 server!"
        exit $LASTEXITCODE
    }
    Write-Host "[✓] osx-x64 server published successfully." -ForegroundColor Green
} else {
    Write-Host "[1/5] (SKIPPED) Skip F# server compilation." -ForegroundColor Gray
}

# 3. Compile Client TypeScript
if (-not $SkipClient) {
    Write-Host "[2/5] Compiling client TypeScript extension host..." -ForegroundColor Yellow
    npx tsc -p tsconfig.extension.json
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript compilation failed!"
        exit $LASTEXITCODE
    }
    Write-Host "[✓] Client TypeScript compiled successfully." -ForegroundColor Green
} else {
    Write-Host "[2/5] (SKIPPED) Skip client TypeScript compilation." -ForegroundColor Gray
}

# 4. Compile Webview and Copy CSS Assets
if (-not $SkipClient) {
    Write-Host "[3/5] Bundling Webview scripts (Rollup)..." -ForegroundColor Yellow
    npx rollup -c
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Rollup bundling failed!"
        exit $LASTEXITCODE
    }
    Write-Host "[✓] Webview bundling completed successfully." -ForegroundColor Green

    Write-Host "[4/5] Copying static webview assets..." -ForegroundColor Yellow
    $DestCssDir = Join-Path $PSScriptRoot "release/bin/client/webview"
    if (-not (Test-Path $DestCssDir)) {
        New-Item -ItemType Directory -Path $DestCssDir -Force | Out-Null
    }
    Copy-Item "client/webview/solarSystemPreview.css" "$DestCssDir/" -Force
    Copy-Item "client/webview/chatPanel.css" "$DestCssDir/" -Force
    Write-Host "[✓] Static CSS assets copied successfully." -ForegroundColor Green
} else {
    Write-Host "[3/5 & 4/5] (SKIPPED) Skip Webview compilation and asset copying." -ForegroundColor Gray
}

# 5. Package VSIX Universal Bundle
Write-Host "[5/5] Packaging universal VSIX bundle..." -ForegroundColor Yellow
Push-Location release
npx @vscode/vsce package
$VsceExitCode = $LASTEXITCODE
Pop-Location

if ($VsceExitCode -ne 0) {
    Write-Error "VSCE packaging failed!"
    exit $VsceExitCode
}

$VsixFile = Get-ChildItem -Path (Join-Path $PSScriptRoot "release") -Filter *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($VsixFile) {
    $SizeMB = [Math]::Round($VsixFile.Length / 1MB, 2)
    Write-Host ""
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host "                  BUILD SUCCESSFUL                      " -ForegroundColor Green
    Write-Host "   VSIX Path: $($VsixFile.FullName)" -ForegroundColor Green
    Write-Host "   File Size: $SizeMB MB" -ForegroundColor Green
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Warning "Could not find any generated VSIX file!"
}

# 6. Local Installation
if ($Install) {
    if ($VsixFile) {
        Write-Host "[*] Executing local installation (code --install-extension)..." -ForegroundColor Yellow
        code --install-extension $VsixFile.FullName --force
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "🚀 Extension installed and upgraded successfully!" -ForegroundColor Green
            Write-Host "👉 Tip: Execute [Developer: Reload Window] in VSCode to apply updates!" -ForegroundColor Green
            Write-Host ""
        } else {
            Write-Warning "Installation command returned a non-zero code. Make sure 'code' CLI is in your PATH."
        }
    } else {
        Write-Error "No VSIX bundle found to install!"
    }
}

$EndTime = Get-Date
$Duration = $EndTime - $StartTime
Write-Host "🕒 Build finished. Total duration: $($Duration.Minutes)m $($Duration.Seconds)s." -ForegroundColor Cyan
