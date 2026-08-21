# Quick Deploy Script
# Use this to redeploy services after making changes

param(
    [switch]$Rebuild,
    [switch]$RestartOnly,
    [string]$Service  # 'valuation', 'vcp', or empty for both
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "K8s Remote Debug - Quick Deploy" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if ($RestartOnly) {
    Write-Host "Restarting deployments..." -ForegroundColor Yellow
    
    if ([string]::IsNullOrEmpty($Service) -or $Service -eq "valuation") {
        Write-Host "  - Restarting valuation-service..." -ForegroundColor Cyan
        kubectl rollout restart deployment/valuation-service -n debug-services
    }
    
    if ([string]::IsNullOrEmpty($Service) -or $Service -eq "vcp") {
        Write-Host "  - Restarting vcp-service..." -ForegroundColor Cyan
        kubectl rollout restart deployment/vcp-service -n debug-services
    }
    
    Write-Host "  - Waiting for rollout..." -ForegroundColor Cyan
    kubectl rollout status deployment/valuation-service -n debug-services --timeout=120s
    kubectl rollout status deployment/vcp-service -n debug-services --timeout=120s
    
    Write-Host "Done!" -ForegroundColor Green
    exit 0
}

if ($Rebuild) {
    Write-Host "Rebuilding images..." -ForegroundColor Yellow
    
    # Rebuild filter library
    Write-Host "  - Building filter library..." -ForegroundColor Cyan
    Push-Location "$ProjectRoot\debug-filter-lib"
    mvn clean package -DskipTests -q
    Pop-Location
    
    # Rebuild mock services if needed
    $services = @()
    if ([string]::IsNullOrEmpty($Service)) {
        $services = @("valuation", "vcp")
    } else {
        $services = @($Service)
    }
    
    foreach ($svc in $services) {
        Write-Host "  - Building $svc service..." -ForegroundColor Cyan
        $mockDir = "$ProjectRoot\mock-services\$svc"
        if (Test-Path $mockDir) {
            Push-Location $mockDir
            mvn clean package -DskipTests -q
            $jar = Get-ChildItem -Path "target" -Filter "*.jar" | Where-Object { $_.Name -notlike "*sources*" } | Select-Object -First 1
            if ($jar) {
                Copy-Item $jar.FullName "$ProjectRoot\docker\build-context\$svc-app.jar" -Force
            }
            Pop-Location
        }
    }
    
    # Rebuild Docker images
    Write-Host "  - Building Docker images..." -ForegroundColor Cyan
    Push-Location "$ProjectRoot\docker\build-context"
    
    if ([string]::IsNullOrEmpty($Service) -or $Service -eq "valuation") {
        docker build -t valuation-debug:latest -f Dockerfile.valuation .
        kind load docker-image valuation-debug:latest --name debug-cluster
    }
    
    if ([string]::IsNullOrEmpty($Service) -or $Service -eq "vcp") {
        docker build -t vcp-debug:latest -f Dockerfile.vcp .
        kind load docker-image vcp-debug:latest --name debug-cluster
    }
    
    Pop-Location
}

# Apply manifests
Write-Host "Applying manifests..." -ForegroundColor Yellow
kubectl apply -f "$ProjectRoot\k8s\configmaps.yaml"

if ([string]::IsNullOrEmpty($Service) -or $Service -eq "valuation") {
    kubectl apply -f "$ProjectRoot\k8s\valuation-deployment.yaml"
}

if ([string]::IsNullOrEmpty($Service) -or $Service -eq "vcp") {
    kubectl apply -f "$ProjectRoot\k8s\vcp-deployment.yaml"
}

# Restart deployments to pick up new images
Write-Host "Restarting deployments..." -ForegroundColor Yellow

if ([string]::IsNullOrEmpty($Service) -or $Service -eq "valuation") {
    kubectl rollout restart deployment/valuation-service -n debug-services
}

if ([string]::IsNullOrEmpty($Service) -or $Service -eq "vcp") {
    kubectl rollout restart deployment/vcp-service -n debug-services
}

Write-Host "Waiting for rollout..." -ForegroundColor Yellow
kubectl rollout status deployment/valuation-service -n debug-services --timeout=120s 2>&1 | Out-Null
kubectl rollout status deployment/vcp-service -n debug-services --timeout=120s 2>&1 | Out-Null

Write-Host ""
Write-Host "Deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Pod status:" -ForegroundColor Cyan
kubectl get pods -n debug-services
