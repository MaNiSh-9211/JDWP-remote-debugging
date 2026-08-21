# K8s Remote Debug Suite

Request-scoped, zero-downtime Java debugging for Kubernetes: only the request you tag is ever suspended.

## Components

| Directory | What it is |
|---|---|
| `debug-filter-lib/` | Spring Boot auto-config library — servlet filter that pauses **only** requests carrying `X-Debug-Request-Id`. One dependency, no code changes. |
| `debug-agent/` | The same selective-pause capability as a dynamic javaagent — attach to a running JVM with zero rebuilds. |
| `mcp-server/` | Kubernetes-aware MCP server (32 tools): pod discovery, tunnel management, debug sessions for AI IDEs. |
| `mock-services/` | Two demo Spring Boot services (`valuation` :8807/JDWP 5005, `vcp` :8081/JDWP 5006) for end-to-end testing. |
| `k8s/` | Manifests: least-privilege RBAC, deployments with hardened securityContexts, NetworkPolicy, kind configs. |
| `docker/` | Dockerfiles bundling services with the filter lib and JDWP enabled. |
| `scripts/` | Setup / deploy / cleanup / e2e test helpers (PowerShell). |

## Quick start

```bash
# 1. Build everything and stand up a Kind cluster with both demo services
./scripts/setup.ps1

# 2. Or run just the e2e flow against mocks
./scripts/run-e2e-with-mock-vcp.ps1
```

Then either drive debugging from the [MCP server](mcp-server/) in your AI IDE, or manually:

```bash
kubectl port-forward -n debug-services pod/<pod> 5005:5005
curl -X POST "http://localhost:8083/api/debug/connect?host=localhost&port=5005"
curl -X POST "http://localhost:8083/api/debug/breakpoints?className=com.mock.vcp.VcpController&lineNumber=25"
curl -H "X-Debug-Request-Id: <session-id>" http://localhost:8081/api/v1/test
```

## How selective suspension works

1. Every request is checked by `DebugRequestFilter` for header `X-Debug-Request-Id`.
2. Untagged requests → filter is a no-op; normal production traffic.
3. Tagged requests → context stored in a thread-local the debugger can correlate.
4. Breakpoint hits suspend only that thread; other requests keep flowing.

Full workflow and production rules of engagement: [docs/production-debugging.md](../docs/production-debugging.md).

## Security posture

- JDWP ports exist on pods but never on Services — access only via port-forward
- RBAC: read-only pod/service verbs + `pods/portforward` (no exec, no writes)
- NetworkPolicy limits which pods can reach JDWP ports
- All workloads run non-root without privilege escalation
