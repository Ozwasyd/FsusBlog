# Troubleshooting

This guide covers common public-preview local development failures.

## .NET SDK Version Mismatch

Symptom: `dotnet run` or `dotnet test` fails with an SDK or target framework error.

Likely cause: .NET SDK 10 is missing or an older SDK is first on `PATH`.

How to verify:

```bash
dotnet --version
dotnet --list-sdks
```

Fix: install .NET SDK 10 and reopen the shell so the new SDK is first on `PATH`.

Relevant logs: terminal output from `dotnet run`, `dotnet test`, or `./tools/dev/start.sh`.

## Node / npm / pnpm Version Mismatch

Symptom: `npm ci`, Vite, Vitest, or frontend build fails with engine or lockfile errors.

Likely cause: Node or npm is too old, or pnpm was used against the npm lockfile.

How to verify:

```bash
node --version
npm --version
```

Fix: use Node 20+ and npm 10+. Do not replace `src/frontend/package-lock.json` with a pnpm lockfile unless the project intentionally changes package managers.

Relevant logs: `src/frontend/npm-debug.log`, terminal output from `npm ci`, Vite, or Vitest.

## PostgreSQL Connection Failure

Symptom: backend startup fails with a database connection or migration error.

Likely cause: the dev PostgreSQL container is not running, port `5432` is occupied, or connection environment variables were changed.

How to verify:

```bash
docker compose -f deploy/dev/docker-compose.yml ps
docker exec fsusblog-dev-postgres pg_isready -U fsusblog -d fsusblog
```

Fix: free port `5432`, set `FSUSBLOG_DEV_POSTGRES_PORT` to another local port, or restart the dev dependencies:

```bash
docker compose -f deploy/dev/docker-compose.yml up -d postgres
```

Relevant logs: backend console logs and `docker logs fsusblog-dev-postgres`.

## Redis Connection Failure

Symptom: backend startup, PoW, session, notification, or cache flows fail with Redis connection errors.

Likely cause: Redis is not running, port `6379` is occupied, or the Redis connection string points to the wrong host.

How to verify:

```bash
docker compose -f deploy/dev/docker-compose.yml ps
docker exec fsusblog-dev-redis redis-cli ping
```

Fix: free port `6379`, set `FSUSBLOG_DEV_REDIS_PORT`, or restart Redis:

```bash
docker compose -f deploy/dev/docker-compose.yml up -d redis
```

Relevant logs: backend console logs and `docker logs fsusblog-dev-redis`.

## Port Conflicts

Symptom: PostgreSQL, Redis, backend, or frontend cannot bind to a port.

Likely cause: another local service is already using `5432`, `6379`, `7568`, or `3000`.

How to verify:

```bash
lsof -i :5432
lsof -i :6379
lsof -i :7568
lsof -i :3000
```

Fix: stop the conflicting process, change `FSUSBLOG_DEV_POSTGRES_PORT` / `FSUSBLOG_DEV_REDIS_PORT`, or adjust backend/frontend ports for the current shell.

Relevant logs: terminal output from Docker, ASP.NET Core, or Vite.

## Frontend Dev Server Proxy Failure

Symptom: the Vite page loads, but API calls fail with network errors or `502`.

Likely cause: backend is not running on `http://127.0.0.1:7568` or Vite proxy configuration points at a different target.

How to verify:

```bash
curl -i http://127.0.0.1:7568/health/live
```

Fix: start the backend with `./tools/dev/start.sh`, or update the local Vite proxy only for the current development environment.

Relevant logs: browser console, Vite terminal, backend terminal.

## AEDS Decode / WASM Worker Issue

Symptom: public pages or admin calls fail after receiving binary responses; console mentions AEDS, Wasm, worker, or decode failure.

Likely cause: Wasm artifacts are missing, stale, or blocked by the browser.

How to verify:

```bash
cd src/frontend
npm run ensure:wasm
```

Fix: regenerate or refresh Wasm artifacts with `npm run ensure:wasm`; for local Wasm development, rebuild with the documented Emscripten flow in [docs/wasm.md](wasm.md).

Relevant logs: browser console, `wasmDecode.worker.ts` debug output, Vite terminal.

## WebAuthn RP ID / Origin Configuration Issue

Symptom: Passkey registration or login fails with RP ID, origin, or WebAuthn ceremony errors.

Likely cause: the browser origin does not match `Fido2:ServerDomain` and `Fido2:Origins`.

How to verify:

```bash
curl -s http://127.0.0.1:7568/health/live
```

Then confirm the frontend is opened at `http://localhost:3000` or `http://127.0.0.1:3000`.

Fix: use the documented local URLs, or set matching `Fido2__ServerDomain` and `Fido2__Origins__*` environment variables before backend startup.

Relevant logs: browser console and backend auth logs.

## Login / Session / Cookie Issues

Symptom: login succeeds but the UI behaves as logged out, refresh fails, or cookies are missing.

Likely cause: origin mismatch, blocked third-party cookies, stale cookies, or insecure local HTTP cookie settings.

How to verify: inspect browser devtools Application/Storage cookies for `localhost` and `127.0.0.1`.

Fix: clear local cookies for both origins, use one consistent origin, and start through `./tools/dev/start.sh` so local insecure transport cookie settings are applied for development.

Relevant logs: browser network panel, backend auth logs.

## Migration Failure

Symptom: backend starts but reports missing tables, duplicate indexes, or schema migration errors.

Likely cause: interrupted CodeFirst migration, stale local volume, or a schema created by an incompatible branch.

How to verify:

```bash
docker logs fsusblog-dev-postgres
```

Fix: for disposable local data, reset the dev volumes:

```bash
./tools/dev/start.sh --cleanup
./tools/dev/start.sh --seed-demo
```

Relevant logs: backend startup logs and PostgreSQL logs.

## Public AOT Worker Failure

Symptom: public pages fall back to SPA shell, AOT cache stays empty, or logs mention Public AOT renderer failure.

Likely cause: frontend SSR bundle is stale, Node is missing, or the AOT worker cannot write cache files.

How to verify:

```bash
npm --prefix src/frontend run build:release
```

Fix: rebuild frontend assets, confirm Node is available, and ensure the backend process can write its local data/cache directory.

Relevant logs: backend PublicAOT logs, frontend build logs, `.tmp` or backend data-root logs if configured.

## Permission / File Path Issues On Linux, macOS, Or Windows

Symptom: build, upload, AOT cache, logs, or Docker volume writes fail with permission denied or path errors.

Likely cause: mixed host/container ownership, Windows path conversion, readonly checkout, or a stale Docker volume.

How to verify:

```bash
git status --short
docker compose -f deploy/dev/docker-compose.yml ps
```

Fix: keep the repo in a normal writable workspace, avoid running package managers as root, reset disposable dev volumes when needed, and use WSL2/Linux paths for Docker-heavy workflows on Windows.

Relevant logs: shell output, Docker logs, backend file I/O exceptions.
