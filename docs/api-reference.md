# API Reference

All endpoints live under the debug client's base URL (`http://localhost:8083` by default). When `JDWP_API_TOKEN` is set, every request must include the token via `X-Debug-Token` header or `Authorization: Bearer` — except `/api/debug/ping`.

## Table of contents

- [Connection](#connection)
- [Threads](#threads)
- [Breakpoints](#breakpoints)
- [Advanced breakpoints](#advanced-breakpoints)
- [TimeLens recorder](#timelens-recorder)
- [Panic stop](#panic-stop)
- [Live logs](#live-logs)
- [Metrics & diagnostics](#metrics-diagnostics)
- [Kubernetes (web)](#kubernetes-web)
- [Source viewer](#source-viewer)

---

## Connection

Base path: `/api/debug`

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| POST | `/connect` | `host`, `port` | `{success, message}` |
| POST | `/disconnect` | — | `{success, message}` |
| GET | `/ping` | — (public) | `{ok, service}` |
| GET | `/status` | — | `{connected, targetHost, targetPort, vmDescription}` |
| GET | `/client-config` | — | client runtime config |

### Example: attach

```bash
curl -X POST "http://localhost:8083/api/debug/connect?host=localhost&port=5005"
# {"success":true,"message":"Connected successfully"}
```

---

## Threads

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| GET | `/threads` | — | `{threads: [{name, suspended, status, ...}]}` |
| GET | `/threads/{name}/frames` | — | `{frames: [{className, methodName, lineNumber, variables}]}` |
| GET | `/threads/{name}/variables-enhanced` | `includeInstance` | `{variables: {...}}` |
| GET | `/threads/{name}/source-location` | — | `{className, methodName, lineNumber, sourceName}` |
| POST | `/threads/{name}/step-over` | — | `{success}` |
| POST | `/threads/{name}/step-into` | — | `{success}` |
| POST | `/threads/{name}/step-out` | — | `{success}` |
| POST | `/threads/{name}/resume` | — | `{success}` |
| POST | `/threads/{name}/suspend` | — | `{success}` |
| POST | `/continue` | — | resumes all threads |
| POST | `/threads/{name}/reset-frame` | `applicationPackagePrefix?` | pops frames back to last app frame |
| GET | `/threads/{name}/evaluate` | `expression`, `frameIndex?` | `{result}` |

Supported expression syntax: variable names · `variable.field` · `variable.method()` · comparisons (`>`, `<`, `>=`, `<=`, `==`, `!=`) · boolean literals · string literals · numeric literals · logical `&&` / `||`.

---

## Breakpoints

Base path: `/api/debug`

| Method | Path | Body/Params | Returns |
|--------|------|-------------|---------|
| GET | `/breakpoints` | — | `{breakpoints: [{id, location, logMessage?, condition?, disabled}]}` |
| POST | `/breakpoints` | `className`, `lineNumber` | `{breakpointId, success}` |
| DELETE | `/breakpoints/{id}` | — | removes one |
| DELETE | `/breakpoints` | — | removes all |
| POST | `/breakpoints/toggle` | `{id, enabled}` | enable/disable without removing |
| POST | `/breakpoints/mute` | `muted` | mute/unmute globally |
| GET | `/breakpoints/mute` | — | current mute state |
| GET | `/breakpoints/hit-stats` | — | `{hits: {bpId: count}}` |
| GET | `/breakpoints/seed-default` | — | demo seed template |

---

## Advanced breakpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/breakpoints/advanced` | `{className, lineNumber, logMessage?, condition?, minHits?}` | Creates logpoint and/or expression-condition and/or hit-count BP. One per location (replaces existing). |
| POST | `/breakpoints/conditional` | `className`, `lineNumber`, `targetRequestId` | Request-scoped: only suspends requests carrying matching `X-Debug-Request-Id`. |
| POST | `/breakpoints/method` | `className`, `methodName`, `signature?` | Break on method entry. |
| POST | `/watchpoints/field` | `className`, `fieldName`, `onRead`, `onWrite` | Watch field access/modification. |

### Logpoint example

```json
POST /api/debug/breakpoints/advanced
{
  "className": "com.example.OrderService",
  "lineNumber": 88,
  "logMessage": "order {orderId} status={status} amount={amount}",
  "condition": "amount > 1000"
}
```

Result: every hit with `amount > 1000` logs `"order 42 status=SHIPPED amount=1500"` to the SSE stream; thread never pauses.

### Hit-count example

```json
POST /api/debug/breakpoints/advanced
{
  "className": "com.example.UserService",
  "lineNumber": 42,
  "minHits": 5
}
```

Hits 1–4 auto-resume; hit 5 suspends normally.

---

## TimeLens recorder

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/recorder/start` | `{sessionKey, locations: ["Class:line", ...]}` | `{sessionKey, installed}` |
| POST | `/recorder/{key}/stop` | — | `{removedBreakpoints}` |
| GET | `/recorder/{key}` | — | `{recording, steps: [{timestamp, class, method, line, locals, thread}]}` |

Steps are ordered chronologically, capped at 500 per session. Each step's `locals` are redacted via `SecretRedactor`.

---

## Panic stop

```json
POST /api/debug/panic
```

Resumes all suspended threads, removes all breakpoints/watchpoints/recorder BPs, clears state, detaches from VM. Returns:

```json
{
  "threadsResumed": 3,
  "breakpointsRemoved": 2,
  "watchpointsCleared": 0,
  "detached": true
}
```

---

## Live logs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/logs/entries?limit=N&thread=X` | Recent captured entries (JSON array) |
| GET | `/logs/stream` | Server-Sent Events stream (text/event-stream) |

Entries have: `type` (application/logpoint/tripwire), `stream`, `thread`, `timestamp`, `message`. Values are redacted by `SecretRedactor` before storage/broadcast.

---

## Metrics & diagnostics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/actuator/prometheus` | Prometheus-format metrics for Grafana scraping |
| GET | `/actuator/health` | Liveness/readiness probes |
| GET | `/thread-dump` | jstack-style dump of all threads |
| GET | `/execution-radar` | Top frame per thread (activity map) |

---

## Kubernetes (web)

Base path: `/api/k8s` — powers the browser UI's cluster attach features.

| Method | Path | Params/Body | Returns |
|--------|------|-------------|---------|
| GET | `/contexts` | `kubeconfig?` | `{contexts: ["kind-x", "prod-y"]}` |
| GET | `/namespaces` | `kubeconfig?`, `context?` | `{namespaces: [...]}` |
| GET | `/pods` | `kubeconfig?`, `context?`, `namespace` | `{pods: [{name, phase, running, jdwpPort}]}` |
| GET | `/logs` | `namespace`, `pod`, `tail?`, `context?` | `{logs: "..."}` |
| POST | `/forward` | `{context, namespace, pod, remotePort, localPort}` | tunnel lifecycle |
| GET | `/forwards` | — | active tunnels list |
| DELETE | `/forward/{localPort}` | — | stop tunnel |
| POST | `/kubeconfig` | `{content}` | saves uploaded kubeconfig, returns path |

Security: identifiers validated against `[a-zA-Z0-9._-]` pattern before URL interpolation. Read-only verbs + port-forward only. No shell spawned.

## Source viewer

Base path: `/api/source`

| Method | Path | Params | Returns |
|--------|------|--------|---------|
| POST | `/root` | `{path: "/local/repo"}` | `{rootKey, path}` |
| GET | `/list` | `rootKey`, `dir?` | directory listing |
| GET | `/file` | `rootKey`, `path`, `line?` | file contents (extension allow-listed) |
