# Environment Variables

All configuration knobs for the debug client, demo target, and tooling in one table.

## Debug Client (`client/`)

Set via `application.properties` or environment variables.

| Variable | Property | Default | Purpose |
|----------|----------|---------|---------|
| `JDWP_SERVER_ADDRESS` | `server.address` | `localhost` | Bind address. Set to `0.0.0.0` only when `JDWP_API_TOKEN` is also set. |
| `JDWP_API_TOKEN` | `jdwp.api-token` | *(empty)* | Require `X-Debug-Token`/Bearer auth on all `/api` calls. Empty = unsecured (dev only). |
| `JDWP_ALLOWED_TARGETS` | `jdwp.allowed-targets` | *(empty)* | Comma-separated hosts/CIDRs the client may attach to. Empty = unrestricted. |
| `JDWP_CORS_ALLOWED_ORIGINS` | `jdwp.cors-allowed-origins` | local dev origins | Explicit CORS allow-list. |
| `JDWP_SESSION_IDLE_TIMEOUT_MINUTES` | `jdwp.session-idle-timeout-minutes` | `30` | Auto-disconnect idle JDWP sessions. `0` disables. |
| `JDWP_DEFAULT_TARGET_HOST` | `jdwp.default-target-host` | `localhost` | Pre-filled connect target host. |
| `JDWP_DEFAULT_TARGET_PORT` | `jdwp.default-target-port` | `5005` | Pre-filled connect target port. |
| `JDWP_DEMO_APP_BASE_URL` | `jdwp.demo-app-base-url` | `http://localhost:8081` | Demo app proxy target for HTTP probes. |
| `JDWP_LOG_RECEIVER_PORT` | `jdwp.log-receiver-port` | `9999` | Socket port for agent/container log streaming. |
| `JDWP_AUDIT_FILE` | `jdwp.audit.file` | `logs/audit.jsonl` | Append-only audit trail path. |
| `kube.web.enabled` | — | `true` | Enable/disable `/api/k8s/*` endpoints. |

### Auth tuning

| Property | Default | Purpose |
|----------|---------|---------|
| `jdwp.auth.max-failures` | `5` | Failed attempts per IP before lockout |
| `jdwp.auth.window-ms` | `60000` | Failure-counting window |
| `jdwp.auth.lockout-ms` | `300000` | Lockout duration after max failures |

---

## Demo Target (`server/`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEMO_DATA_DIR` | `/app/data` | JSON data storage directory |
| `LOG_TARGET_HOST` | `host.docker.internal` | Log stream destination (debug client) |
| `LOG_TARGET_PORT` | `9999` | Log receiver port |
| `JAVA_TOOL_OPTIONS` | *(unset)* | Set to `-agentlib:jdwp=...address=*:5005` to enable JDWP |

---

## MCP Server (local) (`jdwp-mcp/`)

| Variable | Purpose |
|----------|---------|
| `JDWP_CLIENT_BASE_URL` | Debug client API base (default `http://localhost:8083`) |
| `JDWP_TRIGGER_URL` | Optional endpoint to hit so target classes load |
| `JDWP_TRIGGER_TOKEN` | Auth token for the trigger URL |

---

## Electron Desktop App

| Variable | Purpose |
|----------|---------|
| `JDWP_API_BASE` | Default debug client API base URL |
| `JDWP_SOURCE_ROOT` | Override source root detection for the code viewer |
| `VITE_DEV_SERVER_URL` | Vite dev server URL (development only) |

---

## Production hardening example

```bash
export JDWP_API_TOKEN="$(openssl rand -hex 32)"
export JDWP_ALLOWED_TARGETS="localhost,127.0.0.1,10.0.0.0/8"
export JDWP_SESSION_IDLE_TIMEOUT_MINUTES=15
# Only bind beyond localhost when token IS set:
export JDWP_SERVER_ADDRESS="0.0.0.0"
```
