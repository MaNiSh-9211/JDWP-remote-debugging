# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| latest on `main` | ✅ |

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security problems.**

Use GitHub's private security advisory:
1. Go to **Security → Advisories → New draft security advisory**
2. Include: affected component, reproduction steps, impact assessment

You will get a response within 7 days. We credit reporters in release notes unless you prefer otherwise.

## Scope notes

This project is a debugger: by design it can read arbitrary memory of any JVM it attaches to. The following are **in scope**:

- The debug client HTTP API (`client/`) — auth bypass, SSRF via connect endpoint, injection
- Electron app (`client/jdwp-desktop/`) — IPC escalation beyond declared handlers, renderer escape
- MCP servers (`jdwp-mcp/`, `k8s-remote-debug/mcp-server/`) — command injection via tool args
- Kubernetes manifests — over-privileged RBAC or exposed JDWP ports

Out of scope: JDWP protocol weaknesses themselves (upstream JVM issue), social engineering.

## Hardening defaults already shipped

- Debug API token auth with constant-time comparison (`JDWP_API_TOKEN`)
- Localhost-only bind by default; explicit CORS allow-list
- Electron: contextIsolation + sandbox + strict CSP; IPC allowlists; read-only kubectl shell
- Least-privilege RBAC (no exec / no write verbs); JDWP never exposed via Services
