# Production Debugging Guide

Two supported ways to make a production/UAT service debuggable **without blocking other requests** and without code changes to your business logic.

## Approach 1 — Maven dependency (recommended for services you own)

Add one dependency to the service's `pom.xml`:

```xml
<dependency>
    <groupId>com.debugger</groupId>
    <artifactId>debug-filter-lib</artifactId>
    <version>1.0.0</version>
</dependency>
```

Build & install it locally first:

```bash
cd k8s-remote-debug/debug-filter-lib
mvn clean install
```

What it does at runtime:

- Registers `DebugRequestFilter`, a servlet filter that inspects every incoming request for the header `X-Debug-Request-Id`.
- If the header matches an active debug session → the request context is recorded and the thread may be suspended by the debugger.
- If not → the filter is a no-op. **Untagged production traffic is never paused.**

Enable JDWP on the deployment (no restart logic changes needed):

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005"
```

Expose nothing new: keep 5005 off every Service/Ingress.

## Approach 2 — Dynamic agent (zero changes, works on any JVM)

For services you can't rebuild:

```bash
# 1. Build the agent
cd k8s-remote-debug/debug-agent && mvn clean package

# 2. Copy into the running pod
kubectl cp target/debug-agent-1.0.0.jar <namespace>/<pod>:/tmp/debug-agent.jar

# 3. Load it through the Debug Client (already attached via port-forward)
curl -X POST "http://localhost:8083/api/debug/connect?host=localhost&port=5005"
curl -X POST "http://localhost:8083/api/debug/load-agent?agentPath=/tmp/debug-agent.jar"
```

The agent registers the same selective-pause machinery via `Instrumentation`; no redeploy required.

## The non-blocking workflow

```bash
# Create a session (in-cluster debugger API or MCP tool)
curl -X POST http://localhost:8090/api/debug/sessions \
  -H "Content-Type: application/json" \
  -d '{"namespace":"my-ns","podName":"orders-7d9f8b6c-xk2p1","requestId":"debug-abc123"}'

# Set a breakpoint scoped to that session
curl -X POST http://localhost:8090/api/debug/sessions/<id>/breakpoints \
  -H "Content-Type: application/json" \
  -d '{"className":"com.acme.orders.OrderService","lineNumber":88}'

# Replay ONLY the request you want to inspect:
curl -H "X-Debug-Request-Id: debug-abc123" https://orders.internal/api/orders/42
```

Result: that single request suspends at line 88; every other request — including other calls to the same endpoint — completes normally.

## Rules of engagement for production

1. **Always use a unique request id per debugging run** — never reuse across sessions.
2. **Time-box sessions** — the in-cluster debugger expires idle sessions automatically; don't disable that.
3. **Never leave breakpoints set** — remove them when done; exception breakpoints are particularly chatty.
4. **Watch heap pressure** — deep variable inspection of large object graphs is expensive; prefer targeted frames.
5. **Close the tunnel** — kill `kubectl port-forward` as soon as you finish; it is your only door in.
