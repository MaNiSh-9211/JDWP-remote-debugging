# ============================================================
# START JDWP CLIENT (on the host — recommended for JDWP Studio + Kind)
# ============================================================
# Stop the compose service first if you ever used it:
#   docker stop jdwp-debug-client
# Default compose no longer starts this container; optional profile: container-client
# ============================================================

$ErrorActionPreference = "Stop"
$clientDir = $PSScriptRoot
$jarPath = Join-Path $clientDir "target\debug-client-1.0.0.jar"
$port = 8083

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " JDWP Client - Starting on port $port" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Set-Location $clientDir

# 1. Stop anything already using port 8083
$listeners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" }
if ($listeners) {
    $procIds = $listeners.OwningProcess | Sort-Object -Unique
    foreach ($procId in $procIds) {
        Write-Host "Stopping process on port $port (PID $procId)..." -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# 2. Build JAR if missing
if (-not (Test-Path $jarPath)) {
    Write-Host "JAR not found. Building..." -ForegroundColor Yellow
    & mvn package -DskipTests -q
    if (-not (Test-Path $jarPath)) {
        Write-Host "Build failed. Try manually: mvn package -DskipTests" -ForegroundColor Red
        exit 1
    }
    Write-Host "Build OK." -ForegroundColor Green
} else {
    Write-Host "JAR found: $jarPath" -ForegroundColor Green
}

# 3. Start JDWP client
Write-Host ""
Write-Host "Starting JDWP client on http://localhost:$port" -ForegroundColor Green
Write-Host "Frontend should use: Connect to localhost:5005 (or 15006 for K8s)" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

& java -jar $jarPath --server.port=$port
if ($LASTEXITCODE -ne 0) {
    Write-Host "`nJDWP client exited (code $LASTEXITCODE). Press Enter to close." -ForegroundColor Yellow
    $null = Read-Host
}
