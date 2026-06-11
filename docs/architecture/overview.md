# FsusBlog Architecture Overview

FsusBlog is a high-performance personal content system built around fast public reading, consistent runtime contracts, and a single-process deployment baseline. It is not a generic CRUD blog template: the public read path, binary API contracts, AOT rendering, cache strategy, moderation, and anti-crawler controls are all first-class architecture concerns.

## Current Status

FsusBlog v1.1.0 is a public preview. It is suitable for development, evaluation, code review, and personal self-hosting experiments. It should not be treated as stable production software, and internal APIs, deployment contracts, data models, admin workflows, and performance profiles may change before v1.2.0.

## Repository Layout

| Area | Purpose |
|------|---------|
| `src/backend/` | ASP.NET Core / Kestrel application, Binary API endpoints, Public AOT, cache, security, moderation, notification stream, admin operations |
| `src/frontend/` | Vue SPA, public hydration, admin UI, AEDS client adapters, Web Workers, Wasm integration, service worker |
| `src/shared/` | DTOs, POD contracts, AEDS metadata, shared validation rules, OpenAPI artifacts |
| `src/core/` | POD binary codecs, shared projection logic, cache key helpers, algorithm-level contracts |
| `docs/` | Public and internal architecture, API, security, operations, testing, and development documentation |
| `tests/` | Backend, frontend, contract, static governance, visual, security, and release gate tests |

The application is modular inside one repository and one default process. Future distributed work is tracked for v1.3.0, but it is not a blocker for v1.1.0 public preview.

## Runtime Baseline

The internal project baseline is:

```text
Kestrel-only
single process
PostgreSQL + Redis dependencies
no required nginx / CDN / service mesh
```

Reverse proxies, CDNs, WAFs, and deployment-layer acceleration are allowed in real deployments, but they are optional. A reverse proxy or CDN must not be counted as the internal FsusBlog performance baseline unless the benchmark explicitly says so.

## AEDS Binary Protocol

AEDS is the internal binary frame protocol used by the main runtime API. The client receives typed frames and decodes them through TypeScript and C++23/Wasm paths. This keeps hot public and admin routes on a compact binary contract and avoids maintaining old text API fallbacks for the core application surface.

During v1.1.x, internal AEDS frame contracts are experimental unless explicitly documented as stable. See [API stability](../api/stability.md).

## Public HotRead

Public HotRead is the optimized read path for hot public content. It exists to serve common public article/list reads without forcing every request through the full dynamic application path. HotRead artifacts must preserve the same semantic contract as runtime public data while using cache-friendly representations.

## Public AOT

Public AOT pre-renders public pages so first visits can receive indexable HTML before SPA hydration. If an AOT artifact is missing, the request can fall back to the SPA shell and hydrate on the client. AOT output is a public reading optimization, not a separate content model.

## Cache Layers

FsusBlog uses layered cache behavior:

| Layer | Role |
|-------|------|
| In-process cache | Fast local reuse for hot computed data and policy snapshots |
| Redis / distributed cache | Shared cache, notification backlog, rate-limit and PoW state |
| Public HotRead artifacts | Optimized public binary/read artifacts |
| Public AOT shell cache | Pre-rendered public HTML artifacts |
| Browser and service worker cache | Public shell and static index reuse where privacy boundaries allow it |

Cache invalidation is part of the application contract. Article, taxonomy, public shell, and admin-side mutations must invalidate the matching public and internal caches instead of relying on stale TTL behavior alone.

## Security, Moderation, And Anti-Crawler

Security is built as infrastructure, not only endpoint code:

- PoW and rate limits protect high-risk anonymous and auth flows.
- MFA, Passkey, session isolation, HttpOnly cookies, and RBAC protect identity and admin workflows.
- Anti-crawler controls classify verified crawlers, social preview bots, unknown bots, and risky public reads.
- Moderation combines content filtering, region policy, model-provider integration, audit evidence, and admin review workflows.
- Public telemetry and read proof avoid collecting account, token, cookie, raw IP, or private content payloads.

Security changes should be checked against [docs/security.md](../security.md).

## FsusUI Boundary

FsusUI supplies the visual system and reusable UI foundation. FsusBlog owns application semantics: API behavior, data contracts, admin workflows, public content model, security decisions, and domain-specific UX. Reusing FsusUI components must not move FsusBlog business rules into the UI library.

## Standard Protocol Exemptions

Not every public output is an internal AEDS API. The following are standard external protocols or operational outputs and are documented separately from internal binary contracts:

- RSS
- Atom
- JSON Feed
- Sitemap
- `robots.txt`
- health probes

These outputs should remain standards-compatible even while undocumented internal APIs and AEDS frames remain experimental.

## What Is Stable Today

The stable project direction is single-process FsusBlog with Kestrel, PostgreSQL, Redis, public AOT/HotRead, AEDS runtime API, moderation, security, and admin console baselines.

The exact internal API shape, AEDS frame layout, database schema, admin routes, deployment configuration, and third-party client compatibility are not stable in v1.1.x.
