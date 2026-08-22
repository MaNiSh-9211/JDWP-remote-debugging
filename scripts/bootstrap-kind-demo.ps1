# One-shot: download kind (if missing), create cluster, build demo image, load, deploy two pods.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts/bootstrap-kind-demo.ps1
# PS5.1 turns native stderr (kind/kubectl warnings) into errors under "Stop"
$repo = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $repo "docker-compose.yml"))) {
  throw "Run this script from the repo (docker-compose.yml not found above scripts/)."
}
Set-Location $repo

$tools = Join-Path $repo "tools"
$kindExe = Join-Path $tools "kind.exe"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

if (-not (Test-Path $kindExe)) {
  Write-Host "Downloading kind..."
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/kubernetes-sigs/kind/releases/latest" -Headers @{ "User-Agent" = "bootstrap" }
  $asset = $rel.assets | Where-Object { $_.name -eq "kind-windows-amd64" } | Select-Object -First 1
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $kindExe -UseBasicParsing
}

$clusters = & $kindExe get clusters 2>$null
if ($clusters -notmatch "jdwp-demo") {
  Write-Host "Creating kind cluster jdwp-demo..."
  & $kindExe create cluster --name jdwp-demo --config "k8s/kind-jdwp-demo/kind-cluster.yaml"
} else {
  Write-Host "Cluster jdwp-demo already exists (delete with: kind delete cluster --name jdwp-demo)"
}

Write-Host "Building debug-server..."
docker compose build debug-server
# compose tags builds as ghcr.io/manish-9211/jdwp-debug-server:latest
docker tag ghcr.io/manish-9211/jdwp-debug-server:latest jdwp-debug-server:local
Write-Host "Loading image into kind..."
& $kindExe load docker-image jdwp-debug-server:local --name jdwp-demo

kubectl config use-context kind-jdwp-demo
kubectl apply -f k8s/kind-jdwp-demo/install.yaml
kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-a --timeout=180s
kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-b --timeout=180s
kubectl get pods,svc -n jdwp-demo

Write-Host ""
Write-Host "HTTP: http://localhost:9081/health  and  http://localhost:9082/health"
Write-Host "JDWP: run  .\scripts\kind-jdwp-forward-jdwp.ps1  then attach localhost:5005 (pod A) or 5006 (pod B)"
Write-Host "Spring client demo URL: JDWP_DEMO_APP_BASE_URL=http://localhost:9081  (or 9082 for pod B)"
