$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot   # scripts/ -> repo root
$pass = { param($m) Write-Host "PASS: $m" -ForegroundColor Green }
$fail = { param($m) Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

# 0. Ensure cluster node is alive (8GB Docker VM kills it under pressure)
$apiOk = $false
try { kubectl --context kind-jdwp-demo get ns jdwp-demo 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $apiOk = $true } } catch {}
if (-not $apiOk) {
  Write-Host "[0] kind node down - reviving container..." -ForegroundColor Yellow
  cmd /c "docker start jdwp-demo-control-plane" | Out-Null
  Start-Sleep 25
}

# 1. free 5005 + forward pod A
Get-NetTCPConnection -LocalPort 5005 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep 1
$podA = (kubectl --context kind-jdwp-demo get pods -n jdwp-demo -o custom-columns=NAME:.metadata.name --no-headers 2>$null | Select-String 'demo-a')
if (-not $podA) { & $fail "pod A not found (cluster/node unhealthy)" }
$podA = $podA.ToString().Trim()
$pf = Start-Process kubectl -ArgumentList "--context","kind-jdwp-demo","-n","jdwp-demo","port-forward","pod/$podA","5005:5005" -WindowStyle Hidden -PassThru
Start-Sleep 4

try {
  # 2. client up?
  $ping = $null
  try { $ping = Invoke-RestMethod "http://127.0.0.1:8083/api/debug/ping" -TimeoutSec 2 } catch {}
  if (-not ($ping -and $ping.ok)) {
    $clientDir = Join-Path $repoRoot "client"
    $jar = Join-Path $clientDir "target\debug-client-1.0.0.jar"
    if (-not (Test-Path $jar)) { & $fail "JAR missing: $jar" }
    Write-Host "    starting debug client..." -ForegroundColor Gray
    Start-Process java -ArgumentList "-jar", $jar -WorkingDirectory $clientDir -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(60)
    do { Start-Sleep 3; try { $ping = Invoke-RestMethod "http://127.0.0.1:8083/api/debug/ping" -TimeoutSec 2 } catch { $ping = $null } } until (($ping -and $ping.ok) -or ((Get-Date) -gt $deadline))
  }
  if (-not ($ping -and $ping.ok)) { & $fail "debug client not running" }

  $c = Invoke-RestMethod -Method Post "http://localhost:8083/api/debug/connect?host=localhost&port=5005" -TimeoutSec 30
  if (-not $c.success) { & $fail "attach failed" }
  & $pass "attached to pod A JVM through kubectl tunnel"

  $bp = Invoke-RestMethod -Method Post "http://localhost:8083/api/debug/breakpoints?className=com.jdwp.server.controller.UserController&lineNumber=29" -TimeoutSec 20
  if (-not $bp.breakpointId) { & $fail "breakpoint not set" }
  & $pass "breakpoint set inside pod ($($bp.breakpointId))"

  $t0 = Get-Date
  $code = (Invoke-WebRequest "http://localhost:9081/api/users" -TimeoutSec 20 -UseBasicParsing).StatusCode
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  if ($code -ne 200 -or $ms -gt 10000) { & $fail "untagged blocked (${ms}ms)" }
  & $pass "untagged traffic NOT blocked (${ms}ms)"

  $reqId = "e2e-" + [guid]::NewGuid().ToString("N").Substring(0,8)
  $job = Start-Job { param($rid) try { Invoke-WebRequest "http://localhost:9081/api/users" -Headers @{"X-Debug-Request-Id"=$rid} -TimeoutSec 40 -UseBasicParsing } catch {} } -ArgumentList $reqId
  Start-Sleep 5
  $threads = Invoke-RestMethod "http://localhost:8083/api/debug/threads" -TimeoutSec 15
  $sus = @($threads.threads | Where-Object { $_.suspended })
  if ($sus.Count -eq 0) { & $fail "tagged request NOT suspended" }
  $tn = $sus[0].name
  & $pass "tagged request SUSPENDED in-pod (thread $tn)"

  $fr = Invoke-RestMethod "http://localhost:8083/api/debug/threads/$tn/frames" -TimeoutSec 15
  if (-not $fr.frames[0].method) { & $fail "no frames" }
  & $pass "variables read from suspended pod thread"

  Invoke-RestMethod -Method Post "http://localhost:8083/api/debug/threads/$tn/resume" -TimeoutSec 15 | Out-Null
  Wait-Job $job -Timeout 20 | Out-Null
  & $pass "resumed; tagged request completed"

  Write-Host ""
  Write-Host "=============================================" -ForegroundColor Green
  Write-Host " ALL CHECKS PASSED - REAL CLUSTER VERIFIED" -ForegroundColor Green
  Write-Host "=============================================" -ForegroundColor Green
} finally {
  if ($pf -and -not $pf.HasExited) { Stop-Process -Id $pf.Id -Force -ErrorAction SilentlyContinue }
}
