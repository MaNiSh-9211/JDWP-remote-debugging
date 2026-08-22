# Architecture

## Components

| Component | Tech | Role |
|---|---|---|
| **Debug Client** (`client/`) | Spring Boot 3, JDI | The heart: attaches to target JVMs over JDWP, exposes a REST + SSE API on `:8083`, injects the log-capture agent, serves the web UI. |
| **JDWP Studio** (`client/jdwp-desktop/`) | Electron + React | Desktop shell for the debugger. Per-OS main processes share one renderer. Hardened: sandbox, CSP, IPC allow-lists. |
| **Web UI** (`client/ui/`) | React + Vite | Browser-based debugging UI built into the client JAR (`client/src/main/resources/static`). |
| **Demo Target** (`server/`) | Spring Boot 3 | Sample app (users + orders + async workflows) with JDWP enabled; the thing you debug in demos. |
| **MCP Server (local)** (`jdwp-mcp/`) | TypeScript | 37 tools exposing the Debug Client API to AI IDEs. Auto-starts/reuses the client JAR. |
| **In-cluster Debugger** (`k8s-debug/`) | Spring Boot 3, fabric8 | Runs inside Kubernetes: discovers pods, manages port-forwards and JDWP sessions, enforces timeouts, writes audit logs. REST API on `:8090`. |
| **debug-filter-lib** (`k8s-remote-debug/debug-filter-lib/`) | Spring Boot auto-config | Servlet filter that pauses **only** requests carrying `X-Debug-Request-Id`. This is what makes production debugging non-blocking. |
| **debug-agent** (`k8s-remote-debug/debug-agent/`) | Java agent | Same selective-pause capability, attachable at runtime to a JVM that was started without it. |
| **MCP Server (K8s)** (`k8s-remote-debug/mcp-server/`) | TypeScript | 32 tools: pod discovery, tunnel management, debug sessions, breakpoints — cluster-aware AI debugging. |

## Data flow: a breakpoint hit, end to end

```
AI IDE / UI                Debug Client                Target Pod (in K8s)
    │                            │                            │
    │ set breakpoint(class,line) │                            │
    ├───────────────────────────►│  JDWP SetBreakpoint        │
    │                            ├───────────────────────────►│
    │                            │                     request tagged
    │                            │                     X-Debug-Request-Id arrives
    │                            │                     filter matches → thread suspends
    │                            │  BreakpointEvent           │
    │◄───────────────────────────┤◄───────────────────────────┤
    │ get variables / stack      │                            │
    ├───────────────────────────►│  JDWP StackFrame/Values    │
    │◄───────────────────────────┤◄───────────────────────────┤
    │ continue                   │                            │
    ├───────────────────────────►│  JDWP Resume  ─────────────►  request completes,
    │                            │                            │  other requests never paused
```

Key points:

1. **One JDWP connection per session.** The client keeps a single `VirtualMachine` reference; sessions in `k8s-debug` each own their port-forward + connection.
2. **Suspension is thread-scoped.** JDWP suspends only the event thread; combined with the filter-lib's header check, only your tagged request is ever paused.
3. **Logs bypass the debug channel.** The injected `ConsoleLogAgent` opens its own socket back to the client (`:9999`), so you see application logs even while threads are suspended.

## Design decisions

- **JDI over raw JDWP packets** — type-safe, maintained by the JDK, supports stepping/watchpoints/expression evaluation without reimplementing the wire protocol.
- **Event pump is mandatory, not optional** — JDI only applies a request's suspend policy when the debugger *reads* the `EventSet` from `VirtualMachine.eventQueue()`. The client therefore runs a dedicated pump thread (`JdwpService.startEventPump`) from attach to detach; it records hit metadata while the conditional-resume pass decides which threads stay suspended.
- **Port-forward instead of exposing JDWP** — JDWP has no auth/TLS of its own; keeping it ClusterIP-only and tunneled on demand shrinks the attack surface to nearly zero.
- **Generic pod forward, not demo-specific** — `pod-jdwp-forward` (Electron main process) attaches to ANY pod by name with per-port tracking, validation, and status introspection; the Kind buttons are just presets on top of the same machinery.
- **Filter-lib as an auto-configuration** — services opt in with one Maven dependency; no code changes, no controller modifications.
- **Two MCP servers** — local mode needs zero cluster permissions; cluster mode isolates all kubectl/fabric8 access behind one auditable service.
- **Electron per-OS shells** — packaging quirks (paths, icons, process handling) stay isolated per platform while the renderer is shared.
- **Git tokens never touch disk** — the Services browser sends renderer-supplied tokens to fixed HTTPS hosts (api.github.com / api.bitbucket.org) per request; owner/repo/branch names are validated before URL interpolation.
- **Standalone log agent built by Maven** — `console-log-agent.jar` is produced by an assembly during every package; containerized targets stream logs instead via the NDJSON `ClientSocketAppender`, since local Attach API injection cannot reach them.

## Reliability tooling

| Script | Purpose |
|---|---|
| `scripts/preflight-cluster.ps1` | Run against any context before a demo: connectivity, RBAC (`auth can-i`), JDWP-ready pod detection. Read-only. |
| `scripts/e2e-live-debug.ps1` | Full proof: kind cluster → deploy → tunnel → attach → breakpoint → non-blocking assertions. |
| `scripts/e2e-assert-only.ps1` | Re-run just the assertions against an already-deployed cluster (revives the node if Docker killed it). |
