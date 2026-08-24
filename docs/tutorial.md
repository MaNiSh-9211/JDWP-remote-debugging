# Getting Started Tutorial

This walkthrough takes you from zero to debugging a live Kubernetes pod in 15 minutes, with expected output at every step.

## Prerequisites

| Tool | Minimum version | Check |
|------|----------------|-------|
| JDK | 21 | `java -version` |
| Maven | 3.9 | `mvn --version` |
| Docker | latest stable | `docker ps` |
| kubectl | latest stable | `kubectl version --client` |
| Node.js | 20 | `node --version` |

## Step 1: Build the project

```bash
mvn package -DskipTests
cd client/ui && npm ci && npm run build && cd ../..
```

Expected output: `BUILD SUCCESS` for Maven, `✓ built` for Vite.

## Step 2: Start the demo target

```bash
docker compose up -d --build
```

Verify it's running:
```bash
curl http://localhost:8081/api/users
# [{"id":1,"name":"John Doe",...}]
```

## Step 3: Start the debug client

```bash
cd client
mvn spring-boot:run
```

Wait for: `Started JdwpDebugClientApplication in X seconds`

Open http://localhost:8083 — you should see the web UI.

## Step 4: Attach to the JVM

In the web UI:
1. Click **Session** in the left rail
2. Host should be `localhost`, port `5005`
3. Click **Attach to JVM**

You should see: `● localhost:5005` pill turn green.

Or via curl:
```bash
curl -X POST "http://localhost:8083/api/debug/connect?host=localhost&port=5005"
# {"success":true,"message":"Connected successfully"}
```

## Step 5: Set your first breakpoint

Click **Breakpoints** in the rail:
- Type: Line (suspend)
- Class: `com.jdwp.server.controller.UserController`
- Line: `31`
- Click **Add line breakpoint**

## Step 6: Trigger it and see non-blocking in action

**Untagged request (should NOT pause):**
```bash
time curl -s http://localhost:8081/api/users > /dev/null
# real    0m0s — completes normally ✅
```

**Tagged request (SHOULD pause):**
```bash
# In one terminal — this will HANG:
curl -H "X-Debug-Request-Id: my-debug-1" http://localhost:8081/api/users
# ...hangs waiting...
```

**In another terminal — verify suspension:**
```bash
curl http://localhost:8083/api/debug/threads | python -m json.tool | grep suspended
# Some threads show "suspended": true ← your tagged request is paused!
```

**Inspect variables:**
```bash
curl "http://localhost:8083/api/debug/threads/http-nio-8081-exec-X/frames"
# Shows method, line number, and local variable values
```

**Resume:**
```bash
curl -X POST "http://localhost:8083/api/debug/threads/http-nio-8081-exec-X/resume"
# Your hanging curl command completes immediately
```

## Step 7: Try a logpoint (trace without pausing)

Switch to **Logpoint** type in the Breakpoints panel:
- Log message: `processing user request, a={a}`
- Condition: `a > 10` (optional)
- Click **Add logpoint**

Now every request logs to the live stream without pausing:
```
[LOGPOINT UserController:31] processing user request, a=20
```

---

# Glossary

| Term | Definition |
|------|-----------|
| **JDWP** | Java Debug Wire Protocol — the wire protocol debuggers use to communicate with JVMs |
| **JDI** | Java Debug Interface — the high-level Java API for building debuggers (wraps JDWP) |
| **EventSet** | A batch of debug events read from the EventQueue; JDI only applies suspend policies when these are consumed |
| **Suspend policy** | What happens when a breakpoint hits: SUSPEND_NONE, SUSPEND_EVENT_THREAD, or SUSPEND_ALL |
| **Request-scoped debugging** | Only requests carrying a specific header are paused; all others flow through |
| **Port-forward** | Kubernetes mechanism to tunnel a local port to a pod port without exposing via Service |
| **Logpoint** | Breakpoint variant that captures variables and emits them to a log stream without pausing |
| **Drop frame** | Rewind execution to re-run a method call from its start |
| **TimeLens** | This project's causality recorder — captures ordered variable snapshots across multiple probe lines |
| **Panic stop** | One-click cleanup: resume all threads, remove all instrumentation, detach from VM |
| **MCP** | Model Context Protocol — standard protocol for AI tools to interact with external systems |

---

## Troubleshooting during setup

| Error | Fix |
|-------|-----|
| `Port 8083 already in use` | Kill previous instance: `Get-NetTCPConnection -LocalPort 8083 \| % { Stop-Process -Id $_.OwningProcess }` |
| `Unable to rename .jar` | Client is running — kill java first, rebuild, restart |
| `Class not loaded yet` | Hit the endpoint once before setting breakpoint on that class |
| `kind load failed` | Ensure Docker is running and image was built: `docker compose build debug-server` |
