# JDWP Live Debugger

**Attach a full debugger to Java JVMs running in Docker & Kubernetes — without stopping them, without redeploying, and without blocking other requests.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/MaNiSh-9211/JDWP-remote-debugging/actions/workflows/ci.yml/badge.svg)](https://github.com/MaNiSh-9211/JDWP-remote-debugging/actions/workflows/ci.yml)
[![Java](https://img.shields.io/badge/Java-21+-orange.svg)](https://openjdk.org)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.x-brightgreen.svg)](https://spring.io/projects/spring-boot)
[![Electron](https://img.shields.io/badge/Desktop-Electron-47848F.svg)](https://www.electronjs.org)
[![MCP](https://img.shields.io/badge/AI-MCP%20Ready-8A2BE2.svg)](https://modelcontextprotocol.io)

Most debuggers force an ugly trade-off in production: either you don't debug at all, or you suspend whole threads/processes and take your users down with you. **JDWP Live Debugger** solves this with *request-scoped debugging*: only the specific request you tag gets paused at a breakpoint — every other request flows through untouched.

```
┌──────────────────────────  Your Machine  ──────────────────────────┐
│                                                                    │
│   JDWP Studio (Electron)          AI IDE + MCP Server              │
│   or any Web Browser              (Cursor / Claude / …)            │
│            │                              │                        │
│            ▼                              ▼                        │
│   ┌──────────────────────────────────────────────┐                 │
│   │        Debug Client  (Spring Boot :8083)     │                 │
│   │   JDI engine · breakpoints · variables ·     │                 │
│   │   stepping · live log capture · token auth   │                 │
│   └───────────────────┬──────────────────────────┘                 │
└───────────────────────│────────────────────────────────────────────┘
                        │  JDWP over `kubectl port-forward`
                        │  (never exposed to the network)
                        ▼
┌───────────────────────────  Cluster  ──────────────────────────────┐
│   ┌── Pod A ─────────────────┐   ┌── Pod B ─────────────────┐      │
│   │  JVM + JDWP agent :5005  │   │  JVM + JDWP agent :5005  │      │
│   │  debug-filter-lib        │   │  (untouched replicas     │      │
│   │  → pauses ONLY requests  │   │   keep serving traffic)  │      │
│   │    tagged X-Debug-Id     │   │                          │      │
│   └──────────────────────────┘   └──────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Why this exists

| Traditional remote debugging | JDWP Live Debugger |
|---|---|
| Breakpoint suspends **all** traffic through that code path | Only the request you tag is suspended; all others proceed |
| Requires app restart with `suspend=y` | Attaches to a **running** JVM (`suspend=n`, dynamic agent loading supported) |
| JDWP port opened on NodePort/LoadBalancer | JDWP stays ClusterIP-only; access via short-lived `kubectl port-forward` |
| Debugging is a human-only activity | First-class **MCP server** so AI IDEs can set breakpoints and read variables safely |
| No trace of who debugged what | Session-based API with audit logging and automatic timeouts |

## Feature highlights

- **Non-blocking breakpoints** — the optional `debug-filter-lib` dependency pauses only requests carrying your debug header (`X-Debug-Request-Id`). Other users never notice.
- **Full debugger feature set** — breakpoints (line + exception), step over/into/out, continue, stack frames, deep variable inspection, expression evaluation.
- **Live log capture** — a tiny javaagent is injected into the target JVM on attach; application logs stream back to the UI over SSE, no restart needed.
- **Kubernetes-native sessions** — pod discovery by label, port-forward lifecycle management, session timeouts, and audit logging built into the in-cluster debugger.
- **JDWP Studio desktop app** — cross-platform Electron shell (Windows/macOS/Linux) with source view, variable tree, HTTP replay drawer, and a kubectl terminal that only allows read-only commands.
- **AI-ready via MCP** — two MCP servers: one for local/JDWP workflows (37 tools), one Kubernetes-aware (32 tools: pods, tunnels, sessions).
- **Security-first defaults** — API token auth, localhost binding, locked-down CORS, least-privilege RBAC (no exec, no write verbs), constant-time token comparison.

## Repository layout

```
├── client/                     # Debug Client — Spring Boot JDI engine (:8083)
│   ├── src/main/java/…         #   JdwpService, controllers, security, log agent
│   ├── ui/                     #   Web UI (React + Vite) served from the client
│   └── jdwp-desktop/           #   JDWP Studio — Electron desktop app (Win/mac/Linux)
├── server/                     # Demo Spring Boot app used as the debug target
├── jdwp-mcp/                   # MCP server #1 — local JDWP debugging tools
├── k8s-debug/                  # In-cluster, session-based K8s debugger (REST API)
├── k8s-remote-debug/
│   ├── debug-filter-lib/       # ★ The non-blocking magic: request-scoped pause filter
│   ├── debug-agent/            # Zero-code-change dynamic attach agent
│   ├── mcp-server/             # MCP server #2 — Kubernetes-aware debugging tools
│   ├── mock-services/          # Two demo services for end-to-end testing
│   └── k8s/                    # Manifests: RBAC, deployments, NetworkPolicy, kind configs
├── production-files/           # Production rollout guides (filter-lib & dynamic agent)
├── scripts/                    # Kind demo bootstrap + port-forward helpers
├── k8s/kind-jdwp-demo/         # One-command Kind demo cluster
└── docs/                       # Architecture, security model, production guide
```

## Prove it yourself (live cluster, one command)

Skeptical that cluster attach actually works? Run this — it creates a real kind cluster, deploys debuggable Java pods, attaches through `kubectl port-forward`, and asserts every claim above:

```powershell
# Windows (needs Docker + kubectl + JDK 21; kind is downloaded automatically)
powershell -ExecutionPolicy Bypass -File scripts/e2e-live-debug.ps1
```

Expected output ends with `ALL CHECKS PASSED`, having verified:

1. Pods reach `Running` in a **real Kubernetes cluster**
2. Debugger attaches to the pod's JVM through the port-forward tunnel
3. Untagged HTTP requests complete normally (**never blocked**)
4. A request carrying `X-Debug-Request-Id` is **suspended inside the pod** while untagged traffic keeps flowing
5. Variables are readable from the suspended pod thread
6. Resume completes the request

The Studio UI exposes exactly these primitives: context discovery (`kubectl config get-contexts`), pod discovery (`kubectl get pods`), per-pod JDWP forward with live status, and a read-only kubectl shell.

## Quick start (Docker, 3 minutes)

Prerequisites: JDK 21+, Maven 3.9+, Docker.

```bash
# 1. Start the demo target (Spring Boot app with JDWP enabled inside the container)
docker compose up -d --build

# 2. Start the debug client
cd client && mvn spring-boot:run

# 3. Open the web UI
#    http://localhost:8083  →  Connect to host=localhost port=5005
```

Try it: set a breakpoint at `com.jdwp.server.controller.UserController:getUsers`, then click **GET /users** in the API panel. The containerized app freezes at your breakpoint — inspect variables, step, resume.

### Desktop app (Electron)

```bash
cd client/jdwp-desktop
npm run windows    # or: npm run macos | npm run linux
```

### One-command Kubernetes demo (Kind)

```bash
./scripts/bootstrap-kind-demo.ps1     # creates cluster, builds images, deploys 2 pods
./scripts/kind-jdwp-forward-jdwp.ps1  # forwards JDWP 5005/5006 to localhost
```

### AI IDE integration (MCP)

```bash
cd jdwp-mcp && npm install && npm run build
```

Add to `.cursor/mcp.json` (see `jdwp-mcp/cursor-mcp-config.example.json`):

```json
{
  "mcpServers": {
    "jdwp": {
      "command": "node",
      "args": ["/absolute/path/to/jdwp-mcp/dist/index.js"]
    }
  }
}
```

Your AI can now `jdwp_set_breakpoint`, `jdwp_get_variables`, `jdwp_step_over`, run a full `jdwp_auto_debug` workflow, and more — 37 tools total. For cluster-wide AI debugging use `k8s-remote-debug/mcp-server` (32 `k8s_*` tools).

## Non-blocking debugging in production

Two drop-in approaches, both documented in [`docs/production-debugging.md`](docs/production-debugging.md):

1. **Maven dependency** — add `debug-filter-lib` to your service. It registers a servlet filter that checks every incoming request for your debug header; untagged requests are never paused.
2. **Zero code changes** — attach `debug-agent` dynamically to any running JVM (via the client's `/api/debug/load-agent` endpoint or `kubectl cp`). No pom changes, no redeploy.

Either way, the workflow is:

```bash
# 1. Create a debug session against a pod (in-cluster debugger or MCP)
curl -X POST http://localhost:8090/api/debug/sessions \
  -d '{"namespace":"prod","podName":"orders-7d9f…","requestId":"debug-abc123"}'

# 2. Set a breakpoint scoped to that request id
# 3. Replay the exact user call with the header:
curl -H "X-Debug-Request-Id: debug-abc123" https://your-service/api/orders/42
#    → only THIS request hits the breakpoint; production traffic continues
```

## Security model

Read the full model in [`docs/security.md`](docs/security.md). The short version:

| Layer | Control |
|---|---|
| Network | JDWP never published; ClusterIP-only + `kubectl port-forward`. NetworkPolicy limits who can reach 5005 in-cluster. |
| RBAC | Least privilege: `get/list/watch pods`, `pods/portforward`, `pods/log`. **No exec, no write verbs.** |
| Debug API | Optional bearer-token auth (`JDWP_API_TOKEN`) with constant-time comparison; localhost-only bind by default; explicit CORS allow-list. |
| Desktop app | Context isolation + sandbox, strict CSP, navigation guards, kubectl terminal restricted to read-only allow-listed subcommands. |
| Sessions | Automatic expiry, single-session-per-pod guards, full audit trail of every debug action. |

> **Warning:** JDWP itself is an unencrypted protocol. Always tunnel it (SSH/kubectl port-forward/VPN) — never expose port 5005 of a production JVM to a network you don't fully trust.

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, design decisions
- [Security model](docs/security.md) — threat model and hardening guide
- [Production debugging](docs/production-debugging.md) — filter-lib & dynamic-agent rollouts
- [client README](client/README.md) · [k8s-debug README](k8s-debug/README.md) · [MCP server](jdwp-mcp/README.md)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Connection refused on 5005 | Container not running or port not forwarded — `docker ps`, then re-check `kubectl port-forward` |
| "Ping OK but JDWP attach fails" | Another process holds 8083, or client runs inside Docker while Studio expects host networking |
| Breakpoint never hits | Class not loaded yet — trigger the endpoint once, or use `jdwp_trigger_class_loading` |
| Variables show `<unavailable>` | Target compiled without debug info; build with `-g` (Spring Boot does by default) |

## Contributing

PRs welcome. Please keep the security posture intact: no new exec/write verbs in RBAC, no wildcard CORS, no secrets in code. Run `mvn verify` and the module builds before submitting.

## License

[MIT](LICENSE)
