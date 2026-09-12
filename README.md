# Fsu's Blog

FsusBlog is a personal content system for real deployments, centered on a binary public-read path and verifiable runtime contracts.

| Public preview entry | Link |
| ---------------------- | ------ |
| Architecture overview | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| API stability | [docs/api/stability.md](docs/api/stability.md) |
| Known limitations | [docs/known-limitations.md](docs/known-limitations.md) |
| Security policy | [docs/SECURITY.md](docs/SECURITY.md) |
| Security domain ownership | [docs/security/security-domain-layout.md](docs/security/security-domain-layout.md) |
| Support routing | [docs/SUPPORT.md](docs/SUPPORT.md) |
| Contributing guide | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) |
| Repository governance | [docs/repository-governance.md](docs/repository-governance.md) |
| Code of conduct | [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) |
| License | [Apache-2.0](LICENSE) |
| Open source readiness | [docs/open-source-readiness.md](docs/open-source-readiness.md) |

## Features

| Feature | Description |
| ------ | ------ |
| Public content pages | Home, archive, category, tag, and article-detail pages use AOT pre-rendering plus SPA hydration for first paint. |
| Binary transport | AEDS v2 binary frames with C++23 Wasm and TypeScript decoders; pooled hot-path writes avoid a second complete frame and never fall back to the legacy text API. |
| Local search | A Service Worker caches a static index and browser Wasm sorts it; there is no online server search. |
| Authentication and authorization | PoW precheck, registration/login, AEDS auth frames, and an HttpOnly Cookie session. |
| Passkeys | WebAuthn / FIDO2 Discoverable Credentials for passwordless login, up to 5 per user. |
| Multi-factor authentication (MFA) | TOTP RFC 6238, independent recovery codes, and administrator reset. |
| Multi-session management | View active sessions and revoke one or all other sessions. |
| Real-time notifications | WebSocket binary notification stream (`/api/notifications/stream`, subprotocol `fsus-aeds.v2`). |
| In-site messaging | User conversations, administrator broadcasts, and conversation state management. |
| Admin console | User management, content moderation, and site statistics through the Binary read path. |
| Layered testing | A `tests/matrix.yml`-driven DAG covering fast / coverage-gate / runtime / visual / security / resilience / load / backend-qps / production / release-final. |

## Project position

FsusBlog is constrained by `SEO first-visit speed + runtime consistency + engineering maintainability`:

- **Public pages first**: prioritize first paint and indexability for home, archive, category, tag, and article-detail pages.
- **Unified contracts**: preserve one meaning for each business object across AEDS Binary, Public AOT, and required JSON operations/proof endpoints.
- **Monolith first**: reduce cross-service hops and keep complexity in the codebase rather than the deployment topology.
- **Security first**: build PoW, JWT, multi-session, MFA, Passkey, risk control, logout, and cache governance as infrastructure capabilities.
- **Frontend performance first**: browser-local search, Service Worker edge caching, and Wasm rendering/decoding are on the production path.

## Screenshots

![FsusBlog public preview home](docs/assets/screenshots/public-home-light.png)

More sanitized public-preview screenshots are in [docs/assets/screenshots/](docs/assets/screenshots/). They use fictional demo content and contain no real production domains, email addresses, IPs, logs, tokens, or private identifiers. See [docs/known-limitations.md](docs/known-limitations.md) for current limitations.

## Architecture overview

### Technology stack

#### Backend

| Technology | Version | Purpose |
| ------ | ------ | ------ |
| .NET SDK / C# | 10 / 14 | Runtime and language versions |
| ASP.NET Core Kestrel | 10 | HTTP server |
| SqlSugar | 5.1.4.214 | PostgreSQL ORM, CodeFirst |
| Redis | — | L2 cache and WebSocket notification backlog |
| Fido2 | 4.0.1 | WebAuthn / Passkey |
| BCrypt.Net-Next | 4.1.0 | Password hashing |
| Serilog | 4.3.1 | Structured logs with asynchronous rolling files |

#### Frontend

| Technology | Version | Purpose |
| ------ | ------ | ------ |
| Vue | 3.5.x | Progressive framework |
| Vite | 8.x | Build tool and HMR |
| TypeScript | 6.x | Static typing |
| Pinia | 3.0.x | State management and persistence |
| Vue Router | 4.6.x | Client-side routing |
| Tailwind CSS | 4.2.x | Atomic styling |
| @simplewebauthn/browser | 13.3.0 | Passkey browser API |
| FsusUI | GitHub Packages | Project component library |
| Playwright | 1.59.x | E2E testing |

#### WebAssembly / C++

- C++23 (Freestanding, no STL heap allocation)
- Emscripten SDK, CMake + Ninja
- AEDS v2 decoding, CRC validation, and Markdown rendering

### Current main path

- The runtime main API is `/api/binary/**` Binary/POD (`application/octet-stream`, AEDS v2 frames); public reads, admin writes, authentication, MFA, and Passkey use this path.
- The author workbench `/api/author/**`, human-read proof, health checks, and a small set of operations endpoints remain JSON; legacy text `/api/**` business endpoints are not client fallbacks.
- Search no longer depends on online server retrieval; the client loads a static index and sorts locally.
- Public first visits try an AOT hit; a miss returns to the SPA index, which hydration then takes over.

### Repository layout

```text
FsusBlog/
├── src/frontend/                         # Vue 3 SPA, Wasm, Service Worker, public-page hydration
├── src/backend/          # ASP.NET Core 10 API, AOT, notification stream, cache, security
├── src/shared/          # Shared frontend/backend contracts and binary protocol models
├── src/core/            # Mapping, POD codecs, and shared projection logic
├── src/zk/circuits/     # Hand-written ZK circuit domain source (generated output remains in artifacts/zk)
├── security/             # Matrices, policies, ZK contracts, provenance, and static evidence contracts
├── tests/backend/   # xUnit unit and integration tests
├── benchmarks/core/ # BenchmarkDotNet performance benchmarks
├── docs/                     # In-depth documentation
│   ├── architecture.md       # System architecture and cache layers
│   ├── api.md                # API endpoint quick reference
│   ├── security.md           # Security model (PoW / JWT / MFA / Passkey)
│   ├── production.md         # Production deployment and environment variables
│   ├── operations.md         # Operations runbook (release gates, rollback, backup)
│   ├── development.md        # Local development guide
│   ├── testing.md            # Layered test strategy
│   ├── wasm.md               # WebAssembly development guide
│   ├── moderation/           # Moderation-provider contracts and third-party guide
│   └── api/                  # Detailed API documentation
│       ├── design.md         # API design philosophy and conventions
│       ├── contracts.md      # Complete request/response contracts
│       ├── quick-reference.md # Route quick reference
│       └── schemas-and-errors.md # Error codes and binary structures
├── ops/                      # Sole top-level root for operations templates
│   ├── docker/               # Production orchestration and backend-container debug overlay
│   ├── development/          # Local PostgreSQL / Redis dependencies
│   ├── gateway/              # OpenResty / Nginx gateway templates
│   └── privacy/              # Privacy operations templates
├── config/deployment/        # Deployment policy configuration (not executable scripts)
└── tools/                    # Build, test, and executable deployment/operations scripts
```

## Local development

For the complete setup, Passkey, configuration, and troubleshooting guide, see [docs/development.md](docs/development.md). This section keeps the public-preview quickstart and the commands most contributors need.

### Requirements

- .NET SDK 10
- Node.js 20+ and npm 10+
- Docker + Docker Compose (for PostgreSQL, Redis, and backend containers)
- Emscripten SDK (optional; required only to rebuild Wasm locally)
- `GITHUB_PACKAGES_TOKEN` environment variable (to install the private FsusUI component library)

### Public Preview Quickstart

```bash
git clone https://github.com/Ozwasyd/FsusBlog.git
cd FsusBlog
cp config/examples/.env.example .env
./tools/dev/start.sh --fixture-profile demo-public
```

The default `./tools/dev/start.sh` (profile `none`) starts only PostgreSQL, Redis, the ASP.NET Core backend, and the Vite frontend; it does not write business/auth/session fixtures. For deterministic fictional demo data, explicitly select catalog ID `demo-public`.

| Component | URL / notes |
| ------ | ------------- |
| Frontend | `http://127.0.0.1:3000` |
| Backend | `http://127.0.0.1:7568` |
| Demo seed identities | `demo-reader` is an anonymous account container; `demo-admin` is a disabled mock independent admin principal used only for admin-attribution smoke flows |
| Local Passkey login | Use the Passkey injection flow in [docs/development.md](docs/development.md#local-passkey-injection) |
| Demo data | [docs/development/demo-data.md](docs/development/demo-data.md) |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Known limitations | [docs/known-limitations.md](docs/known-limitations.md) |
| Example config | `config/examples/.env.example`, `config/examples/.env.production.example`, `src/backend/appsettings.Development.example.json` |
| Configuration ownership | [docs/configuration-layout.md](docs/configuration-layout.md) |
| Appsettings/operator authority | [docs/configuration/appsettings-authority.md](docs/configuration/appsettings-authority.md) |
| Operations layout | [docs/operations-layout.md](docs/operations-layout.md) |

For configuration authority, overlays, and secret handling, use [docs/configuration/appsettings-authority.md](docs/configuration/appsettings-authority.md) and the full [development guide](docs/development.md). The precedence remains `src/backend/appsettings.json` < environment overlay (Production uses the tracked `appsettings.Production.json`) < `.env.production`/Compose environment variables < command-line override. The repository does not provide a copyable full appsettings example or store real secrets in examples.

Stop the frontend and backend with `Ctrl+C`; clean the local development database and Redis volume with:

```bash
./tools/dev/start.sh --cleanup
```

### FsusUI dependency

The client component library is distributed through GitHub Packages. Set:

```bash
export GITHUB_PACKAGES_TOKEN=your_github_packages_token
```

The client `.npmrc` is fixed to:

- `@ozwasyd:registry=https://npm.pkg.github.com`
- `//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}`

### Manual startup

If the one-command entry point is unavailable, run the pieces separately:

```bash
docker compose -f ops/development/dependencies.compose.yml up -d postgres redis
dotnet run --project src/backend/FsusBlog.Server.csproj --urls http://127.0.0.1:7568
```

In another terminal, start the frontend:

```bash
npm --prefix src/frontend ci
npm --prefix src/frontend run dev:debug
```

`dev:debug` serves `/src` resources directly through Vite for frontend styles and local FsusUI HMR. To validate the backend public-shell SSR proxy, use `npm --prefix src/frontend run dev:ssr`, which sets `VITE_PUBLIC_SHELL_PROXY=1`.

#### Common URLs

| URL | Purpose |
| ------ | ------ |
| `http://127.0.0.1:3000` | Vite frontend development shell (HMR) |
| `http://127.0.0.1:7568` | ASP.NET Core API + public pages (Debug) |
| `http://127.0.0.1:8080` | Release Preview (production-build test) |

### Visual Studio debugging

- Default launch profile: `Debug / Client + Docker` (closest to production)
- Secondary launch profile: `Debug / Client + NativeServer` (C#-only iteration without frontend rebuild)
- The default `F5` browser entry is `http://127.0.0.1:3000`

### Release-build switch

Release publish normally checks `src/frontend/node_modules`, runs `npm run build:release`, and copies `src/frontend/dist` and frontend runtime files into the backend publish output. For a backend-only diagnostic or temporary publish, pass:

```bash
dotnet publish src/backend/FsusBlog.Server.csproj -c Release /p:PublishClientAssets=false
```

This switch does not change production defaults; it only temporarily decouples the backend publish path from Node/npm/GitHub Packages.

## Testing

Tests run through `./tools/test.sh <tier>` according to the DAG in `tests/matrix.yml`; see the committed snapshot in [docs/testing.generated.md](docs/testing.generated.md).

| Tier | Purpose | Dependencies |
| ------ | ------ | ------ |
| `fast` | Frontend/backend quick checks, static governance, and unit-test aggregate | None |
| `coverage-gate` | Backend/frontend coverage merge and thresholds; an independent required check alongside production | None |
| `integration` | Server integration tests | Docker, 3000/7568 |
| `ci` | fast + integration | Same as above |
| `release` | Public-page hydration / AOT / SEO | 8080 |
| `acceptance` | Full Playwright E2E suite | All ports |
| `visual` | Dark mode, mobile, and screenshot baselines | All ports |
| `security` | Authentication/MFA/PoW/authorization/Passkey gates | All ports |
| `resilience` | Upload, search, and WebSocket-notification resilience | All ports |
| `load` | Light concurrency load test | All ports |
| `production` | production-ci-gate: full PR/CI gate; release evidence may be schema-valid `collected-blocked` | Docker, all ports |
| `release-closeout` | release-closeout-gate: requires the existing manifest to pass `--require-ok`, for final release closeout only | Release evidence |
| `release-final` | Final publish credential: strict coverage, changed-code coverage, complete shard/browser summary, live exposure, no visual skip, artifact-digest binding, and test-quality lint | Complete release evidence |

Run the fast unit tests alone:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "Category!=Integration" -v minimal
```

See [tests/backend/TESTING.md](tests/backend/TESTING.md) for detailed rules.

`production` is the production-ci-gate. It requires zero compiler warnings, type errors, Vite build warnings, test failures, and runtime errors/warnings; it covers anonymous, logged-in, and admin paths, Binary API, author workbench/read-proof/health JSON, the WebSocket binary notification stream, AOT hydration, PoW/MFA/Passkey/session, visual, resilience, light-load, and backend-qps hot-path evidence. It validates release-evidence schema and semantics but allows `collected-blocked` when external production evidence has not returned or placeholder evidence is still `scheduled`; `release-closeout` requires `collected-ok`. A final release candidate must also run `./tools/test.sh release-final`, which additionally blocks visual skips, dry-run backup/smoke, unexecuted DAST/fuzz/fault/soak, missing live exposure, missing shard/browser summaries, insufficient coverage or changed-code coverage, critical flaky quarantine, and artifact-digest mismatch. GitHub Actions `Quality Gate` runs production-ci-gate on PRs, `main` / `master` pushes, and manual dispatch; the repository secret `GITHUB_PACKAGES_TOKEN` must be configured.

`src/frontend/` is the JavaScript/Vue project root and does not accept a C# application entrypoint. Both `frontend-static-governance` and `static-governance` run `node tools/check-csharp-entrypoint-ownership.mjs` and report all missing project/file-app owners, fixed global temporary outputs, or protocol-fixture owner problems in one pass. See the decision and extension contract in [docs/testing/issue-1174-csharp-entrypoint-ownership.md](docs/testing/issue-1174-csharp-entrypoint-ownership.md).

## Documentation index

| Document | Description |
| ------ | ------ |
| [docs/architecture.md](docs/architecture.md) | System architecture, cache layers, dual read paths, and security path overview |
| [docs/architecture/overview.md](docs/architecture/overview.md) | Short architecture and runtime baseline for external contributors; AEDS / HotRead / AOT positioning |
| [docs/api.md](docs/api.md) | API endpoint quick reference (routes / authentication / rate limits) |
| [docs/api/stability.md](docs/api/stability.md) | Explicit stability classes, experimental internal contracts, and standard-protocol boundaries |
| [docs/api/design.md](docs/api/design.md) | API design philosophy, response-format conventions, and dual-path decisions |
| [docs/api/contracts.md](docs/api/contracts.md) | Complete request/response DTO, notification WebSocket, and AOT contracts |
| [docs/api/quick-reference.md](docs/api/quick-reference.md) | All endpoint routes, including authentication, rate limits, and Binary counterparts |
| [docs/api/schemas-and-errors.md](docs/api/schemas-and-errors.md) | Error-code enums, AEDS v2 frame format, and POD-size catalog |
| [docs/security.md](docs/security.md) | Security model: PoW, JWT, MFA, Passkey, RBAC, and CORS |
| [docs/production.md](docs/production.md) | Production deployment, environment variables, and health checks |
| [docs/operations.md](docs/operations.md) | Operations runbook: release gates, rollback, backup, and incident response |
| [docs/development.md](docs/development.md) | Local development setup and common scripts |
| [docs/development/coding-conventions.md](docs/development/coding-conventions.md) | Cross-language mapping from the C# authority, priority, external contracts, and generated/vendor/fixture exceptions |
| [docs/configuration/appsettings-authority.md](docs/configuration/appsettings-authority.md) | Appsettings base/overlay, minimal development example, production operator input, and precedence |
| [docs/development/demo-data.md](docs/development/demo-data.md) | Deterministic fictional demo seed data, default local identities, and reset method |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common SDK, Node/npm, PostgreSQL, Redis, port, AEDS/Wasm, WebAuthn, cookie, migration, and AOT failures |
| [docs/testing.md](docs/testing.md) | Test DAG, production-ci-gate, release-closeout-gate, and coverage scenarios |
| [docs/wasm.md](docs/wasm.md) | WebAssembly toolchain, build, and C++/TS interface boundary |
| [docs/moderation/third-party-model-development.md](docs/moderation/third-party-model-development.md) | Third-party moderation-provider contract, schema, CLI/HTTP integration, and conformance tests |
| [tests/backend/TESTING.md](tests/backend/TESTING.md) | Test-tier rules and cleanliness conventions |
| [src/core/Algorithms/AEDS_V2_PROTOCOL.md](src/core/Algorithms/AEDS_V2_PROTOCOL.md) | AEDS binary-frame specification (runtime accepts v2 only) |
| [ROADMAP.md](ROADMAP.md) | Public Preview, localization and public UX, distributed runtime, and extension-ecosystem stages |
| [docs/known-limitations.md](docs/known-limitations.md) | Public-preview limitations, supported experiments, and internal contracts not to depend on |
| [docs/assets/screenshots/](docs/assets/screenshots/) | Sanitized public-preview screenshots and screenshot safety/branding notes |
| [docs/releases/public-preview-policy.md](docs/releases/public-preview-policy.md) | Current Public Preview policy, capability range, limitations, and contract boundaries |
| [CHANGELOG.md](CHANGELOG.md) | Current change aggregation and canonical ReleaseId archive format |
| [docs/open-source-readiness.md](docs/open-source-readiness.md) | Open-source preview license, conduct, security configuration, secret/history scan, dependency-license audit, and supply-chain evidence entry points |
| [docs/repository-labels.md](docs/repository-labels.md) | GitHub issue/PR label taxonomy, path labeler, and issue-triage strategy |
| [docs/repository-governance.md](docs/repository-governance.md) | Default-branch protection, required checks, CodeQL / Scorecard posture checks, and GitHub Actions permissions |
| [docs/architecture/repository-layout.md](docs/architecture/repository-layout.md) | Canonical ownership for product source, ZK artifacts, security manifests, runtime config, and test fixtures |
| [docs/testing/issue-1174-csharp-entrypoint-ownership.md](docs/testing/issue-1174-csharp-entrypoint-ownership.md) | Ownership contract for C# entrypoints, file-based apps, and the AEDS protocol fixture generator |
| [docs/SUPPORT.md](docs/SUPPORT.md) | Usage, deployment, and self-hosting support routing; sensitive information prohibited in public issues |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Contribution flow, Issue/PR templates, test evidence, and public-preview stability boundaries |
| [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) | Community conduct and enforcement path |
| [docs/SECURITY.md](docs/SECURITY.md) | Private vulnerability-reporting entry point, scope, and public-issue prohibitions |
| [LICENSE](LICENSE) | Apache-2.0 repository code license |

## Public Preview boundary

FsusBlog code is released under Apache-2.0. Contribution flow, security reporting, conduct, known limitations, roadmap, and current preview policy are listed above and in the documentation index. Public Preview provides no production SLA and does not promise stability for third-party clients or internal AEDS, admin, or database contracts by default.

The historical open-source-readiness snapshot is in `docs/reports/open-source-readiness/v1.1.0-public-preview/`. Its product version is a legacy product-version label retained as provenance for that audit window; it does not represent the current `master` or act as a fresh release credential. Current evidence classes, release-identity binding, and immutable-storage rules are in `docs/release-evidence-model.md`. Public screenshots and demo seed data use fictional content; the repository contains no real production domains, email addresses, IPs, logs, tokens, private identifiers, standalone trademark artwork, or production brand assets.
