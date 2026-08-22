# =============================================================================
# Cluster preflight check - run BEFORE a live-debugging demo.
# Verifies everything Studio needs against any kubectl context:
#   1. context exists and API is reachable
#   2. RBAC: may list pods, may create pods/portforward
#   3. which pods expose JDWP (containerPort 5005 / env JAVA_TOOL_OPTIONS)
#
# Usage:
#   powershell -File scripts/preflight-cluster.ps1 [-Context <name>] [-Namespace <ns>]
# Read-only: only get/list/auth-can-i calls. Safe on production clusters.
# =============================================================================
param(
    [string]$Context = "",
    [string]$Namespace = "default"
)
$ErrorActionPreference = "Continue"

function Ok($m)   { Write-Host "PASS: $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "FAIL: $m" -ForegroundColor Red }
function Info($m) { Write-Host "      $m" -ForegroundColor Gray }

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { Bad "kubectl not on PATH"; exit 1 }

# --- 1. Context --------------------------------------------------------------
$ctxArgs = @()
if ($Context) { $ctxArgs += @("--context", $Context) }
$ctxList = kubectl @ctxArgs config get-contexts --no-headers -o name 2>$null
if ($LASTEXITCODE -ne 0) { Bad "cannot read kubeconfig"; exit 1 }

if ($Context -and $ctxList -notcontains $Context) {
    Bad "context '$Context' not found. Available:"
    $ctxList | ForEach-Object { Info $_ }
    exit 1
}
$effective = if ($Context) { $Context } else { kubectl config current-context 2>$null }
Ok "kubeconfig OK - using context '$effective'"

# --- 2. Connectivity ---------------------------------------------------------
$ns = kubectl @ctxArgs get namespace $Namespace -o name 2>$null
if ($LASTEXITCODE -ne 0) {
    $all = kubectl @ctxArgs get namespaces -o name 2>$null | ForEach-Object { $_ -replace 'namespace/', '' }
    Bad "namespace '$Namespace' not reachable"
    Info ("namespaces visible: " + (($all | Select-Object -First 12) -join ', '))
    exit 1
}
Ok "cluster reachable, namespace '$Namespace' exists"

# --- 3. RBAC -----------------------------------------------------------------
$canList = kubectl @ctxArgs auth can-i list pods -n $Namespace 2>$null
if ($canList -ne "yes") { Bad "RBAC: cannot LIST pods in '$Namespace'" } else { Ok "RBAC: may list pods" }

$canFwd = kubectl @ctxArgs auth can-i create pods/portforward -n $Namespace 2>$null
if ($canFwd -ne "yes") {
    Bad "RBAC: cannot create pods/portforward in '$Namespace' - attach will be REFUSED"
} else {
    Ok "RBAC: may create port-forwards"
}

$canLog = kubectl @ctxArgs auth can-i get pods/log -n $Namespace 2>$null
Info ("logs read: " + $(if ($canLog -eq "yes") { "allowed" } else { "denied (pod logs button will fail)" }))

# --- 4. JDWP-enabled pods ----------------------------------------------------
$json = kubectl @ctxArgs get pods -n $Namespace -o json 2>$null
if ($LASTEXITCODE -ne 0) { Bad "could not fetch pods"; exit 1 }
$pods = ($json | ConvertFrom-Json).items

$ready = @()
foreach ($p in $pods) {
    if ($p.status.phase -ne "Running") { continue }
    foreach ($c in $p.spec.containers) {
        $jdwpPort = $false; $jdwpEnv = $false
        if ($c.ports) { foreach ($pt in $c.ports) { if ($pt.containerPort -eq 5005) { $jdwpPort = $true } } }
        if ($c.env) {
            foreach ($e in $c.env) {
                if ($e.name -eq "JAVA_TOOL_OPTIONS" -and $e.value -match "jdwp") { $jdwpEnv = $true }
            }
        }
        # also check resolved env from downward/defaults via status? spec-only is enough here
        if ($jdwpPort -or $jdwpEnv) {
            $ready += [pscustomobject]@{ Pod = $p.metadata.name; Via = $(if ($jdwpPort) { "port 5005" } else { "JAVA_TOOL_OPTIONS" }) }
            break
        }
    }
}

Write-Host ""
if ($ready.Count -eq 0) {
    Bad "no Running pods with JDWP enabled in '$Namespace'"
    Info "Enable on the deployment (one-time, then pods restart):"
    Info '  env:'
    Info '  - name: JAVA_TOOL_OPTIONS'
    Info '    value: "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"'
} else {
    Ok "$($ready.Count) attachable pod(s):"
    foreach ($r in $ready) { Info ("{0}  ({1})" -f $r.Pod, $r.Via) }
}
Write-Host ""
Write-Host "Next: Studio -> Cluster panel -> pick context '$effective', namespace '$Namespace', Discover pods, Debug."
