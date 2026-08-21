# Show logs from a debuggable service in the cluster
# Usage: .\show-service-logs.ps1 [namespace] [tail lines]
# Example: .\show-service-logs.ps1 debug-services 200

param(
    [string]$Namespace = "debug-services",
    [int]$Tail = 100,
    [string]$AppLabel = "vcp-service",
    [switch]$Follow
)

$args = @("logs", "-n", $Namespace, "-l", "app=$AppLabel", "--tail=$Tail")
if ($Follow) { $args += "-f" }
Write-Host "kubectl $($args -join ' ')" -ForegroundColor Cyan
kubectl @args
