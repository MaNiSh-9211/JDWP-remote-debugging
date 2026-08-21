# Opens two windows: JDWP for kind pod A on localhost:5005, pod B on localhost:5006.
# Requires: kubectl context = kind-jdwp-demo, namespace jdwp-demo applied from install.yaml
$ErrorActionPreference = "Stop"
$ns = "jdwp-demo"

$podA = kubectl get pod -n $ns -l app=jdwp-demo-a -o jsonpath="{.items[0].metadata.name}" 2>$null
$podB = kubectl get pod -n $ns -l app=jdwp-demo-b -o jsonpath="{.items[0].metadata.name}" 2>$null
if (-not $podA -or -not $podB) {
  Write-Error "Pods not found in $ns. Apply k8s/kind-jdwp-demo/install.yaml and wait for Ready."
}

Write-Host "Pod A: $podA  -> localhost:5005 (JDWP)"
Write-Host "Pod B: $podB  -> localhost:5006 (JDWP)"
Write-Host "HTTP (with kind-cluster.yaml): http://localhost:9081 and http://localhost:9082"

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "kubectl -n $ns port-forward pod/$podA 5005:5005"
)
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "kubectl -n $ns port-forward pod/$podB 5006:5005"
)
