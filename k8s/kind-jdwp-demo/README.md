# Kind: real local cluster + host ports + live JDWP (two pods)

Yes — **kind** runs a real Kubernetes control plane in Docker. You can expose services to your **host** in two ways:

1. **`kind-cluster.yaml` + NodePort** — maps `localhost:9081` and `localhost:9082` to the two demo apps (HTTP). Good for “this is our cluster” demos without `kubectl port-forward` for HTTP.
2. **`kubectl port-forward`** — required for **JDWP (5005)** on each pod, mapped to **`localhost:5005`** (pod A) and **`localhost:5006`** (pod B). Only one process can listen on a host port, so two pods need two local JDWP ports.

This folder deploys **two Deployments** (`jdwp-demo-a`, `jdwp-demo-b`) — like two containers — so you can **attach the debugger to either JVM** from JDWP Studio.

## Prerequisites

- [kind](https://kind.sigs.k8s.io/)
- Docker
- `kubectl`

## 1. Build and tag the image (same as docker-compose `debug-server`)

```bash
docker compose build debug-server
docker tag debug-server:latest jdwp-debug-server:local
```

(Adjust the image name if your Compose project label differs.)

## 2. Create the kind cluster **with** host port mappings

```bash
kind create cluster --name jdwp-demo --config k8s/kind-jdwp-demo/kind-cluster.yaml
kind load docker-image jdwp-debug-server:local --name jdwp-demo
```

## 3. Deploy two apps

```bash
kubectl apply -f k8s/kind-jdwp-demo/install.yaml
kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-a --timeout=120s
kubectl wait -n jdwp-demo --for=condition=available deployment/jdwp-demo-b --timeout=120s
```

## 4. HTTP on your machine (no port-forward)

Default kind config maps **9081 / 9082** on the host (8081 is often blocked on Windows).

- **Pod A:** http://localhost:9081/health → JSON includes `"instance":"kind-pod-a"`
- **Pod B:** http://localhost:9082/health → `"instance":"kind-pod-b"`

## 5. JDWP on your machine (port-forward per pod)

**Windows (opens two PowerShell windows):**

```powershell
.\scripts\kind-jdwp-forward-jdwp.ps1
```

**macOS / Linux:** run the two commands printed by:

```bash
bash scripts/kind-jdwp-forward-jdwp.sh
```

Result:

- **Pod A JVM:** `localhost:5005`
- **Pod B JVM:** `localhost:5006`

## 6. One-click from JDWP Studio (Electron)

In **Session**, section **“Kind — debug from this app”** (visible only in the Electron build):

1. Run the Spring **debug client** on **8083** (latest JAR so `POST /api/debug/demo-app-base` exists).
2. **Ping debug client**.
3. Click **Debug Kind pod A** or **Debug Kind pod B** — Electron runs `kubectl port-forward`, updates the demo HTTP base to `http://localhost:9081` or `9082`, and attaches JDWP on `localhost:5005`.

Requires `kubectl` on PATH and context **`kind-jdwp-demo`**. Use **Stop Kind JDWP forward** to kill the forward process.

## 7. Manual flow (presets + env)

1. Run the Spring **debug client** on port **8083**.
2. **Session → Ping debug client**.
3. To debug **pod A:** preset **Kind pod A (JDWP)** or set JDWP **localhost:5005** → **Attach to target VM**.  
   Set `JDWP_DEMO_APP_BASE_URL=http://localhost:9081` so HTTP probes hit pod A (or use one-click above).
4. **Detach**, then for **pod B:** forward JDWP to **5006** manually, or use **Debug Kind pod B** in Electron.

Only **one** JDWP attachment is active at a time; switching pods means detach → switch pod → attach again.

## Optional: cluster without fixed host HTTP ports

```bash
kind create cluster --name jdwp-demo
```

Then use `kubectl -n jdwp-demo port-forward ...` for both HTTP and JDWP as in older tutorials; change Services back to `ClusterIP` if you edit the YAML.

## Docker Compose vs Kind

| Scenario | JDWP Studio preset | JDWP target |
|----------|-------------------|-------------|
| Both services in root `docker-compose` | Compose client | `debug-server:5005` |
| Target in Kind, client on PC | Kind pod A / B | `localhost:5005` or `5006` |

## Teardown

```bash
kind delete cluster --name jdwp-demo
```
