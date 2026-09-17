# Historical / Legacy Changelog

> This file contains only historical records from the legacy product version scheme. It does not represent the current `master` and must not be used to mint new release identities. See the repository-root [`CHANGELOG.md`](../../CHANGELOG.md) for current changes and canonical ReleaseId archival rules.

Legacy entries have no provable UTC + SHA mapping; keep them as-is and do not invent ReleaseId values.

---

## Legacy Unreleased Snapshot

### Added

- Anti-crawler loop: `CrawlerRiskService` centralizes Shield, RateLimiter, PoW, ReadProof, and public dynamic-read risk scores; `RiskAwarePublicReadFilter` dynamically requires PoW or returns 429 for high-risk public GET APIs.
- Crawler CIDR synchronization supports remote official JSON, a last-known-good snapshot, configuration fallback, and the admin-only `/api/ops/crawler-ranges/status` status endpoint.
- Structured audit system: `sys_audit_log` adds actor/action/target/outcome/severity, privacy hashes, context JSON, and tamper evidence; adds `IAuditEventService`, critical fallback JSONL, admin-only `/api/binary/author/audit/**` queries, and the `/user/manage/audit` management page.
- RUM telemetry uses a dedicated `frontend_rum_metric` table, anonymous ingestion has `fixed_ip` rate limiting, and the author dashboard aggregates performance metrics from the new table.

### Changed

- `ShieldMiddleware` classifies search crawlers, social-preview bots, unknown bots, and tool UAs; path attacks still hard-abort, while other denials return a lightweight 403 and record security metrics.
- RSS, Atom, JSON Feed, sitemap, and robots responses share CDN-friendly cache headers and ETags; `robots.txt` explicitly disallows `/api/`, search indexing, and private paths.
- Runtime legacy fallbacks are consolidated: upload-session cleanup relies only on the expiration bucket; subscription runtime uses only HMAC hashes; article bodies read only `article_body.markdown_content`; auth cookies no longer read the legacy plain fallback; the PublicAOT hydration sidecar accepts only content SHA-256; and `SchemaMigrationRunner` removes legacy ArticleDetail `.aeds` in one pass.

---

## [1.0.0] — 2026-04-27

### Added

#### Public content

- Article-list endpoint with pagination (`GET /api/Article/`)
- Article-detail endpoint (`GET /api/Article/{id}`)
- Popular-article endpoint (`GET /api/Article/hot`)
- Comment-thread endpoint with cursor pagination (`GET /api/Comment/{articleId}`, `/{articleId}/thread/{rootId}`)
- Category-list endpoint (`GET /api/Category/`)
- Tag-list endpoint (`GET /api/Tag/`)
- SEO-configuration endpoint (`GET /api/System/seo`)
- Static-page content endpoint (`GET /api/System/page/{slug}`)

#### Binary transport (AEDS v2)

- `api/binary` endpoint group; all public read paths support `application/octet-stream` output
- AEDS v2 protocol: 16-byte frame header plus CRC16 payload validation; v1 frames are no longer compatible
- C++23 Wasm decoder (freestanding, no STL heap allocation, CMake + Emscripten build)
- `AedsBinaryWriter` / `BinaryFrameResult` writes header plus payload in segments
- Decode failures expose protocol errors and do not fall back to the JSON read path
- Admin Binary statistics endpoint (`GET /api/binary/stats`, requires the admin role)
- Multipart upload endpoint group (`/api/binary/upload/*`, requires the admin role)

#### Authentication and security

- Proof of Work (PoW) precondition covering sensitive operations such as registration and login
- User registration (`POST /api/Auth/register`, with PoW verification)
- Password login (`POST /api/Auth/login`, including the MFA flow)
- JWT Access Token (15-minute expiry) plus an HttpOnly Refresh Token Cookie
- Token refresh (`POST /api/Auth/refresh-token`)
- Current-user information (`GET /api/Auth/me`)
- Secure logout (`POST /api/Auth/logout`, revokes the Refresh Token)
- Account deletion (`POST /api/Auth/delete-account`)
- BCrypt password hashing (cost factor 10+)

#### Passkeys (WebAuthn / FIDO2)

- FIDO2 Discoverable Credential with a usernameless flow
- Registration flow (`POST /api/binary/auth/passkey/register/begin` + `register/complete`, requires login, AEDS frame)
- Passwordless login flow (`POST /api/binary/auth/passkey/login/begin` + `login/complete`, anonymous, IP rate limited, AEDS frame)
- Credential list (`GET /api/binary/auth/passkey/credentials`, at most 5 per user)
- Credential deletion (`DELETE /api/binary/auth/passkey/credentials/{id}`)
- Credential rename (`PUT /api/binary/auth/passkey/credentials/{id}/name`)
- Registration MFA precondition (users with MFA enabled must provide a proofToken to register a new key)
- Passkey login counts as two-factor and skips the MFA challenge

#### Multi-factor authentication (MFA / TOTP)

- Start MFA setup (`POST /api/Auth/mfa/setup/start`)
- Verify MFA setup (`POST /api/Auth/mfa/setup/verify`)
- Personal MFA profile (`GET /api/Auth/mfa/profile`)
- Disable MFA (`POST /api/Auth/mfa/disable`)
- Regenerate recovery codes (`POST /api/Auth/mfa/recovery/regenerate`)
- Start the MFA login challenge (`POST /api/Auth/mfa/challenge/start`)
- Complete the MFA login challenge (`POST /api/Auth/mfa/challenge`)
- Admin reset of user MFA (`POST /api/Auth/admin/users/{id}/mfa/reset`, requires the admin role)

#### Multi-session management

- Active-session list (`GET /api/Auth/sessions`)
- Revoke one session (`POST /api/Auth/sessions/{id}/revoke`)
- Revoke all other sessions (`POST /api/Auth/sessions/revoke-others`)

#### Real-time notifications (AEDS WebSocket notification stream)

- AEDS WebSocket notification stream endpoint (`GET /api/notifications/stream`)
- Automatic disconnect protection for slow consumers
- SignalR + Redis backing store

#### In-app messages

- User conversation list (`GET /api/binary/messages/conversations`)
- User conversation detail (`GET /api/binary/messages/conversations/{id}`)
- Start a new conversation (`POST /api/binary/messages/conversations`)
- Reply to a conversation (`POST /api/binary/messages/conversations/{id}/reply`)
- Mark as read (`POST /api/binary/messages/conversations/{id}/read`)
- Admin conversation list (`GET /api/binary/admin/messages/conversations`)
- Admin conversation detail and reply
- Admin conversation status management (`POST /api/binary/admin/messages/conversations/{id}/status`)
- Per-user admin system message (`POST /api/binary/admin/messages/system-send`)

#### User comment history

- Current-user comment history (`GET /api/Comment/me`, requires login)
- Both JSON and Binary read paths (`GET /api/binary/comment/me`)

#### AOT public-page cache

- Prerendered HTML shell output, with static files preferred on cache hit
- Cache misses fall back to the SPA `index.html`, then client hydration takes over
- AOT cache volume mount (`fsus-aot-cache`)

#### Frontend (Vue 3 SPA)

- Public pages: home, archive, category, tag, and article detail
- Passkey login entry point (Login page)
- Passkey management panel (user-console Profile page)
- MFA setup and verification flow
- In-app messaging pages
- Admin console UI
- WebAssembly decoder engine (C++23, Web Worker isolates the main thread)
- Local search (Service Worker caches the static index plus Wasm local sorting)
- Responsive design with dark and light themes

#### Operations and observability

- Health checks: `GET /health/live` (liveness probe) and `GET /health/ready` (readiness probe)
- Serilog structured logging with asynchronous rolling files (volume mount `fsus-logs`)
- Layered test infrastructure (fast / integration / acceptance / visual / security / resilience / load / production)
- Production Docker multi-stage build (Wasm → .NET publish → Alpine runtime)
- Automatic CodeFirst database migrations

---
