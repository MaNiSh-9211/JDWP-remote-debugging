# E2E test with mock VCP (no DB): JDWP connect, breakpoint on /api/v1/dd/widget, trigger API, verify hit.
# Run from: k8s-remote-debug\scripts
# Prereqs: JDWP client on 8083, frontend optional.

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mockDir = Join-Path (Split-Path -Parent $scriptDir) "mock-services\vcp"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " E2E: Mock VCP on 8081 + JDWP 5005" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Ensure JDWP client is up
$status = (Invoke-WebRequest -Uri "http://localhost:8083/api/debug/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue).Content
if (-not $status -or $status -notmatch "connected") {
    Write-Host "JDWP client not running on 8083. Start it first (e.g. restart-everything.ps1)." -ForegroundColor Red
    exit 1
}
Write-Host "JDWP client: OK" -ForegroundColor Green

# Build and run mock VCP if not already running
$mockRunning = $false
try {
    $r = Invoke-WebRequest -Uri "http://localhost:8081/actuator/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    $mockRunning = $true
} catch {}

if (-not $mockRunning) {
    Write-Host "Building mock VCP..." -ForegroundColor Yellow
    Push-Location $mockDir
    mvn clean package -DskipTests -q
    docker build -t vcp-mock:test -q .
    docker stop vcp-direct 2>$null; docker rm vcp-direct 2>$null
    docker run -d --name vcp-direct -p 8081:8081 -p 5005:5005 -e JAVA_TOOL_OPTIONS="-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005" vcp-mock:test
    Pop-Location
    Write-Host "Waiting for mock VCP..." -ForegroundColor Gray
    Start-Sleep -Seconds 10
}
Write-Host "Mock VCP: http://localhost:8081, JDWP localhost:5005" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Manual E2E steps:" -ForegroundColor White
Write-Host "  1. Frontend -> Manual -> Host localhost, Port 5005 -> Connect" -ForegroundColor White
Write-Host "  2. Breakpoints -> Class: com.mock.vcp.VcpController, Line: 83 -> Add" -ForegroundColor White
Write-Host "  3. Run your widget API (curl or browser); breakpoint will hit." -ForegroundColor White
Write-Host "  API: http://localhost:8081/api/v1/dd/widget?widgetKey=LAST_SEARCHED_COMPANIES&formId=916bbc71-97ce-441a-973b-33804f1569fe&selectedOrgId=cfcbb891-1838-48e7-98db-57142094123c" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
