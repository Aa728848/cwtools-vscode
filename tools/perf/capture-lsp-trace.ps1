[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$ProcessId,

    [ValidateRange(5, 3600)]
    [int]$DurationSeconds = 60,

    [string]$OutputPath = "artifacts/lsp-perf/cwtools-lsp.nettrace"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command dotnet-trace -ErrorAction SilentlyContinue)) {
    throw "dotnet-trace was not found. Install it with: dotnet tool install --global dotnet-trace"
}

$target = Get-Process -Id $ProcessId -ErrorAction Stop
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputPath))
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$duration = [TimeSpan]::FromSeconds($DurationSeconds).ToString("c")
$runtimeProvider = "Microsoft-Windows-DotNETRuntime:0x1C001080019:5"

Write-Host "Capturing PID=$($target.Id) process=$($target.ProcessName) duration=$duration"
Write-Host "Output=$resolvedOutput"

dotnet-trace collect `
    --process-id $target.Id `
    --duration $duration `
    --output $resolvedOutput `
    --providers $runtimeProvider,Microsoft-DotNETCore-SampleProfiler

if ($LASTEXITCODE -ne 0) {
    throw "dotnet-trace exited with code $LASTEXITCODE"
}

Write-Host "Trace complete: $resolvedOutput"
