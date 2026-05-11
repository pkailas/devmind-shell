<#
.SYNOPSIS
  DevMind installer for Windows x64.

.DESCRIPTION
  Downloads the latest DevMind release from GitHub, installs it to
  %LOCALAPPDATA%\Programs\devmind, and adds that directory to the user PATH.

  Usage:
    iwr https://raw.githubusercontent.com/pkailas/devmind-shell/main/install.ps1 | iex

  After install, open a NEW terminal and run: devmind

.NOTES
  No admin rights required. Per-user install.
  Source: https://github.com/pkailas/devmind-shell
#>

# Stop on any error. Important: when piped through iex, an unhandled error
# can leave a half-finished install behind.
$ErrorActionPreference = 'Stop'

# --- Constants -------------------------------------------------------------

$Owner       = 'pkailas'
$Repo        = 'devmind-shell'
$ApiLatest   = "https://api.github.com/repos/$Owner/$Repo/releases/latest"
$InstallDir  = Join-Path $env:LOCALAPPDATA 'Programs\devmind'
$AssetRegex  = '^devmind-v[0-9]+\.[0-9]+\.[0-9]+-win-x64\.zip$'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

# --- Pre-flight ------------------------------------------------------------

Write-Host ""
Write-Host "DevMind installer (Windows x64)" -ForegroundColor Cyan
Write-Host "https://github.com/$Owner/$Repo"

if ([Environment]::Is64BitOperatingSystem -eq $false) {
    throw "DevMind requires 64-bit Windows."
}

# TLS 1.2 for older PowerShell on freshly installed Windows.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- Find latest release ---------------------------------------------------

Write-Step "Looking up latest release"

try {
    $release = Invoke-RestMethod -Uri $ApiLatest -Headers @{ 'User-Agent' = 'devmind-installer' }
} catch {
    throw "Failed to query GitHub API for latest release: $($_.Exception.Message)"
}

$tag = $release.tag_name
if (-not $tag) {
    throw "GitHub API returned no tag_name. There may be no published releases yet at https://github.com/$Owner/$Repo/releases"
}

$asset = $release.assets | Where-Object { $_.name -match $AssetRegex } | Select-Object -First 1
if (-not $asset) {
    throw "No Windows x64 zip asset found in release $tag. Expected an asset matching: $AssetRegex"
}

Write-Info "Found $tag"
Write-Info "Asset: $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"

# --- Stop any running devmind.exe -----------------------------------------

$running = Get-Process -Name 'devmind' -ErrorAction SilentlyContinue
if ($running) {
    Write-Step "Stopping running devmind.exe"
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# --- Download --------------------------------------------------------------

Write-Step "Downloading"

$tempDir = Join-Path $env:TEMP "devmind-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempDir | Out-Null

$zipPath = Join-Path $tempDir $asset.name
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing -Headers @{ 'User-Agent' = 'devmind-installer' }
} catch {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    throw "Download failed: $($_.Exception.Message)"
}

Write-Info "Downloaded to $zipPath"

# --- Install ---------------------------------------------------------------

Write-Step "Installing to $InstallDir"

if (Test-Path $InstallDir) {
    # Preserve any user-created files (configs, etc.) by only removing our known artifacts.
    Get-ChildItem -Path $InstallDir -Include 'devmind.exe','DevMind.McpServer.exe','README.txt' -Recurse -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

try {
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
} catch {
    throw "Failed to extract zip: $($_.Exception.Message)"
}

Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

$exePath = Join-Path $InstallDir 'devmind.exe'
$serverPath = Join-Path $InstallDir 'DevMind.McpServer.exe'

if (-not (Test-Path $exePath))    { throw "devmind.exe missing after install. Aborting." }
if (-not (Test-Path $serverPath)) { throw "DevMind.McpServer.exe missing after install. Aborting." }

Write-Info "Installed devmind.exe"
Write-Info "Installed DevMind.McpServer.exe"

# --- Set environment variables -------------------------------------------

Write-Step "Configuring environment"

# Persistent user env var that tells the shell where the server is.
[Environment]::SetEnvironmentVariable('DEVMIND_MCP_SERVER_PATH', $serverPath, 'User')
Write-Info "DEVMIND_MCP_SERVER_PATH set to $serverPath"

# Add install dir to user PATH if not already there.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }

$pathParts = $userPath -split ';' | Where-Object { $_ -ne '' }
$alreadyOnPath = $pathParts | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') }

if (-not $alreadyOnPath) {
    $newUserPath = if ($userPath -and -not $userPath.EndsWith(';')) { "$userPath;$InstallDir" } else { "$userPath$InstallDir" }
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    Write-Info "Added $InstallDir to user PATH"
} else {
    Write-Info "$InstallDir already on PATH"
}

# Update the current process PATH so devmind is immediately runnable in this session.
# (User won't see it in new terminals until they're reopened, but a current shell that
# spawned this script can find it.)
if (-not ($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $InstallDir.TrimEnd('\') })) {
    $env:Path = "$env:Path;$InstallDir"
}

# --- Summary ---------------------------------------------------------------

Write-Step "Done"

Write-Host ""
Write-Host "DevMind $tag is installed." -ForegroundColor Green
Write-Host ""
Write-Host "Open a new terminal and run:"
Write-Host "    devmind" -ForegroundColor Yellow
Write-Host ""
Write-Host "Configuration (optional):"
Write-Host "    Set DEVMIND_BASE_URL  to your LLM endpoint  (default: http://10.0.0.15:8080/v1)"
Write-Host "    Set DEVMIND_API_KEY   to your API key       (default: lm-studio)"
Write-Host "    Set DEVMIND_MODEL     to your model id"
Write-Host ""
Write-Host "Or edit %APPDATA%\devmind\shell.json (created on first run)."
Write-Host ""
