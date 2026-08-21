# Kubernetes-Native JDWP Debugger

Runs **inside** your cluster: discovers debuggable pods, manages port-forwards and JDWP sessions, and exposes a session-based REST API on `:8090` — designed for AI (MCP) and human debugging of live microservices without downtime.

## How it stays production-safe

- Attaches over `kubectl`-style port-forward; JDWP is never exposed via Services
- Least-privilege RBAC: `pods get/list/watch`, `pods/portforward create`, `pods/log get` — **no exec, no write verbs**
- Session timeouts + audit logging of every debug action
- Works with [debug-filter-lib](../k8s-remote-debug/debug-filter-lib/) so only tagged requests pause

## Run locally (Kind)

```bash
kind create cluster --config k8s-manifests/kind-cluster-config.yaml
docker build -t k8s-debugger:latest .
kind load docker-image k8s-debugger:latest
kubectl apply -f k8s-manifests/
```

API: http://localhost:30090/api/debug/health

## API surface (`/api/debug`)

| Endpoint | Purpose |
|---|---|
| `GET /pods?namespace=&label=` | Discover debuggable pods |
| `POST /sessions` | Create session (port-forward + JDWP attach) |
| `POST /sessions/{id}/breakpoints` | Set line breakpoint scoped to the session |
| `POST /sessions/{id}/breakpoints/wait` | Block until the breakpoint hits |
| `GET /sessions/{id}/variables` · `/stack` | Inspect suspended thread |
| `POST /sessions/{id}/step-over` · `/resume` | Control execution |
| `GET /sessions/{id}/audit` · `GET /audit` | Audit trail |

## Configuration

See [`src/main/resources/application.yml`](src/main/resources/application.yml) — session TTL, allowed namespaces, JDWP port. No secrets required; it uses in-cluster credentials via the ServiceAccount.
