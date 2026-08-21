# Demo Debug Target

A small Spring Boot app (users + orders + async workflows) that runs in Docker with JDWP enabled. It exists so you can try the debugger end-to-end — in a real scenario this would be **your** application.

## Run

```bash
# from repo root
docker compose up -d --build
```

| Port | Purpose |
|---|---|
| 8081 | REST API |
| 5005 | JDWP agent (dev only — never expose this in production) |

## Endpoints worth debugging

- `GET /api/users` — list users
- `GET /api/users/{id}` — fetch one (good breakpoint target: `UserController`)
- `POST /api/orders` — layered demo: controller → service → repository
- `GET /api/workflow/async` — async execution across threads

## Build locally

```bash
mvn clean package
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005 \
     -jar target/debug-server-1.0.0.jar
```
