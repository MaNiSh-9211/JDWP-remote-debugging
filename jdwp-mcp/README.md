# JDWP MCP Server

Model Context Protocol server that lets AI IDEs (Cursor, Claude, …) debug Java applications through the [Debug Client](../client/README.md) — breakpoints, variable inspection, stepping, log capture, and one-shot auto-debug workflows.

## Tools (37)

- **Connection** — `jdwp_connect`, `jdwp_disconnect`, `jdwp_status`
- **Breakpoints** — set/remove/list, exception breakpoints, wait-for-hit
- **Inspection** — threads, stack frames, variables, loaded classes, expression evaluation
- **Control** — step over/into/out, continue, suspend/resume thread
- **Logs** — get/clear captured application logs
- **Workflows** — `jdwp_auto_debug` (call an endpoint → capture the breakpoint hit → full report), `jdwp_smart_debug`, `jdwp_step_and_inspect`
- **Class loading** — `jdwp_trigger_class_loading` (optional; configure via `JDWP_TRIGGER_URL` env var)

## Setup

```bash
npm install
npm run build
```

Register in your IDE's MCP config (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "jdwp": {
      "command": "node",
      "args": ["<absolute-path>/jdwp-mcp/dist/index.js"]
    }
  }
}
```

The server auto-starts the Debug Client JAR if it isn't already running on `:8083` and connects to `localhost:5005` by default. Override with env vars:

| Env var | Purpose |
|---|---|
| `JDWP_CLIENT_BASE_URL` | Debug Client API base (default `http://localhost:8083`) |
| `JDWP_TRIGGER_URL` | Optional endpoint to hit so target classes load before setting breakpoints |
| `JDWP_TRIGGER_TOKEN` | Auth token for the trigger URL (never hardcode tokens) |

## Security

The MCP server talks only to the local Debug Client. If that client runs with `JDWP_API_TOKEN`, pass the same token via env and add it to requests — see [docs/security.md](../docs/security.md).
