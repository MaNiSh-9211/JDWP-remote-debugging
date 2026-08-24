# Changelog

## v1.0.5 (2026-08-23)

First tagged release with full artifact pipeline.

### Added
- Logpoints (trace without pausing, `{var}` template tokens)
- Expression conditions (`>`, `<`, `==`, `!=`, `>=`, `<=`, `&&`, `||`)
- Per-breakpoint enable/disable
- Hit-count conditions ("break after N hits")
- Drop frame (rewind to last application frame)
- TimeLens request causality recorder
- Panic stop (clean-exit guarantee)
- Conditional logpoints (condition gates log emission)
- Breakpoint export/import JSON
- JDWP port auto-detect from pod spec
- Hit notifications (toasts on new hits while browsing other panels)
- Saved connection targets
- IDE keyboard shortcuts: F7/F8/Shift+F8/F9
- Server-side k8s endpoints for web UI cluster attach
- Prometheus metrics endpoint for Grafana
- Token support in both UIs (Studio Settings + web field)
- Release pipeline: NSIS/DMG/AppImage + JARs + GHCR images

### Fixed
- Event pump thread-safety (serialized bp-worker holding service monitor)
- Pump never blocks on slow condition evaluation or logpoint capture
- Logpoint entries now appear in REST `/logs/entries` (not just SSE)

---

## Earlier commits

See `git log` for full history. Key milestones:
- Initial open-source sanitization and restructuring
- JDWP event pump implementation (breakpoints actually suspend)
- Security hardening pass (token auth, rate limiting, allow-lists)
- Web UI complete redesign (sidebar layout, all panels)
- Services browser (GitHub/Bitbucket repos+branches+clone)
- Electron cluster terminal (read-only kubectl)
- Preflight script + one-command E2E proof
