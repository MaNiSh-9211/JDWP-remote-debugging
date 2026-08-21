# Security

## Dependency policy

1. **Exact versions** — Each OS app (`windows`, `macos`, `linux`) lists dependencies without semver ranges. Upgrades are explicit edits + review.
2. **Lockfiles** — Commit `package-lock.json` per OS app. Prefer **`npm ci`** over `npm install` in automation so locks are honored.
3. **No automatic dependency updates** — Human-reviewed bumps only unless you add automation deliberately.
4. **No in-app auto-update** — The Electron shell does **not** include `electron-updater`. Ship new binaries explicitly.

## Electron shell

### Threat model

JDWP Studio is a **local debugger UI**. It trusts the user’s machine and a **Spring JDWP client** on `localhost` (or `127.0.0.1`). It is **not** hardened for loading arbitrary untrusted web content. Do not point the API base at untrusted hosts without code changes.

### Renderer

- **`contextIsolation: true`**, **`nodeIntegration: false`**, **`sandbox: true`**, **`webSecurity: true`**.
- **Content-Security-Policy** is applied via `session.defaultSession.webRequest.onHeadersReceived` in each OS `electron/main.cjs` (see `electron-security.cjs`). It restricts `connect-src` to the local API, Vite dev ports, fonts, and `connect-src 'self'`.
- **Navigation**: `will-navigate` blocks navigation away from the dev server origin (dev) or non-`file:` URLs (production bundle).

### IPC

- **`get-default-api-base`** returns `JDWP_API_BASE` from the environment after **validation** (only `http:`/`https:` to `localhost`, `127.0.0.1`, or `[::1]`).
- **`sanitize-api-base`** applies the same rules to URLs from the settings UI before they are stored.
- **`cluster-exec`** runs **`kubectl`** only (via `child_process.spawn`, no shell). The renderer sends a single command line; shell metacharacters are rejected; optional `KUBECONFIG` comes from the Cluster page. Commands time out after 120s. Requires `kubectl` on the user’s PATH.

### New windows / links

- `setWindowOpenHandler` opens only `http:`/`https:` in the system browser; other schemes are denied.

### DevTools

- Open **only** when the app is unpackaged (`!app.isPackaged`). Packaged builds do not auto-open DevTools.

## Optional hardening

- Run `npm audit` before releases.
- Pin Node LTS in CI (`.nvmrc` / `engines` if added).
- To allow a **remote** JDWP API host, extend `isAllowedApiBaseUrl` in each `electron/electron-security.cjs` and mirror policy in CSP `connect-src`.
