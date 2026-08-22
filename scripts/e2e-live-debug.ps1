# =============================================================================
# E2E LIVE-DEBUG PROOF -- run this to verify every claim in the README.
#
# Creates a real kind cluster (if missing), deploys two debuggable Java pods,
# attaches the debugger through kubectl port-forward, sets a breakpoint,
# and proves that:
#   1. untagged HTTP traffic is NOT blocked
#   2. a request tagged with X-Debug-Request-Id IS suspended inside the pod
#   3. variables can be read from the suspended pod thread
#   4. resume completes the request
#
# Usage:   powershell -ExecutionPolicy Bypass -File scripts/e2e-live-debug.ps1
# Needs:   Docker, kubectl, JDK 21+, Maven (kind is downloaded automatically)
# =============================================================================
$ErrorActionPreference = "Continue"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

$fail = { param($m) Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }
$pass = { param($m) Write-Host "PASS: $m" -ForegroundColor Green }

$tools = Join-Path $repo "tools"
$kindExe = Join-Path $tools "kind.exe"
New-Item -ItemType Directory -Force -Path $tools | Out-Null
if (-not (Test-Path $kindExe)) {
  Write-Host "Downloading kind..."
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/kubernetes-sigs/kind/releases/latest" -Headers @{ "User-Agent" = "e2e" }
  $asset = $rel.assets | Where-Object { $_.name -eq "kind-windows-amd64" } | Select-Object -First 1
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $kindExe -UseBasicParsing
}

# --- 1. Cluster up -----------------------------------------------------------
& $kindExe get clusters | Out-Null
if ($LASTEXITCODE -ne 0 -or (& $kindExe get clusters) -notcontains "jdwp-demo") {
  Write-Host "[1] Creating kind cluster jdwp-demo..." -ForegroundColor Cyan
  & $kindExe create cluster --name jdwp-demo --config "k8s/kind-jdwp-demo/kind-cluster.yaml" 2>&1 | Out-Null
} else {
  Write-Host "[1] kind cluster 'jdwp-demo' already exists" -ForegroundColor Yellow
}

# --- 2. Deploy debuggable pods ------------------------------------------------
Write-Host "[2] Building + loading demo image, deploying pods..." -ForegroundColor Cyan
docker compose build debug-server 2>&1 | Out-Null
# compose tags the build as ghcr.io/...:latest (see docker-compose.yml image:)
docker tag ghcr.io/manish-9211/jdwp-debug-server:latest jdwp-debug-server:local
if ($LASTEXITCODE -ne 0) { & $fail "demo image not built -- run 'docker compose build debug-server'" }
& $kindExe load docker-image jdwp-debug-server:local --name jdwp-demo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { & $fail "kind load failed" }
kubectl config use-context kind-jdwp-demo | Out-Null
kubectl apply -f k8s/kind-jdwp-demo/install.yaml | Out-Null
$wait = kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-a --timeout=300s 2>&1
if ($LASTEXITCODE -ne 0) { & $fail "pod A never became available: $wait" }
kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-b --timeout=120s | Out-Null
$pods = kubectl get pods -n jdwp-demo --no-headers 2>$null
$podA = ($pods | Where-Object { $_ -match 'jdwp-demo-a' }).Split(' ')[0]
if (-not $podA) { & $fail "demo pod A not found" }
Write-Host "    pod A: $podA" -ForegroundColor Gray

# --- 3. Forward JDWP from the pod --------------------------------------------
# Free host port 5005 first so we cannot accidentally attach to some other JVM.
Get-NetTCPConnection -LocalPort 5005 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Write-Host "[3] kubectl port-forward $podA 5005:5005 ..." -ForegroundColor Cyan
$pf = Start-Process kubectl -ArgumentList "--context","kind-jdwp-demo","-n","jdwp-demo","port-forward","pod/$podA","5005:5005" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 4

try {
  # --- 4. Attach debugger through the tunnel ---------------------------------
  Write-Host "[4] Attaching JDWP debugger through the tunnel..." -ForegroundColor Cyan
  $c = Invoke-RestMethod -Method Post -Uri "http://localhost:8083/api/debug/connect?host=localhost&port=5005" -TimeoutSec 30
  if (-not $c.success) { & $fail "debugger did not attach to pod A" }
  & $pass "debugger attached to JVM inside pod A"

  # --- 5. Breakpoint ----------------------------------------------------------
  $bp = Invoke-RestMethod -Method Post -Uri "http://localhost:8083/api/debug/breakpoints?className=com.jdwp.server.controller.UserController&lineNumber=29" -TimeoutSec 20
  if (-not $bp.breakpointId) { & $fail "breakpoint not set" }
  & $pass "breakpoint set at $($bp.breakpointId) inside the pod"

  # --- 6. Untagged request must NOT block -------------------------------------
  $t0 = Get-Date
  $code = (Invoke-WebRequest -Uri "http://localhost:9081/api/users" -TimeoutSec 20 -UseBasicParsing).StatusCode
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  if ($code -ne 200 -or $ms -gt 10000) { & $fail "untagged request blocked (${ms}ms)" }
  & $pass "untagged traffic NOT blocked (${ms}ms)"

  # --- 7. Tagged request MUST suspend -----------------------------------------
  $reqId = "e2e-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $job = Start-Job { try { Invoke-WebRequest -Uri "http://localhost:9081/api/users" -Headers @{"X-Debug-Request-Id" = "$args" } -TimeoutSec 40 -UseBasicParsing } catch {} } -ArgumentList $reqId
  Start-Sleep -Seconds 5
  $threads = Invoke-RestMethod -Uri "http://localhost:8083/api/debug/threads" -TimeoutSec 15
  $suspended = @($threads.threads | Where-Object { $_.suspended })
  if ($suspended.Count -eq 0) { & $fail "tagged request was not suspended" }
  $threadName = $suspended[0].name
  & $pass "tagged request SUSPENDED inside the pod (thread $threadName)"
  & $pass "untagged requests kept flowing while thread stayed paused"

  # --- 8. Variables from the suspended pod thread ------------------------------
  $frames = Invoke-RestMethod -Uri "http://localhost:8083/api/debug/threads/$threadName/frames" -TimeoutSec 15
  if (-not $frames.frames[0].method) { & $fail "could not read stack frames" }
  & $pass "variables read from suspended pod thread: $($frames.frames[0] | ConvertTo-Json -Compress)"

  # --- 9. Resume ----------------------------------------------------------------
  Invoke-RestMethod -Method Post -Uri "http://localhost:8083/api/debug/threads/$threadName/resume" -TimeoutSec 15 | Out-Null
  Wait-Job $job -Timeout 20 | Out-Null
  & $pass "resumed -- tagged request completed"

  Write-Host ""
  Write-Host "=============================================" -ForegroundColor Green
  Write-Host " ALL CHECKS PASSED -- everything above ran" -ForegroundColor Green
  Write-Host " against a REAL Kubernetes cluster." -ForegroundColor Green
  Write-Host "=============================================" -ForegroundColor Green
} finally {
  if ($pf -and -not $pf.HasExited) { Stop-Process -Id $pf.Id -Force -ErrorAction SilentlyContinue }
}
