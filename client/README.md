# Debug Client

Spring Boot service that attaches to target JVMs via JDI/JDWP and exposes debugging over REST + SSE on **:8083**. It serves the web UI from the same port and is the backend used by JDWP Studio (Electron) and the MCP servers.

## Run

```bash
# 1. Start a debug target first (repo root):
docker compose up -d --build

# 2. Start the client:
mvn spring-boot:run
# or build & run the JAR:
mvn clean package && java -jar target/debug-client-1.0.0.jar
```

Open http://localhost:8083, connect to `localhost:5005`, set breakpoints, go.

## Configuration

| Property | Env var | Default | Purpose |
|---|---|---|---|
| `server.address` | `JDWP_SERVER_ADDRESS` | `localhost` | Bind beyond localhost only with a token set |
| `jdwp.api-token` | `JDWP_API_TOKEN` | *(empty)* | Require `X-Debug-Token`/Bearer auth on all `/api` calls |
| `jdwp.cors-allowed-origins` | `JDWP_CORS_ALLOWED_ORIGINS` | local dev origins | Explicit CORS allow-list |
| `jdwp.default-target-host/port` | `JDWP_DEFAULT_TARGET_HOST/PORT` | `localhost:5005` | Pre-filled connect target |
| `jdwp.log-receiver-port` | `JDWP_LOG_RECEIVER_PORT` | `9999` | Socket for injected log agent |

## API surface (`/api/debug`)

- `POST /connect?host=&port=` · `POST /disconnect` · `GET /status`
- `GET /threads` · `GET /threads/{name}/frames` · suspend/resume per thread
- `POST /breakpoints?className=&lineNumber=` · `DELETE /breakpoints/{id}` · `GET /breakpoints`
- step over/into/out, continue, variable inspection, expression evaluation
- `GET /logs/stream` (SSE) — live application logs captured by the injected agent
- `POST /load-agent?agentPath=` — dynamic agent loading on the target JVM

## Desktop app

See [`jdwp-desktop/`](jdwp-desktop/) — cross-platform Electron shell with source view, variable tree, HTTP replay, and a read-only kubectl terminal.

## Security notes

The client can attach to any reachable JVM — treat it as a privileged tool.
Bind to localhost, set `JDWP_API_TOKEN` when exposing it, and never point it at untrusted networks. See [docs/security.md](../docs/security.md).
