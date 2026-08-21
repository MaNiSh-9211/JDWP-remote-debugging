# JDWP Studio (Electron)

## Layout

| Path | Role |
|------|------|
| `app/shared/renderer/` | React UI (single lightweight bundle) |
| `app/windows/` | Windows-only Electron shell + Vite (port **5177**) |
| `app/macos/` | macOS-only Electron shell + Vite (port **5178**) |
| `app/linux/` | Linux-only Electron shell + Vite (port **5179**) |

Each OS folder is its **own** `package.json`, lockfile, and `electron/` entry — no shared `node_modules` between OSes. The **renderer** is one tree so fixes ship once; to duplicate it per OS, copy `shared/renderer` (not recommended).

## Security (dependency policy)

- **Pinned versions** in each OS `package.json` (no `^` / `~`).
- **`.npmrc`**: `save-exact=true` — use `npm ci` for reproducible installs; avoid `npm update` in CI/production.
- **No `electron-updater`** — no automatic binary updates from the network; ship new builds deliberately.

See `app/SECURITY.md`.

## Run (from repo root `client/jdwp-desktop`)

1. Start the Spring JDWP client (e.g. `http://localhost:8083`).
2. Install and dev **once per machine** from the folder for your OS:

```bash
cd app/windows   # or app/macos / app/linux
npm ci
npm run electron:dev
```

Or from `jdwp-desktop/`: `npm run windows` | `npm run macos` | `npm run linux` (installs deps then starts dev).

## Build installers

```bash
cd app/windows && npm run electron:build
```

(Use `app/macos` or `app/linux` with their `electron:build` scripts on the target OS or CI.)
