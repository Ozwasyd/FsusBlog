# Local development guide

This guide sets up a complete FsusBlog development environment locally.

---

## Coding standards and authoritative-document gates

The cross-language style authority is [development/coding-conventions.md](development/coding-conventions.md). It derives its mappings from Microsoft .NET C# conventions and defines external-contract exceptions plus generated/vendor/fixture classifications; `AGENTS.md` retains only agent role and operating boundaries.

[Code intent governance](development/code-intent-governance.md) covers ownership, security boundaries, TODO lifecycle, public API documentation, and performance-claim levels. It consumes the coding authority rather than creating a peer style authority.

The [custom rule platform](development/custom-rule-platform.md) defines shared identity, inventory/cache, changed-file dependency closure, execution summaries, and category-based complexity/responsibility budgets for FsusBlog checks. Adding or migrating a custom rule requires updating its machine-readable registry; compiler or AST tools remain responsible for language-generic rules.

[Change contract](development/change-contract.md) defines commit/squash titles, PR classification, format and naming migrations, performance/generated evidence, release-note labels, and rollback metadata. It governs Git/review metadata and does not create a second source-code naming system.

[Document lifecycle](development/document-lifecycle.md) defines current/proposed/historical/generated/retired status, ownership, the complete index, issue associations, supersession, and repository path migrations. These fields come from explicit metadata; authority must not be inferred from filenames, issue closure, or update time.

After changing a path, symbol, command, or standards entry point in a development document, run:

```bash
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
node tools/governance/check-rule-platform.mjs --mode changed --base origin/master
```

The gates aggregate invalid paths, retired symbols, missing commands, broken links, style-owner drift, and unclassified exceptions; they succeed only after all findings are fixed.

---

## Environment requirements

| Tool | Version | Purpose |
| ------ | --------- | ------ |
| .NET SDK | 10.0+ | Backend build and runtime |
| Node.js | 20 LTS+ | Frontend dependencies and build |
| npm | 10+ | Frontend package management |
| Docker + Docker Compose | Latest stable release | PostgreSQL, Redis, and backend containers |
| Emscripten SDK | Latest stable release | Required only to rebuild Wasm locally |

Verify the installation:

```bash
dotnet --version          # should print 10.x.x
node --version            # should print v20.x.x
npm --version             # should print 10.x.x
docker compose version    # should print v2.x.x
```

---

## First-time setup

### NuGet package versions

The root [`Directory.Packages.props`](../Directory.Packages.props) is the repository's sole NuGet version authority. `.csproj` files declare package references and retain project-level reference semantics such as `PrivateAssets` and `IncludeAssets`; never put `Version`, nested `Version`, or `VersionOverride` in a `PackageReference`.

When upgrading a NuGet package, edit only `Directory.Packages.props`, then regenerate and commit each affected project's own `packages.lock.json`. Adding or removing a `ProjectReference`, or changing a referenced project's package/project dependency edge, also requires the non-locked restore generator to update every affected consumer lock graph; `--locked-mode` validates but does not repair a stale graph. Before committing, run:

```bash
dotnet restore FsusBlog.slnx --locked-mode
node tools/governance/check-central-package-management.mjs
bash tools/security/check-supply-chain-audit.sh
```

`Directory.Build.props` continues to enable `RestorePackagesWithLockFile`, and CI or GitHub Actions enables `RestoreLockedMode`; do not avoid version drift by deleting lockfiles or disabling locked restore.

### 1. FsusUI private component library

The frontend component library is distributed through GitHub Packages. Set a personal access token before installing it:

```bash
export GITHUB_PACKAGES_TOKEN=your_github_personal_access_token
```

To persist it, add it to a shell profile (`~/.bashrc` or `~/.zshrc`). The token requires `read:packages` permission.

### 2. Wasm prebuilt artifacts

The repository does not include precompiled Wasm. Before the first development run, ensure that `src/frontend/wasm/` contains a built `.wasm` file:

```bash
cd src/frontend
npm run ensure:wasm
```

To rebuild Wasm locally (Emscripten SDK required):

```bash
npm run build:wasm
```

---

## Start the development environment

### One-command startup (recommended)

```bash
# Default zero-data mode: writes no business rows, auth identity, session, or security reset
./tools/dev/start.sh

# Explicit demo dataset (fixture profile catalog id)
./tools/dev/start.sh --fixture-profile demo-public

# Explicit acceptance representative auth/public fixtures
./tools/dev/start.sh --fixture-profile acceptance-representative
```

This entry point starts:

- PostgreSQL (default `127.0.0.1:5432`)
- Redis (default `127.0.0.1:6379`)
- ASP.NET Core backend (`http://127.0.0.1:7568`)
- Vite frontend (`http://127.0.0.1:3000`)
- The selected fixture only when `--fixture-profile` explicitly names a catalog ID (default `none`)

To clean up local development containers and volumes:

```bash
./tools/dev/start.sh --cleanup
```

See [development/demo-data.md](development/demo-data.md) for demo seed details and [testing/fixture-capability-catalog.md](testing/fixture-capability-catalog.md) for the fixture-profile catalog.

### Start backend dependencies manually

If the one-command entry point is unavailable, start local dependencies first:

```bash
docker compose -f ops/development/dependencies.compose.yml up -d postgres redis
```

Then start the ASP.NET Core backend:

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj --urls http://127.0.0.1:7568
# Or use Visual Studio / Rider's "Debug / NativeServer" configuration
```

### Start the frontend development server manually

```bash
npm --prefix src/frontend ci                 # Run first or after dependency changes
npm --prefix src/frontend run dev:debug      # Vite HMR on 0.0.0.0:3000
npm --prefix src/frontend run dev:ssr        # Debug only the backend public-shell SSR proxy
```

By default, `dev` / `dev:debug` let Vite serve public-page entry points and `/src` resources directly. They are intended for frontend styles, public-page interactions, and local FsusUI HMR; do not enable the backend public-shell SSR proxy for this work.

`dev:ssr` sets `VITE_PUBLIC_SHELL_PROXY=1` and proxies public SEO routes to the local backend. Use it only to validate the backend SSR shell, AOT backfill, and precompiled public-page output; confirm that the backend is running at `http://127.0.0.1:7568` first.

In dev mode, Vite uses `transformIndexHtml` to inject `public-shell-critical.css?direct` and `public-page.css?direct`, placing first-paint public-page CSS in the Vite module graph for source CSS HMR and avoiding FOUC from links added only after hydration. Production does not use `?direct`; runtime enables the emergency fallback (`/public-shell-emergency.css`) only when no usable stylesheet is available.

`public/public-shell-emergency.css` is generated by `npm run generate:public-shell-emergency` from the `emergency:keep` block in `src/assets/public-page.css` and is also written to `dist/server/public-shell-emergency.css`. Contributors should edit only the minimal first-paint rules between `/* emergency:keep-start */` and `/* emergency:keep-end */` in the source CSS; ordinary public-page rules without those markers do not enter the emergency fallback.

### Common URLs

| URL | Purpose |
| ------ | ------ |
| `http://127.0.0.1:3000` | Vite frontend development shell (HMR) |
| `http://127.0.0.1:7568` | ASP.NET Core API (local Debug run) |
| `http://127.0.0.1:8080` | Production-build preview (Release container) |

### Local Passkey injection

#### 本地 Passkey 注入

Under the current anonymous identity mode, legacy `sys_user` password login and legacy
`role=admin` no longer grant login or admin access. Demo seed creates only the anonymous
account container `demo-reader` and a disabled mock admin principal `demo-admin` for
attribution display; neither is a login credential. For the first local login, create a
credential through the browser Passkey ceremony. Automation or environments without a
physical authenticator may inject a Passkey into the browser's WebAuthn virtual
authenticator, then complete the real registration/admin bootstrap flow.

The local HTTPS exemption applies only to loopback origins:

- Prefer `http://localhost:3000` for Passkey registration, login, and admin bootstrap.
- If `http://127.0.0.1:3000` is required, set `Fido2__ServerDomain` to `127.0.0.1`
  and `Fido2__Origins__0` to `http://127.0.0.1:3000` before starting the backend. Do not
  mix `localhost` and `127.0.0.1` for one credential; WebAuthn credentials are isolated
  by RP ID.
- LAN IPs, Docker bridge IPs, and custom internal domains still require HTTPS and matching
  `Fido2:ServerDomain` / `Fido2:Origins`; the local exemption must not extend to production
  or shared environments.

Playwright / Chromium injection example:

```ts
const context = await browser.newContext({ baseURL: 'http://localhost:3000' })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)

await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true
  }
})

await page.goto('/login')
```

The injection above creates only a browser-side virtual authenticator. You must still use
the normal UI or binary API to perform Passkey registration, Recovery Key binding, or
`/api/binary/auth/admin/bootstrap/passkey/begin|complete`. Do not insert fixed private-key
or public-key rows directly into `passkey_credential` or `admin_passkey_credential`; doing
so bypasses challenge consumption, origin validation, and the audit path, and cannot prove
that the browser holds the credential.

To create a local root admin principal, provide a one-time bootstrap token before starting
the backend:

```bash
export FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN=local-dev-bootstrap-token
/opt/homebrew/bin/bash ./tools/dev/start.sh --fixture-profile none
```

Then complete the admin-bootstrap Passkey ceremony on the same loopback origin. Once a root
admin exists, the bootstrap endpoint permanently rejects reinitialization; to rebuild local
identity, clean the dev PostgreSQL / Redis volumes and restart.

---

## Development configuration

### Backend configuration authority

`src/backend/appsettings.json` is the sole shared base. Create the Git-ignored development overlay only when local differences are necessary:

```bash
cp src/backend/appsettings.Development.example.json src/backend/appsettings.Development.json
```

The example contains only 11 intentional leaf overrides for loopback PostgreSQL/Redis, the local auth fixture, the insecure local cookie, the synthetic release fence, and the localhost browser origin; do not copy the entire base into it. ASP.NET Core merges settings in this order: base < `appsettings.Development.json` < environment variable < command line.

Production uses the tracked `appsettings.Production.json` as its real fail-closed policy overlay. Operators create a private `.env.production` from `config/examples/.env.production.example`. The full production precedence is base < Production overlay < `.env.production`/Compose environment < command line; real secrets must come from the environment, user-secrets, or a mounted file and must not enter tracked JSON/examples. See [appsettings authority](configuration/appsettings-authority.md).

### Frontend proxy configuration

Vite forwards `/api/` requests to the backend through the `proxy` configuration in `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:7568',
                changeOrigin: true
            }
        }
    }
})
```

The `/health` endpoint must be called directly on the backend port (default `http://127.0.0.1:7568`), not through the Vite proxy.

All frontend API calls use relative paths, so no base-URL switch is needed between development and production.

---

## Common npm scripts

### Development

| Command | Description |
| ------ | ------ |
| `npm run generate:public-page-manifest` | Generate the frontend public-page manifest from `src/shared/Contracts/Outputs/PublicPageContracts.cs` |
| `npm run generate:public-shell-emergency` | Generate public-page emergency CSS from the `emergency:keep` block in `src/assets/public-page.css` |
| `npm run dev` | Start the Vite development server (source entry, frontend styles and local FsusUI HMR) |
| `npm run dev:debug` | Start the Vite development server (source entry, HMR, host `0.0.0.0:3000`) |
| `npm run dev:ssr` | Set `VITE_PUBLIC_SHELL_PROXY=1` and start backend public-shell SSR-proxy debug mode |
| `npm run build:release` | Build for production (output to `dist/`) |

`dev`, `dev:debug`, `dev:ssr`, `test:unit:*`, and `build:release` first synchronize the public-page manifest automatically, preventing drift between frontend AOT page identity and the shared C# contract.

### Wasm

| Command | Description |
| ------ | ------ |
| `npm run ensure:wasm` | Check for and fetch Wasm prebuilt artifacts |
| `npm run build:wasm` | Recompile Wasm locally (Emscripten required) |
| `npm run deps:wasm-codec` | Update Wasm dependencies |
| `npm run deps:freshness` | Query live registry/GitHub inputs and emit the three-state freshness of `update-surface.json`; only explicit `--fixtures` uses local-controlled-simulation, and unavailable inputs fail closed |

### Static checks

| Command | Description |
| ------ | ------ |
| `npm run check:modern-standards` | Check modern Web standards compatibility |
| `npm run check:error-code-alignment` | Check frontend/backend error-code alignment |
| `npm run check:security-consistency` | Check authentication-semantics consistency |

### AOT / SEO

| Command | Description |
| ------ | ------ |
| `npm run check:aot` | Check AOT contract compliance |
| `npm run check:public-seo-smoke` | Run the public-page SEO smoke test |
| `npm run check:public-hydration` | Run the public-page hydration smoke test |
| `npm run warm:public-aot` | Warm the public-page AOT cache |

Public AOT eligibility is generated from `src/shared/Contracts/Outputs/PublicPageContracts.cs`
into `src/frontend/src/public-renderers/generated/publicPageManifest.ts`; non-AOT route
policies such as Search / Account are recorded in
`tests/frontend/checks/public/public-hydration-matrix.registry.json`. Home, ArticleDetail,
Filter, Archive, About, Privacy, Guidelines, and Copyright may generate an anonymous Public
AOT shell. `/search` allows only SPA fallback because its unbounded query space would cause
cache explosion, stale search indexes, and hydration `routeKey` drift. `/user/profile` and
account/messages/auth-required routes remain runtime-only: they depend on user state and must
not write to the public AOT cache or emit `fsus-aot-hydration-props` or
`data-public-hydration-kind`.

### Layered tests

| Command | Description |
| ------ | ------ |
| `npm run test:fast` | Unit tests only; no external dependencies |
| `npm run test:integration` | Integration tests (Docker required) |
| `npm run test:ci` | fast + integration |
| `npm run test:acceptance` | Full Playwright E2E suite |
| `npm run test:visual` | Visual regression tests |
| `npm run test:production` | Full release gate |

See [testing.md](testing.md) for the complete tier rules.

---

## Visual Studio / Rider debugging

### Recommended launch profiles

| Profile | Scenario |
| -------- | ------ |
| `Debug / Client + Docker` | Production-like debugging (recommended) |
| `Debug / Client + NativeServer` | Frontend and locally launched C# backend for breakpoints |

`FsusBlog.slnLaunch` defines these launch profiles and references only real project paths from
`FsusBlog.slnx`. The backend-native profile is in `src/backend/Properties/launchSettings.json`;
the Compose profile is owned by `ops/docker/docker-compose.dcproj` and lives in
`ops/docker/Properties/launchSettings.json`. See [configuration layout](configuration-layout.md)
for ownership rules. The default F5 browser entry is `http://127.0.0.1:3000`.

### Debugging tips

- **Backend breakpoints**: use `Debug / NativeServer` and set breakpoints in C# code.
- **Binary decoding**: set `debugMode = true` in `wasmDecode.worker.ts` for detailed worker logs.
- **Notification stream**: visit `http://127.0.0.1:7568/api/notifications/stream` to inspect AEDS WebSocket events.
- **Cache**: L1 is in-process and clears on restart; clear L2 Redis with `redis-cli FLUSHDB`.

---

## Frequently asked questions

### `npm ci` fails: `403 Forbidden from GitHub Packages`

```bash
# Confirm that the token is set
echo $GITHUB_PACKAGES_TOKEN
# Set it again and retry
export GITHUB_PACKAGES_TOKEN=your_token
npm ci
```

### Backend startup fails: `Redis connection refused`

```bash
# Confirm that the Docker containers are running
docker compose -f ops/development/dependencies.compose.yml ps
# Restart Redis
docker compose -f ops/development/dependencies.compose.yml restart redis
```

### Wasm decoding fails

Runtime does not fall back to a text API. First check whether `wasm/` contains a `.wasm` file:

```bash
ls src/frontend/wasm/
# If it is empty, run:
cd src/frontend && npm run ensure:wasm
```

### Database migration did not run

The backend runs SqlSugar CodeFirst migration (`SchemaMigration`) on first startup. Restart
the backend process to trigger it manually.

---

## See also

- [development/coding-conventions.md](development/coding-conventions.md) — Cross-language coding conventions, naming map, and external-contract exceptions
- [testing.md](testing.md) — Complete test-tier strategy
- [wasm.md](wasm.md) — WebAssembly toolchain and build guide
- [production.md](production.md) — Production deployment configuration
- [development/demo-data.md](development/demo-data.md) — Local demo seed data
- [troubleshooting.md](troubleshooting.md) — Common development-environment failures
- [../README.md](../README.md) — Project overview and quickstart
