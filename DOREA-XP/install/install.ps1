# DOREA-XP installer (Windows PowerShell)
#
# Usage (run PowerShell as Administrator recommended):
#   1. Open "Windows PowerShell (Admin)" or "Terminal (Admin)"
#   2. cd <project directory>
#   3. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   4. .\install\install.ps1
#
# What it does:
#   - Checks Docker Desktop is installed and running
#   - Generates .env (admin password + JWT secret)
#   - docker compose up -d --build (CPU mode)
#   - Health check, then prints access info

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "=== DOREA-XP installer ===" -ForegroundColor Cyan
Write-Host "Project path: $ProjectRoot"
Write-Host ""

# 1. Docker check
Write-Host "[1/5] Checking Docker..." -ForegroundColor Cyan
$dockerExists = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerExists) {
    Write-Host "[ERROR] Docker Desktop is not installed." -ForegroundColor Red
    Write-Host "        Install: https://docs.docker.com/desktop/install/windows-install/"
    Write-Host "        WSL2 backend must be enabled."
    exit 1
}
try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker info failed" }
} catch {
    Write-Host "[ERROR] Docker Desktop is not running." -ForegroundColor Red
    Write-Host "        Start Docker Desktop and wait until the whale icon is stable."
    exit 1
}
Write-Host "[OK] Docker" -ForegroundColor Green

# 2. docker compose v2 check
docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] docker compose v2 is required." -ForegroundColor Red
    Write-Host "        Update Docker Desktop to the latest version."
    exit 1
}
Write-Host "[OK] docker compose" -ForegroundColor Green

# 3. Run mode - Windows laptop defaults to CPU mode
Write-Host ""
# 3. Mount point directories - create up front so Docker bind mounts have an
#    existing host directory (avoids Docker creating them with root ownership).
$MountDirs = @(
    "DATABASE",
    "DATABASE\files",
    "DATABASE\attachments",
    "DATABASE\myfiles",
    "DATABASE\chroma",
    "MODEL\Ollama",
    "config"
)
foreach ($d in $MountDirs) {
    New-Item -Path $d -ItemType Directory -Force | Out-Null
}

Write-Host "[2/5] Run mode: Windows CPU (no NVIDIA GPU passthrough assumed)" -ForegroundColor Cyan
$ComposeArgs = @("-f", "docker-compose.yml")

# 4. .env generation
#   - if .env exists, use as-is
#   - else copy from .env.example
#   - if ADMIN_INITIAL_PASSWORD / JWT_SECRET_KEY is a placeholder, generate random
#   - otherwise keep the .env.example value (lets you preset the password before packaging)
Write-Host ""
Write-Host "[3/5] Checking .env file..." -ForegroundColor Cyan

$Placeholders = @("", "change-me", "change-me-to-strong-random-secret", "your-super-secret-key-change-in-production")

function Test-Placeholder([string]$value) {
    return $Placeholders -contains $value.Trim()
}

if (Test-Path ".env") {
    Write-Host "[OK] .env already exists - keeping existing values" -ForegroundColor Green
    $line = (Select-String -Path ".env" -Pattern "^ADMIN_INITIAL_PASSWORD=" | Select-Object -First 1).Line
    $AdminPassDisplay = if ($line) { $line -replace "^ADMIN_INITIAL_PASSWORD=", "" } else { "(not set)" }
} else {
    if (Test-Path ".env.example") { Copy-Item ".env.example" ".env" } else { New-Item -Path ".env" -ItemType File | Out-Null }
    $envContent = Get-Content ".env" -Raw

    $exampleAdmin = ""
    $exampleJwt = ""
    if ($envContent -match "(?m)^ADMIN_INITIAL_PASSWORD=(.*)$") { $exampleAdmin = $Matches[1] }
    if ($envContent -match "(?m)^JWT_SECRET_KEY=(.*)$") { $exampleJwt = $Matches[1] }

    if (Test-Placeholder $exampleAdmin) {
        $bytes = New-Object byte[] 12
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $AdminPass = ([Convert]::ToBase64String($bytes) -replace "[/+=]", "")
        if ($AdminPass.Length -gt 12) { $AdminPass = $AdminPass.Substring(0, 12) }
        $AdminSource = "(random generated)"
    } else {
        $AdminPass = $exampleAdmin
        $AdminSource = "(from .env.example)"
    }

    if (Test-Placeholder $exampleJwt) {
        $bytesJwt = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytesJwt)
        $JwtKey = ($bytesJwt | ForEach-Object { $_.ToString("x2") }) -join ""
    } else {
        $JwtKey = $exampleJwt
    }

    if ($envContent -match "(?m)^ADMIN_INITIAL_PASSWORD=") {
        $envContent = $envContent -replace "(?m)^ADMIN_INITIAL_PASSWORD=.*$", "ADMIN_INITIAL_PASSWORD=$AdminPass"
    } else {
        $envContent += "`nADMIN_INITIAL_PASSWORD=$AdminPass"
    }
    if ($envContent -match "(?m)^JWT_SECRET_KEY=") {
        $envContent = $envContent -replace "(?m)^JWT_SECRET_KEY=.*$", "JWT_SECRET_KEY=$JwtKey"
    } else {
        $envContent += "`nJWT_SECRET_KEY=$JwtKey"
    }
    [System.IO.File]::WriteAllText("$ProjectRoot\.env", $envContent)
    $AdminPassDisplay = $AdminPass
    Write-Host "[OK] .env created - admin password $AdminSource" -ForegroundColor Green
}

# 5. docker compose up
Write-Host ""
Write-Host "[4/5] Building images and starting (first run ~10 min, images ~5GB)" -ForegroundColor Cyan
& docker compose @ComposeArgs up -d --build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] docker compose up failed. Logs: docker compose logs" -ForegroundColor Red
    exit 1
}

# 6. Health check
Write-Host ""
Write-Host "[5/5] Backend health check (up to 90s)..." -ForegroundColor Cyan
$healthOk = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:8000/" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            Write-Host "[OK] Backend responding" -ForegroundColor Green
            $healthOk = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 3
    Write-Host -NoNewline "."
}
if (-not $healthOk) {
    Write-Host "[ERROR] Health check timed out. Check: docker compose logs backend" -ForegroundColor Red
    exit 1
}

# Done
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  DOREA-XP is ready!" -ForegroundColor Green
Write-Host "--------------------------------------------------" -ForegroundColor Green
Write-Host "  URL:      http://localhost:8000" -ForegroundColor Green
Write-Host "  Username: admin" -ForegroundColor Green
Write-Host "  Password: $AdminPassDisplay" -ForegroundColor Green
Write-Host "  Mode:     Windows CPU" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Operations:"
Write-Host "  .\install\start.ps1     - start (fast restart if already built)"
Write-Host "  .\install\stop.ps1      - stop"
Write-Host "  .\install\update.ps1    - pull latest code and rebuild"
Write-Host "  .\install\uninstall.ps1 - full removal (DATABASE keep optional)"
Write-Host ""

# Open browser (optional)
$openBrowser = Read-Host "Open in browser now? (Y/n)"
if ($openBrowser -eq "" -or $openBrowser -match "^[Yy]") {
    Start-Process "http://localhost:8000"
}
