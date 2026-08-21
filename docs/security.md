# Security Model

JDWP remote debugging is inherently privileged: a debugger can read every variable in a running JVM. This document describes the controls that make that safe, and what **you** must configure when deploying.

## Threat model

| Threat | Mitigation |
|---|---|
| Attacker reaches JDWP port of a production JVM | JDWP is never published. ClusterIP-only + on-demand `kubectl port-forward`. NetworkPolicy restricts in-cluster access to 5005. |
| Rogue process on the developer machine calls the Debug Client API | Client binds to `localhost` by default; set `JDWP_API_TOKEN` to require authenticated calls; CORS is an explicit allow-list (no `*`). |
| Compromised renderer (XSS) in the Electron app | Context isolation + sandbox enabled, strict CSP, navigation guards, `setWindowOpenHandler` denies all popups, IPC handlers validate inputs. |
| Renderer tricks kubectl into destructive actions | The cluster terminal only executes an allow-list of read-only subcommands (`get`, `describe`, `logs`, …). Shell spawning is disabled and metacharacters are rejected. |
| Service account abused for lateral movement | RBAC grants only `pods get/list/watch`, `pods/portforward create`, `pods/log get`. **No exec, no write verbs, no secrets access.** |
| Forgotten debug sessions keep production threads paused | Sessions auto-expire; in-cluster debugger tracks and closes port-forwards; audit log records every action with actor + timestamp. |
| Secrets leak through captured logs/variables | Log capture runs locally between client and target; nothing is persisted server-side. Scrub headers before replaying requests you don't own. |

## Debug Client API hardening

The client ships secure-by-default and hardens further with two environment variables:

```bash
# Require a bearer token on every /api call (constant-time compared):
export JDWP_API_TOKEN="$(openssl rand -hex 32)"

# Bind beyond localhost ONLY if the token is set:
export JDWP_SERVER_ADDRESS=0.0.0.0   # e.g. when running the client in a container

# Restrict browser origins that may call the API:
export JDWP_CORS_ALLOWED_ORIGINS="http://localhost:5177"
```

Clients then send `X-Debug-Token: <token>` or `Authorization: Bearer <token>`.
Only `/api/debug/ping` (a liveness check) is exempt.

## Kubernetes hardening checklist

- [ ] JDWP containerPort exists on the pod but **not** on any Service
- [ ] Debugger Deployment uses the least-privilege ServiceAccount (`k8s-debug/k8s-manifests/rbac.yaml`)
- [ ] NetworkPolicy allows 5005 ingress only from the debugger's namespace (see `k8s-remote-debug/k8s/network-policy.yaml`)
- [ ] Pods run `runAsNonRoot`, read-only root filesystem where possible, no privilege escalation
- [ ] `kubectl port-forward` sessions are short-lived and closed after debugging
- [ ] Audit log from the in-cluster debugger shipped to your logging stack

## Protocol-level caveats

- **JDWP is plaintext.** Anyone who can observe the tunnel can read debug traffic. Use SSH/port-forward/VPN; never expose 5005 via NodePort/LoadBalancer/Ingress.
- **JDWP has no authentication.** Possession of network access to the port equals full control of the JVM. This is why the default posture is "tunnel only".
- **`suspend=y` blocks startup.** All tooling here uses `suspend=n`; the demo images enforce this.

## Reporting vulnerabilities

Open a private security advisory via GitHub ("Security" → "Report a vulnerability") rather than a public issue.
