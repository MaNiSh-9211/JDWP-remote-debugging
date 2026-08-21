# Cleanup Script
# Removes all debug infrastructure

param(
    [switch]$All,           # Delete everything including cluster
    [switch]$KeepCluster,   # Keep cluster but remove deployments
    [switch]$Force          # Skip confirmation
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "K8s Remote Debug - Cleanup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if (-not $Force) {
    $response = Read-Host "This will remove debugging infrastructure. Continue? (y/N)"
    if ($response -ne "y" -and $response -ne "Y") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

# Kill any port-forward processes
Write-Host "Stopping port-forward processes..." -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -eq "kubectl" } | Stop-Process -Force -ErrorAction SilentlyContinue

# Remove deployments
if ($KeepCluster -or $All) {
    Write-Host "Removing Kubernetes resources..." -ForegroundColor Yellow
    kubectl delete -f "$ProjectRoot\k8s\valuation-deployment.yaml" --ignore-not-found 2>&1 | Out-Null
    kubectl delete -f "$ProjectRoot\k8s\vcp-deployment.yaml" --ignore-not-found 2>&1 | Out-Null
    kubectl delete -f "$ProjectRoot\k8s\rbac.yaml" --ignore-not-found 2>&1 | Out-Null
    kubectl delete -f "$ProjectRoot\k8s\configmaps.yaml" --ignore-not-found 2>&1 | Out-Null
    kubectl delete -f "$ProjectRoot\k8s\namespace.yaml" --ignore-not-found 2>&1 | Out-Null
}

# Delete cluster
if ($All -and -not $KeepCluster) {
    Write-Host "Deleting Kind cluster..." -ForegroundColor Yellow
    kind delete cluster --name debug-cluster 2>&1 | Out-Null
}

# Remove Docker images
if ($All) {
    Write-Host "Removing Docker images..." -ForegroundColor Yellow
    docker rmi valuation-debug:latest -f 2>&1 | Out-Null
    docker rmi vcp-debug:latest -f 2>&1 | Out-Null
}

# Clean build artifacts
if ($All) {
    Write-Host "Cleaning build artifacts..." -ForegroundColor Yellow
    
    # Clean filter library
    if (Test-Path "$ProjectRoot\debug-filter-lib\target") {
        Remove-Item -Recurse -Force "$ProjectRoot\debug-filter-lib\target"
    }
    
    # Clean mock services
    if (Test-Path "$ProjectRoot\mock-services") {
        Remove-Item -Recurse -Force "$ProjectRoot\mock-services"
    }
    
    # Clean docker build context
    if (Test-Path "$ProjectRoot\docker\build-context") {
        Get-ChildItem "$ProjectRoot\docker\build-context" -Exclude "Dockerfile.*" | Remove-Item -Force
    }
    
    # Clean MCP server
    if (Test-Path "$ProjectRoot\mcp-server\dist") {
        Remove-Item -Recurse -Force "$ProjectRoot\mcp-server\dist"
    }
    if (Test-Path "$ProjectRoot\mcp-server\node_modules") {
        Remove-Item -Recurse -Force "$ProjectRoot\mcp-server\node_modules"
    }
}

Write-Host ""
Write-Host "Cleanup complete!" -ForegroundColor Green

if ($All) {
    Write-Host "All resources have been removed." -ForegroundColor Yellow
} elseif ($KeepCluster) {
    Write-Host "Cluster retained. Run setup.ps1 to redeploy." -ForegroundColor Yellow
}
