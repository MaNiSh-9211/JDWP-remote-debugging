# Shared renderer

Single **React + Vite** UI consumed by each OS Electron app via `vite.config.js` (`root: ../shared/renderer`).

This avoids maintaining three copies of the same JSX while still keeping **separate** `node_modules`, lockfiles, and Electron mains under `app/windows`, `app/macos`, and `app/linux`.
