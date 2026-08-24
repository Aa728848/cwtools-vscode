#Requires -Version 5.1
<#
.SYNOPSIS
    Packages the Rust-only CWTools VS Code extension.
.DESCRIPTION
    Builds the standalone Rust language server for the current host, compiles the client,
    stages resources, and creates the universal VSIX. Cross-platform release lanes invoke
    this script once per target and merge release/bin/server/<rid> before packaging.
#>
[CmdletBinding()]
param (
    [string]$Version,
    [switch]$Install,
    [switch]$SkipServer,
    [switch]$SkipClient,
    [switch]$IncludeMcp,
    [switch]$Publish,
    [switch]$SkipDocs
)
$StartTime = Get-Date
if ($Version) {
    foreach ($file in @((Join-Path $PSScriptRoot "package.json"), (Join-Path $PSScriptRoot "release/package.json"))) {
        node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,4)+"\n")' $file $Version
    }
}
if (-not $SkipServer) {
    $Target = if ($IsWindows -or $env:OS -eq "Windows_NT") { "x86_64-pc-windows-msvc" } elseif ($IsMacOS) { "x86_64-apple-darwin" } else { "x86_64-unknown-linux-gnu" }
    $Rid = if ($IsWindows -or $env:OS -eq "Windows_NT") { "win-x64" } elseif ($IsMacOS) { "osx-x64" } else { "linux-x64" }
    $SourceName = if ($Rid -eq "win-x64") { "cwtools-lsp.exe" } else { "cwtools-lsp" }
    $DestinationName = if ($Rid -eq "win-x64") { "CWTools Server.exe" } else { "CWTools Server" }
    cargo build --manifest-path rust/Cargo.toml --release --locked --target $Target
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $Source = Join-Path $PSScriptRoot "rust/target/$Target/release/$SourceName"
    $DestinationDir = Join-Path $PSScriptRoot "release/bin/server/$Rid"
    New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination (Join-Path $DestinationDir $DestinationName) -Force
}

# 3. Compile Client TypeScript
if (-not $SkipClient) {
    Write-Host "[2/6] Compiling client TypeScript extension host..." -ForegroundColor Yellow
    $WebviewOutDir = Join-Path $PSScriptRoot "release/bin/client/webview"
    if (Test-Path $WebviewOutDir) {
        Remove-Item -LiteralPath $WebviewOutDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $WebviewOutDir -Force | Out-Null
    npx tsc -p .config/tsconfig.extension.json
    if ($LASTEXITCODE -ne 0) {
        Write-Error "TypeScript compilation failed!"
        exit $LASTEXITCODE
    }
    Write-Host "[OK] Client TypeScript compiled successfully." -ForegroundColor Green
} else {
    Write-Host "[2/6] (SKIPPED) Skip client TypeScript compilation." -ForegroundColor Gray
}

# 4. Compile Webview and Copy CSS Assets
if (-not $SkipClient) {
    Write-Host "[3/6] Bundling Webview scripts (Rollup)..." -ForegroundColor Yellow
    npx rollup -c
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Rollup bundling failed!"
        exit $LASTEXITCODE
    }
    Write-Host "[OK] Webview bundling completed successfully." -ForegroundColor Green

    Write-Host "[4/6] Copying static webview assets and bundled rules..." -ForegroundColor Yellow
    $DestCssDir = Join-Path $PSScriptRoot "release/bin/client/webview"
    if (-not (Test-Path $DestCssDir)) {
        New-Item -ItemType Directory -Path $DestCssDir -Force | Out-Null
    }
    Copy-Item "client/webview/solarSystemPreview.css" "$DestCssDir/" -Force
    Copy-Item "client/webview/chatPanel.css" "$DestCssDir/" -Force
    $RulesSourceDir = Join-Path $PSScriptRoot "submodules/cwtools-stellaris-config/config"
    $RulesRepoDir = Split-Path $RulesSourceDir -Parent
    $RulesDestZip = Join-Path $PSScriptRoot "release/rules/stellaris-rules.zip"
    $RulesVersionPath = [System.IO.Path]::ChangeExtension($RulesDestZip, ".version.json")
    if (-not (Test-Path $RulesSourceDir)) {
        Write-Error "Bundled Stellaris rules source not found: $RulesSourceDir"
        exit 1
    }
    $RulesCommit = (& git -C $RulesRepoDir rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $RulesCommit) {
        Write-Error "Failed to read bundled Stellaris rules commit from: $RulesRepoDir"
        exit 1
    }
    $RulesCommittedAtUnixSeconds = (& git -C $RulesRepoDir show -s --format=%ct HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $RulesCommittedAtUnixSeconds -notmatch '^\d+$') {
        Write-Error "Failed to read bundled Stellaris rules commit timestamp from: $RulesRepoDir"
        exit 1
    }
    $RulesDestDir = Split-Path $RulesDestZip -Parent
    if (-not (Test-Path $RulesDestDir)) {
        New-Item -ItemType Directory -Path $RulesDestDir -Force | Out-Null
    }
    # Remove legacy folder and old ZIP
    $LegacyDir = Join-Path $PSScriptRoot "release/rules/stellaris"
    if (Test-Path $LegacyDir) { Remove-Item -LiteralPath $LegacyDir -Recurse -Force }
    if (Test-Path $RulesDestZip) { Remove-Item -LiteralPath $RulesDestZip -Force }
    if (Test-Path $RulesVersionPath) { Remove-Item -LiteralPath $RulesVersionPath -Force }
    Compress-Archive -Path (Join-Path $RulesSourceDir "*") -DestinationPath $RulesDestZip -CompressionLevel Optimal
    $RulesVersion = [ordered]@{
        schemaVersion = 1
        commit = $RulesCommit
        committedAtUnixSeconds = [long]$RulesCommittedAtUnixSeconds
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($RulesVersionPath, $RulesVersion, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[OK] Bundled Stellaris rules compressed to ZIP successfully." -ForegroundColor Green
    Write-Host "[OK] Static CSS assets copied successfully." -ForegroundColor Green
} else {
    Write-Host "[3/6 & 4/6] (SKIPPED) Skip Webview compilation and asset copying." -ForegroundColor Gray
}

# 5. (Opt-in) Build and bundle the MCP server (shipped inside the extension at bin/mcp)
# The MCP server moved to the submodules/cwtools-mcp repository and is installed
# standalone (npx -y cwtools-mcp); the VSIX no longer carries it by default.
if ($IncludeMcp) {
    Write-Host "[5/6] Building and bundling MCP server from submodule (bin/mcp)..." -ForegroundColor Yellow
    $McpSubmodule = Join-Path $PSScriptRoot "submodules/cwtools-mcp"
    if (-not (Test-Path (Join-Path $McpSubmodule "packages/cwtools-mcp"))) {
        Write-Error "cwtools-mcp submodule not found at $McpSubmodule. Run: git submodule update --init"
        exit 1
    }
    Push-Location $McpSubmodule
    npm run build -w cwtools-mcp
    $McpBuildExit = $LASTEXITCODE
    Pop-Location
    if ($McpBuildExit -ne 0) {
        Write-Error "MCP TypeScript build failed!"
        exit $McpBuildExit
    }
    $McpOut = Join-Path $PSScriptRoot "release/bin/mcp/cwtools-mcp.cjs"
    $McpOutDir = Split-Path $McpOut -Parent
    if (-not (Test-Path $McpOutDir)) {
        New-Item -ItemType Directory -Path $McpOutDir -Force | Out-Null
    }
    npx esbuild submodules/cwtools-mcp/packages/cwtools-mcp/dist/cli.js --bundle --platform=node --format=cjs --target=node18 --outfile=$McpOut
    if ($LASTEXITCODE -ne 0) {
        Write-Error "MCP bundling failed!"
        exit $LASTEXITCODE
    }
    Write-Host "[OK] MCP server bundled to release/bin/mcp/cwtools-mcp.cjs" -ForegroundColor Green
} else {
    Write-Host "[5/6] (SKIPPED) MCP server is not bundled by default (use -IncludeMcp to opt in)." -ForegroundColor Gray
}

# 6. Package VSIX Universal Bundle
Write-Host "[6/6] Packaging universal VSIX bundle..." -ForegroundColor Yellow
if (-not $SkipDocs) {
    $GithubDocsBuilder = Join-Path $PSScriptRoot "tools/build-github-docs.js"
    Write-Host ">>> Checking single-source bilingual docs..." -ForegroundColor Cyan
    node $GithubDocsBuilder
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to check single-source bilingual documentation!"
        exit $LASTEXITCODE
    }
    $ReadmeBuilder = Join-Path $PSScriptRoot "tools/build-release-readme.js"
    Write-Host ">>> Building release README from root README.md..." -ForegroundColor Cyan
    node $ReadmeBuilder
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to build release README from root README.md!"
        exit $LASTEXITCODE
    }
} else {
    Write-Host ">>> Skipping documentation checks and release README generation." -ForegroundColor Gray
}
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
            # The upstream extension starts a competing language server and must not
            # remain installed alongside this fork. VSIX manifests cannot declare
            # conflicting extensions, so enforce the replacement in this install flow.
            $ConflictingExtensionIds = @(
                "foreverskywalker.eddy-stellaris-cwt",
                "ForeverSkywalker.eddy-stellaris-cwt",
                "Eddy.eddy-stellaris-cwt",
                "tboby.cwtools-vscode"
            )
            $InstalledExtensions = @(code --list-extensions 2>$null)
            if ($LASTEXITCODE -eq 0) {
                foreach ($ConflictingExtensionId in $ConflictingExtensionIds) {
                    if ($InstalledExtensions -notcontains $ConflictingExtensionId) { continue }
                    Write-Host "[*] Removing conflicting extension: $ConflictingExtensionId ..." -ForegroundColor Yellow
                    code --uninstall-extension $ConflictingExtensionId
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "[OK] Conflicting CWTools extension was uninstalled: $ConflictingExtensionId" -ForegroundColor Green
                    } else {
                        Write-Warning "Could not uninstall $ConflictingExtensionId automatically. Run: code --uninstall-extension $ConflictingExtensionId"
                    }
                }
            } elseif ($LASTEXITCODE -ne 0) {
                Write-Warning "Could not inspect installed extensions; skipped the CWTools conflict check."
            }

            Write-Host ""
            Write-Host "[OK] Extension installed and upgraded successfully!" -ForegroundColor Green
            Write-Host "[OK] Tip: Execute [Developer: Reload Window] in VSCode to apply updates!" -ForegroundColor Green
            Write-Host ""
        } else {
            Write-Warning "Installation command returned a non-zero code. Make sure 'code' CLI is in your PATH."
        }
    } else {
        Write-Error "No VSIX bundle found to install!"
    }
}

# 7. GitHub Release Publishing
if ($Publish) {
    if ($VsixFile) {
        Write-Host "[*] Executing GitHub Release publishing via gh CLI..." -ForegroundColor Yellow
        $PkgJson = Get-Content -Path (Join-Path $PSScriptRoot "release/package.json") -Raw | ConvertFrom-Json
        $CurrentVer = $PkgJson.version
        $TagName = "v$CurrentVer"
        Write-Host ">>> Target release tag: $TagName" -ForegroundColor Cyan
        
        $GitStatus = & git status --short
        if ($GitStatus) {
            Write-Host ">>> Committing version bump & changelog..." -ForegroundColor Cyan
            git commit -am "Bump version to $CurrentVer and add changelog"
        }
        
        Write-Host ">>> Tagging and pushing $TagName to GitHub..." -ForegroundColor Cyan
        git tag $TagName 2>$null
        git push origin main
        git push origin $TagName
        
        Write-Host ">>> Creating GitHub Release on Aa728848/cwtools-vscode..." -ForegroundColor Cyan
        gh release create $TagName $VsixFile.FullName --repo Aa728848/cwtools-vscode --title $TagName --generate-notes
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] GitHub Release $TagName published successfully!" -ForegroundColor Green
        } else {
            Write-Warning "GitHub Release publishing returned non-zero exit code."
        }
    } else {
        Write-Error "No VSIX bundle found to publish!"
    }
}

$EndTime = Get-Date
$Duration = $EndTime - $StartTime
Write-Host "[OK] Build finished. Total duration: $($Duration.Minutes)m $($Duration.Seconds)s." -ForegroundColor Cyan
