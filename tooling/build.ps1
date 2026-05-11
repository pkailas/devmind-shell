<#
.SYNOPSIS
  Build the DevMind release zip for Windows x64.

.DESCRIPTION
  Compiles DevMindShell (Bun) and publishes DevMind.McpServer (self-contained .NET 8),
  bundles both into a versioned zip ready to upload as a GitHub release asset.

  Assumes this script is run from a developer machine that has:
    - bun on PATH
    - .NET 8 SDK on PATH
    - devmind-shell and devmind-core cloned as sibling directories

  Outputs:
    .\dist\devmind-v<version>-win-x64.zip

.PARAMETER Version
  Semver string without the leading 'v'. Default: 0.1.0
  Example: -Version 0.1.0  -> devmind-v0.1.0-win-x64.zip

.PARAMETER ShellRepo
  Path to the devmind-shell clone. Default: two levels up from this script + devmind-shell

.PARAMETER CoreRepo
  Path to the devmind-core clone. Default: two levels up from this script + devmind-core

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Version 0.2.0
#>

[CmdletBinding()]
param(
    [string]$Version = '0.1.0',
    [string]$ShellRepo,
    [string]$CoreRepo
)

$ErrorActionPreference = 'Stop'

# Resolve repo paths relative to this script if not provided.
# This script lives at devmind-shell\tooling\build.ps1, so two levels up reaches the repos root.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ShellRepo) { $ShellRepo = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'devmind-shell' }
if (-not $CoreRepo)  { $CoreRepo  = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'devmind-core' }

$ShellRepo = (Resolve-Path $ShellRepo).Path
$CoreRepo  = (Resolve-Path $CoreRepo).Path

Write-Host ""
Write-Host "DevMind release build" -ForegroundColor Cyan
Write-Host "  Version    : v$Version"
Write-Host "  Shell repo : $ShellRepo"
Write-Host "  Core repo  : $CoreRepo"
Write-Host ""

# --- Sanity checks ---------------------------------------------------------

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun not found on PATH. Install Bun before running this script."
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet not found on PATH. Install .NET 8 SDK before running this script."
}
if (-not (Test-Path (Join-Path $ShellRepo 'package.json'))) {
    throw "Shell repo not found or missing package.json: $ShellRepo"
}
if (-not (Test-Path (Join-Path $CoreRepo 'DevMind.McpServer\DevMind.McpServer.csproj'))) {
    throw "Core repo not found or missing DevMind.McpServer: $CoreRepo"
}

# --- Working directories ---------------------------------------------------

$distDir   = Join-Path $scriptDir 'dist'
$stageDir  = Join-Path $distDir   "devmind-v$Version-win-x64"
$zipPath   = Join-Path $distDir   "devmind-v$Version-win-x64.zip"

if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
if (Test-Path $zipPath)  { Remove-Item -Force $zipPath }
New-Item -ItemType Directory -Path $stageDir | Out-Null

# --- Build the shell -------------------------------------------------------

Write-Host "[1/3] Building DevMindShell..." -ForegroundColor Yellow
Push-Location $ShellRepo
try {
    # Make sure deps are installed.
    & bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install failed." }

    # Reinstall the react-devtools-core stub after bun install.
    # bun install wipes node_modules, so the stub must be placed here, between
    # install and build. The stub silences an ENOENT that Ink triggers at bundle
    # time by eagerly requiring the package (vadimdemedes/ink#650). The real
    # package is never needed in production because isDev() always returns false.
    $stubSource = Join-Path $scriptDir 'stubs\react-devtools-core'
    $stubTarget = Join-Path $ShellRepo 'node_modules\react-devtools-core'
    if (Test-Path $stubTarget) { Remove-Item -Recurse -Force $stubTarget }
    Copy-Item -Recurse $stubSource $stubTarget
    Write-Host "       Stub installed: react-devtools-core"

    # Compile to a single Windows x64 executable.
    $shellExe = Join-Path $stageDir 'devmind.exe'
    & bun build --compile --target=bun-windows-x64 --external react-devtools-core .\src\index.tsx --outfile $shellExe
    if ($LASTEXITCODE -ne 0) { throw "bun build --compile failed." }
    if (-not (Test-Path $shellExe)) { throw "Expected $shellExe was not produced." }

    $shellSize = [math]::Round((Get-Item $shellExe).Length / 1MB, 1)
    Write-Host "       devmind.exe -> $shellSize MB" -ForegroundColor Green
} finally {
    Pop-Location
}

# --- Publish the McpServer -------------------------------------------------

Write-Host ""
Write-Host "[2/3] Publishing DevMind.McpServer..." -ForegroundColor Yellow
$serverProj    = Join-Path $CoreRepo 'DevMind.McpServer\DevMind.McpServer.csproj'
$serverOutDir  = Join-Path $distDir 'mcp-publish'

if (Test-Path $serverOutDir) { Remove-Item -Recurse -Force $serverOutDir }

& dotnet publish $serverProj `
    -c Release `
    -r win-x64 `
    --self-contained `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=embedded `
    -o $serverOutDir

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed." }

$serverExe = Join-Path $serverOutDir 'DevMind.McpServer.exe'
if (-not (Test-Path $serverExe)) { throw "Expected $serverExe was not produced." }

# Copy only the exe (debug type embedded means no separate pdb to ship).
Copy-Item $serverExe (Join-Path $stageDir 'DevMind.McpServer.exe')

$serverSize = [math]::Round((Get-Item (Join-Path $stageDir 'DevMind.McpServer.exe')).Length / 1MB, 1)
Write-Host "       DevMind.McpServer.exe -> $serverSize MB" -ForegroundColor Green

# --- README.txt in the zip -------------------------------------------------

$readme = @"
DevMind v$Version (Windows x64)
================================

This package contains:
  devmind.exe              -- the agentic terminal harness
  DevMind.McpServer.exe    -- the MCP tool server (spawned by devmind.exe)

Installation
------------
Use the installer script instead of unpacking this zip manually:

  iwr https://raw.githubusercontent.com/pkailas/devmind-shell/main/install.ps1 | iex

Configuration
-------------
On first run, devmind.exe reads (in priority order):
  1. Environment variables (DEVMIND_BASE_URL, DEVMIND_API_KEY, DEVMIND_MODEL, etc.)
  2. Config file at %APPDATA%\devmind\shell.json
  3. Built-in defaults (which target a local LLM endpoint)

If your LLM endpoint is not the default, set DEVMIND_BASE_URL before running.

Source
------
  https://github.com/pkailas/devmind-shell
  https://github.com/pkailas/devmind-core

Issues
------
  https://github.com/pkailas/devmind-shell/issues

Copyright (c) iOnline Consulting LLC. All rights reserved.
"@

Set-Content -Path (Join-Path $stageDir 'README.txt') -Value $readme -Encoding UTF8

# --- Zip it ---------------------------------------------------------------

Write-Host ""
Write-Host "[3/3] Creating zip..." -ForegroundColor Yellow
Compress-Archive -Path "$stageDir\*" -DestinationPath $zipPath -CompressionLevel Optimal

$zipSize = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

# --- Summary ---------------------------------------------------------------

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Zip   : $zipPath"
Write-Host "  Size  : $zipSize MB"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Test locally: extract the zip, run devmind.exe"
Write-Host "  2. Create a release at https://github.com/pkailas/devmind-shell/releases/new"
Write-Host "     Tag      : v$Version"
Write-Host "     Title    : DevMind v$Version"
Write-Host "     Asset    : $zipPath"
Write-Host ""
