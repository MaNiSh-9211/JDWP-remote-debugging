# One-shot: demo server in Docker, Spring JDWP client + JDWP Studio on the host.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts/start-jdwp-studio-ready.ps1
# Optional:  -Clean   → mvn clean package (fixes stale JAR if /api/debug/ping returns 404)
param([switch]$Clean)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

Write-Host "==> Stopping optional container client (frees port 8083)..." -ForegroundColor Cyan
docker stop jdwp-debug-client 2>$null | Out-Null

Write-Host "==> Starting debug-server (demo app: JDWP 5005, HTTP 8081)..." -ForegroundColor Cyan
docker compose up -d --build debug-server 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    (compose create failed — starting existing container if present)" -ForegroundColor DarkYellow
  docker start jdwp-debug-server 2>$null | Out-Null
}

$jar = Join-Path $repo "client\target\debug-client-1.0.0.jar"
Push-Location (Join-Path $repo "client")
if ($Clean -or -not (Test-Path $jar)) {
  Write-Host "==> Building Spring JDWP client JAR$(if ($Clean) { ' (clean)' })..." -ForegroundColor Cyan
  if ($Clean) { & mvn clean package -DskipTests -q } else { & mvn package -DskipTests -q }
} else {
  Write-Host "==> Client JAR exists; skip build (use -Clean if Studio ping returns 404)..." -ForegroundColor DarkGray
}
Pop-Location
if (-not (Test-Path $jar)) { throw "Build failed: $jar missing" }

Write-Host "==> Freeing ports 8083 (client) and 5177 (Vite)..." -ForegroundColor Cyan
foreach ($port in 8083, 5177) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Host "==> Starting Spring JDWP client on http://localhost:8083 ..." -ForegroundColor Green
$clientDir = Join-Path $repo "client"
Start-Process -FilePath "java" -ArgumentList "-jar", "target\debug-client-1.0.0.jar" -WorkingDirectory $clientDir -WindowStyle Minimized

Start-Sleep -Seconds 8
try {
  $p = Invoke-RestMethod -Uri "http://127.0.0.1:8083/api/debug/ping" -TimeoutSec 15
  if (-not $p.ok) { throw "ping not ok" }
  Write-Host "    Ping OK ($($p.service))" -ForegroundColor Green
} catch {
  Write-Host "    WARNING: Ping failed. Run:  cd client; mvn clean package -DskipTests" -ForegroundColor Yellow
}

$winDesktop = Join-Path $repo "client\jdwp-desktop\app\windows"
Write-Host "==> Starting JDWP Studio (Electron + Vite)..." -ForegroundColor Green
Write-Host "    Demo: Session -> ping -> Attach localhost:5005 (docker debug-server)" -ForegroundColor Gray
Write-Host "    Kind: Session -> Debug Kind pod A/B (cluster kind-jdwp-demo)" -ForegroundColor Gray
Set-Location $winDesktop
if (-not (Test-Path "node_modules")) {
  npm install
}
npm run electron:dev
