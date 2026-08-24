# Contributing

## Development setup

```bash
git clone https://github.com/MaNiSh-9211/JDWP-remote-debugging.git
cd JDWP-remote-debugging
```

Prerequisites: JDK 21+, Maven 3.9+, Node 20+, Docker.

```bash
# Build everything
mvn package -DskipTests          # Java modules (client, server, k8s-debug, filter-lib, agent)
cd jdwp-mcp && npm ci && npm run build && cd ..
cd k8s-remote-debug/mcp-server && npm ci && npm run build && cd ../..
cd client/ui && npm ci && npm run build && cd ../..
```

## Running tests

```bash
# Java unit tests
mvn test -pl client

# Full CI suite (same as GitHub Actions):
# - gitleaks secret scan
# - all 5 Maven modules
# - both MCP servers
# - web UI build
```

## Coding standards

- No secrets in code — gitleaks will block your PR
- All new REST endpoints go through the token filter + rate limiter (they cover `/api/*` automatically)
- JDI calls must be serialized: use the service monitor or the bp-worker executor
- Electron IPC handlers validate inputs; no shell spawning without allow-lists
- Keep the security posture intact: no exec/write RBAC verbs, no wildcard CORS, no `unsafe-inline` CSP in production builds

## Submitting changes

1. Create a feature branch from `main`
2. Make your changes with tests where applicable
3. Run the full build locally
4. Push and open a PR against `main`
5. CI must pass before review

## Releasing

1. Update version references if needed
2. Tag: `git tag v1.x.y && git push origin v1.x.y`
3. The release workflow builds installers, JARs, and Docker images automatically
