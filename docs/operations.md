# FsusBlog Operations Runbook

## Release Gate

Before publishing a production image:

```bash
./tools/test.sh production
```

`production` is the production-ci-gate: it runs fast validation first, starts the full local stack once, then reuses that stack for integration, release, acceptance, visual, security, resilience, load, frontend render-pressure, and release evidence schema checks. A passing production-ci-gate means no compile warnings, no TypeScript/Vite warnings, no runtime console errors or warnings, no API/Binary/WebSocket/AOT contract drift, and no blocker security or workflow regressions in the encoded risk matrix. It may still produce a schema-valid `collected-blocked` release evidence manifest while external production evidence is pending.

`release-closeout-gate` is separate and must run `tools/operations/check-release-evidence-manifest.mjs --require-ok` or `./tools/test.sh release-closeout`. Only `collected-ok` is a release credential.

The same gate is enforced by GitHub Actions `Quality Gate` on pull requests, pushes to `main` / `master`, and manual dispatch. CI requires `GITHUB_PACKAGES_TOKEN` for the private `@ozwasyd` npm package. Playwright worker counts come from the `tests/matrix.yml` tier policy; local runs should keep that policy unless a lane has separate stability evidence for higher parallelism.

## Coverage Gate

Coverage is enforced as a separate hard gate:

```bash
./tools/test.sh coverage-gate
```

This gate collects backend + frontend coverage, merges reports, and enforces both merged and backend-only thresholds. Frontend collection defaults its local Vitest thresholds to `0` so the artifact step cannot fail on files outside the curated gate denominator; the hard threshold is applied after merge. Current defaults are merged line/branch/method `35%/20%/30%` and backend line/branch/method `75%/55%/95%` for the scoped coverage set (overridable via `FSUSBLOG_COVERAGE_*` env vars).

If VSCode integrated terminal picks an older Node than expected, run:

```bash
bash ./tools/node/check-node24-env.sh 20
bash ./tools/node/fix-vscode-node24.sh 24
```

Then restart VSCode and rerun the gate.

On failure, collect:

- `.tmp/acceptance/*.log`
- `src/frontend/test-results/playwright/`
- GitHub Actions `quality-gate-artifacts`

For Docker packaging:

```bash
export GITHUB_PACKAGES_TOKEN=...
./tools/build-final-image.sh
docker compose --env-file .env.production config
```

## Rollout

1. Build and tag the new image.
2. Start the container with `docker compose --env-file .env.production up -d`.
3. Wait for `/health/live` to pass.
4. Check `/health/ready`.
5. Switch or keep gateway traffic only after readiness is `ready`.

Rollback is image based:

```bash
docker compose --env-file .env.production down
FSUSBLOG_FINAL_IMAGE_TAG=previous-tag docker compose --env-file .env.production up -d
```

If a release specifically needs public AOT disk cache invalidation, set `Lifecycle:ClearAotDiskCacheOnStartup=true` for that rollout only. The default is `false`; rollback is to remove the setting and restart on the previous or current image without the one-shot cleanup. If a later startup task fails after the clear, the host now performs a best-effort restore of the previous `wwwroot/aot-cache` contents before surfacing the bootstrap failure. The same startup rollback pipeline now also restores the previous `wwwroot/search` artifacts, or removes newly created search output, if a later task fails after a search index rebuild. Startup cache prewarm records the prior blacklist cache state for each touched user and restores that cache state if a later bootstrap task fails. Schema migrations are reported as `non_compensable`; database rollback remains an operator-owned backup/restore action instead of an automatic in-process rollback.

## Daily Checks

- `docker ps` health status is healthy.
- `/health/ready` returns public minimal readiness JSON with `status=ready` and `checkedAt`.
- `/api/ops/health/ready-detail` runtime startup snapshot shows expected `schemaMigration` / `searchIndex` / `cacheInitializer` / `aotDiskCache` / `bootstrapRollback` task states for the current rollout. The snapshot is sourced from `StartupRuntimeState.CreateSnapshot()` and is independent from PublicAOT/AEDS payloads. `schemaMigration` should report `non_compensable`; `cacheInitializer` reports either `no_entries` or the number of rollback entries it can restore. The same runtime block exposes `scheduledPublish` with `lastPublishedCount`, `lastFailedCount`, `dueBacklog` and `lastError`; non-zero failures mean due scheduled articles remain queued for the next worker tick and should be investigated before release closeout.
- `/api/ops/health/ready-detail` includes `observability` with service name/version, ActivitySource, Meter and whether OTLP export is enabled.
- Disk usage for Docker volumes and container logs is below alert thresholds.
- PostgreSQL connection usage leaves headroom for migrations and backups.
- Redis memory and eviction policy are within expected bounds.
- WebSocket binary notification stream connection count matches expected traffic and does not grow without release.

## Observability

OpenTelemetry is enabled in-process by default and uses `FsusBlog.Server` as the custom `ActivitySource` / `Meter`. ASP.NET Core, outgoing HTTP, runtime, Npgsql, WebSocket notification metrics, cache operations, PublicAOT render source, search rebuild/query and scheduled-publish worker timings are recorded with bounded `fsus.*` tags only.

OTLP export is off by default. Enable it by setting either `Observability:ExporterEnabled=true` with `Observability:OtlpEndpoint=http://collector:4317`, or the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable. Requests return `X-Fsus-Trace-Id`, and Serilog/audit request context uses the same trace identifier for log correlation. Do not add raw route parameters, request/response bodies, cookies, tokens, IP addresses, usernames or email addresses as OpenTelemetry attributes.

## SLO Alerts

Production SLO definitions are machine-readable in `config/slo.yml`; `tools/operations/check-slo-definition.mjs` verifies availability, error-rate, p95/p99 latency, WebSocket reconnect success, AOT hit rate, search rebuild success and scheduled publish delay objectives before the release gate proceeds.

The release SLO fixture is executable:

```bash
tools/operations/check-slo-alert-fixture.mjs
```

It writes `.tmp/operations/slo-alert-fixture.json`. With no argument it uses an embedded synthetic incident and asserts that every required alert can fire. A production or CI fixture can be passed as the first argument; it should include `/api/ops/health/ready-detail` JSON, `notificationStream.slowDisconnectsLast5m`, security status report data and optional thresholds.

| Alert | Impact | Investigation entry | Rollback or degradation action |
|-------|--------|---------------------|--------------------------------|
| `ready_degraded` | Candidate traffic switch and release closeout are blocked. | `/health/ready` status, `/api/ops/health/ready-detail`, runtime startup tasks, scheduled publish snapshot, app logs. | Keep traffic away from the candidate image or switch back to the previous image tag. |
| `db_latency_high` | Cache misses, authoring writes, reads and migrations can stall behind PostgreSQL pressure. | `/api/ops/health/ready-detail` `checks.postgres.latencyMs`, DB concurrency gate snapshot, slow SQL logs, PostgreSQL connection usage. | Reduce public traffic, pause non-essential writes/background work, then rollback if latency started with the deploy. |
| `redis_latency_high` | L2 cache, WebSocket notification backlog replay and cache-control fanout can become slow or stale. | `/api/ops/health/ready-detail` `checks.redis.latencyMs`, Redis memory/eviction policy, network path and command latency. | Keep the app out of new traffic until Redis recovers; allow public fallback only after readiness is healthy. |
| `aot_backfill_failed` | Public pages may fall back from server AOT shells to SPA rendering and lose first-load performance. | `runtime.startup.tasks.aotDiskCache`, PublicAOT worker logs, AOT cache directory permissions, `aotBackfill.failuresLastHour` if exported by the collector. | Disable one-shot AOT cache cleanup, keep SPA fallback enabled, and rerun backfill after fixing renderer or filesystem failures. |
| `search_rebuild_failed` | Search results and distribution version coherence can be stale after article mutations or deployment. | `runtime.startup.tasks.searchIndex`, `search.rebuildFailuresLastHour`, search artifact directory and `SearchIndexService` logs. | Restore previous search artifacts or previous image, keep public reads online, and rebuild the index before closeout. |
| `notification_stream_disconnect_spike` | Notification streams can miss live updates and increase replay pressure for authenticated/admin clients. | `fsus.notification_stream.slow_disconnects`, `/api/ops/health/ready-detail` `runtime.notificationStreamConnections`, gateway websocket buffering and slow consumer logs. | Lower gateway traffic or reconnect pressure, preserve polling/fetch fallbacks, and revert gateway changes that introduced buffering. |
| `cache_registry_missing_scan` | Cache prefix invalidation has fallen back to Redis keyspace scan because registry membership is missing or stale. | `fsus.cache.operation.count` with `registry_missing_scan_recovered` / `registry_missing_scan_empty` / `registry_missing_scan_failed`, Redis `cache:registry:*` sets, `RemoveByPrefixAsync` warnings, cache governance catalog. | Treat repeated fallback as degraded cache-control behavior; rebuild registry through normal writes or clear the affected family during low traffic. Failed scans require Redis connectivity and ACL investigation before promotion. |
| `security_blocker` | Production release is blocked by DAST, attack matrix, permission matrix or exposure evidence failures. | `.tmp/security/zap`, attack/permission matrix output, `.tmp/security/production-exposure-status.json` blockers. | Do not promote; keep the previous image and gateway config until every security blocker has passing evidence. |

## Backups

Use the site package script as the normal single-author backup entrypoint:

```bash
tools/operations/backup-site.sh
```

The package includes PostgreSQL (`database.dump`), uploads, DataProtection keyring, redacted config, AOT cache and search artifacts. Set `FSUSBLOG_BACKUP_ROOT` to the production backup volume. The script accepts `FSUSBLOG_POSTGRES_URL`, `DATABASE_URL`, or `ConnectionStrings__DefaultConnection`, and redacts config keys matching secret/password/token/key/connection/string before packaging. Redis is a cache/control-plane dependency; restore uses a fresh empty Redis unless infrastructure policy provides a separate Redis persistence layer.

Restore is explicit and non-destructive unless `--confirm` is supplied:

```bash
tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz --dry-run
tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz --confirm
```

The restore script restores PostgreSQL, uploads, DataProtection keyring, AOT cache and search artifacts, then writes a JSON report. Sanitized config is extracted for operator review; secrets must be supplied from the target environment, not from the package.

Run a repeatable backup/restore rehearsal before treating the production closeout gate as complete:

```bash
tools/operations/backup-restore-drill.sh
```

By default the script runs in dry-run mode and writes `.tmp/operations/backup-restore-drill.json` with `status=scheduled`. That is useful for runbook rehearsal and exits successfully, but it is never a release closeout credential. A real drill must provide PostgreSQL, Redis, upload, AOT cache and search index backup paths, restore them into an isolated PostgreSQL/Redis/backend stack, then smoke anonymous public pages, admin login, Binary API, search and WebSocket notifications before recording RPO/RTO:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_POSTGRES_BACKUP=backups/fsusblog-postgres.sql \
FSUSBLOG_REDIS_BACKUP=backups/fsusblog-redis.rdb \
FSUSBLOG_UPLOADS_BACKUP=backups/fsus-uploads.tar.gz \
FSUSBLOG_AOT_BACKUP=backups/fsus-aot-cache.tar.gz \
FSUSBLOG_SEARCH_BACKUP=backups/fsus-search.tar.gz \
  tools/operations/backup-restore-drill.sh
```

The real mode starts disposable restore containers, copies upload/AOT/search artifacts into an isolated webroot, starts a restored backend on `FSUSBLOG_DRILL_BACKEND_PORT` (default `5180`), verifies `/`, admin login, `/api/binary/article/list/home/1/5.aeds`, `/search/index.manifest.aeds` and WebSocket notification heartbeat, then removes the temporary stack unless `FSUSBLOG_DRILL_KEEP_WORK=1` is set. Release evidence requires `status=ok`, `mode=real`, concrete RPO/RTO values, and all restore/smoke checks above; a dry-run or partial drill keeps the manifest blocked.

When the source is a site package generated by `backup-site.sh`, pass it directly; the drill unpacks database/uploads/AOT/search and starts Redis with an empty data directory:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_SITE_BACKUP_PACKAGE=backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz \
  tools/operations/backup-restore-drill.sh
```

The admin UI surfaces backup and drill status in `/user/manage/ops`; cache/AOT/search/sitemap status and manual rebuild controls live in `/user/manage/cache`; data drift checks, diff preview and safe fix application live in `/user/manage/integrity`.

Authoring-level content export is a lighter recovery path for editorial mistakes, not a replacement for database and upload backups. `GET /api/binary/author/articles/{articleId}/export` returns one Markdown document with frontmatter and base64url metadata; `GET /api/binary/author/content/export` returns a JSON package of all article exports. The metadata preserves category id, tag ids, cover URL, article status, scheduled publish time and revision records. Restore through `POST /api/binary/author/articles/import`; use `publish=false,preserveRevisions=true` for parity restores, or `publish=true` only when intentionally bringing the restored article online immediately.

## Migration Recovery

Before a production migration, create a site package and keep the package path with the deployment note. Startup migrations are reported in `StartupRuntimeState` as `schemaMigration`; rollback is either image rollback plus restoring the pre-migration database dump, or forward-fix migration after a failed dry run. Large table migrations must include a batch plan, post-migration data check, and restore command in the release note. The minimal local preflight for migration-sensitive work is:

```bash
dotnet build src/backend/FsusBlog.Server.csproj --no-restore
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore
tools/operations/backup-restore-drill.sh
```

Legacy PostgreSQL upgrades from the 2026-05-17 profile are documented in `docs/database-migration.md`. When a real legacy dump is available, run:

```bash
FSUS_LEGACY_20260517_DUMP_GZ=.tmp/db_blog_20260517000000fjyfe.sql.gz \
  tools/db/verify-legacy-upgrade-20260517.sh
```

The verifier restores the dump into the schema migration integration test container, runs `SchemaMigrationRunner.RunAsync()` twice, and checks content, messaging, visit-log, refresh-token cleanup, length alignment and migration-history idempotency.

`/user/manage/integrity` is the post-migration drift check for article bodies/revisions, taxonomy references, comment chains, sessions and assets. Do not mark a migration complete while it reports unresolved error-severity checks unless the release note documents the accepted manual repair.

## Supply Chain

Run the baseline dependency and build-chain scan before promotion:

```bash
tools/security/check-supply-chain-audit.sh
tools/security/generate-sbom.sh
```

The supply-chain script verifies npm and NuGet lock files, runs `dotnet list package --vulnerable --include-transitive`, runs production `npm audit --omit=dev --audit-level=high`, and checks documented security-sensitive backend dependency versions. The SBOM and audit summary are copied into release evidence when available.

## Author AI Assist

Author AI assist is an admin-only authoring tool and stays local by default. The endpoint writes `author-ai-assist` audit records and returns provider state to the editor so the author can see whether suggestions came from local fallback or an explicitly reviewed provider path.

| Setting | Required value for external provider |
|---------|--------------------------------------|
| `Authoring:AiAssist:Enabled` | `true` |
| `Authoring:AiAssist:Provider` | non-`local` provider id |
| `Authoring:AiAssist:AllowExternalProvider` | `true` |
| `Authoring:AiAssist:ExternalProviderReviewed` | `true` |

If any switch is absent, the response remains `externalProviderAllowed=false` and no unpublished draft content is sent outside the server process. A release that enables a real external provider must include security review evidence and an audit smoke showing the actor id, operation, provider mode and external-allowed flag in the audit payload.

## Post Deploy Smoke

After deployment, run the smoke runbook against the release preview or production URL:

```bash
FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh
```

The smoke records automated `verifiedCoverage` for anonymous public pages, feeds, sitemap, robots and health probes. It also carries a `manualChecklist` for admin login, Binary API, notification stream, upload and Passkey/MFA follow-up, but checklist entries do not count as automated coverage. Use `FSUSBLOG_SMOKE_DRY_RUN=1` for local documentation-only verification; it writes `status=scheduled` with a `dry-run` blocker. Real release evidence must come from the deployed endpoint with `status=ok`, `dryRun=false`, no blockers and all required automated coverage present.

## Release Evidence

Collect machine-readable release evidence after gates and smoke:

```bash
tools/operations/collect-release-evidence.sh
```

The collector writes `.tmp/release-evidence/<timestamp>/manifest.json` and copies available security, operations, coverage, doc sync and gate-log evidence. The manifest status is `collected-ok` only when required evidence is valid; otherwise it is `collected-blocked` and `evidenceSummary` records which evidence is missing, scheduled or blocked. `collected-blocked` is schema-valid for production-ci-gate diagnostics, but it is not publishable. The collector and manifest checker semantically parse critical evidence instead of trusting file presence: backup restore must be a real drill, post-deploy smoke must not be dry-run, authenticated DAST must execute an active scan, Wasm fuzz must run at least one seed, fault injection cases must be injected, and short soak must report positive duration, sample count and p95. Production closeout remains fail-closed: DNS delegation/readiness, firewall policy and live exposure must come from the real production environment before production exposure closeout can close, and release-closeout-gate must run with `--require-ok`.

The manifest is also the security evidence index for the release. It records DAST/ZAP output, `attack-matrix.json`, `permission-matrix.json`, production exposure status, production exposure request, firewall policy evidence, DNS readiness, DNS delegation and live exposure evidence. `evidenceSummary.externalExposure.valid=false` is a valid release-blocking artifact state, not a promotion signal. `evidenceSummary.externalExposure.request` summarizes the request package status, blocker count, current blocker sources, next action sources, unblock plan sources/count, required hosts, delegation domains, required evidence keys, firewall source sha256 requirements, handoff check count, verification command names/count, returned closeout command count and closeout command fields so operators can triage from the manifest before opening the full request JSON. `artifactDigests` records sha256 digests for copied production exposure artifacts so a handed-off bundle can be checked without trusting the current working tree; firewall policy evidence also carries `evidenceSource.sourceSha256` for the raw cloud or UFW export used to generate the normalized policy. If an artifact is absent, its digest must also be `null`. Missing external evidence is represented as `null` in `securityEvidenceIndex` while the blocker detail remains in `production-exposure-status.json`; do not replace that with synthetic passing firewall or DNS data.

Evidence levels are intentionally split:

| Evidence | Level | Gate |
| --- | --- | --- |
| coverage summary, ZAP, authenticated DAST, Wasm fuzz, attack matrix, permission matrix, supply-chain audit, SBOM, load result, fault injection, short soak | CI/release-depth forced | `tools/test.sh production` and `tools/operations/check-release-evidence-manifest.mjs` |
| image digest, post-deploy smoke, real backup restore drill, SLO alert replay, DNS readiness/delegation, firewall policy, live exposure | release closeout | `tools/operations/collect-release-evidence.sh` records `collected-blocked` until real evidence is present |
| retention cleanup | scheduled drill | `.github/workflows/daily-operations-checks.yml` plus release evidence copy when a release run provides the artifacts |

When `tools/security/complete-production-exposure-closeout.sh` fails, it still writes `.tmp/security/production-exposure-evidence-request.json`, tries to refresh later DNS readiness/live evidence, writes `.tmp/security/production-exposure-status.json` when possible, refreshes the request package with `currentStatus`, `nextActions` and `unblockPlan`, and leaves the closeout status blocked. The request package includes the direct closeout command plus returned-evidence and returned-handoff closeout commands so an operator can continue from either a filled `returned-evidence/` directory or a returned handoff tarball. `unblockPlan` groups every blocker source with the blocker count, exact expected artifact names, evidence file paths and commands needed to produce or verify that source. Run `tools/security/write-production-exposure-evidence-request.sh` before handoff when you only need the request package without live probing. Run `tools/operations/collect-release-evidence.sh` after a failed closeout attempt to preserve that request, the blocked status, and the DNS readiness/delegation, live exposure and firewall evidence files that were available.

Run `tools/security/check-production-exposure-handoff.sh <manifest.json>` before sending the evidence bundle outside the repo. This verifies the request, status report and manifest request summary are aligned across status, blocker count, blocker sources, required hosts, delegation domains, next actions, unblock plan sources/count, required evidence keys/count, firewall source sha256 requirement flags, handoff check count, verification command names/count, returned closeout command count and closeout command fields. It also verifies the request includes `requiredEvidence`, `verificationCommands` and `handoffChecks` for direct closeout, returned evidence verification, returned evidence closeout, returned handoff closeout, release evidence collection and handoff verification; checks that `unblockPlan` covers every blocker source with artifact names, commands and blocker counts; checks that the manifest bundle contains copied request/status/live/DNS/firewall artifacts under the standard in-bundle file names; checks that those files match the configured source files when the source files exist; checks that each copied artifact matches its manifest sha256 digest; and rejects request paths that point at temporary self-test evidence.

To hand the blocked production exposure state to an external operator, export the already-verified release manifest as a self-contained handoff directory and archive:

```bash
tools/security/export-production-exposure-handoff-bundle.sh .tmp/release-evidence/<timestamp>/manifest.json
```

The exporter runs the handoff checker first, copies the release evidence directory, writes `handoff-summary.json`, writes `operator-checklist.json`, writes `returned-evidence/expected-evidence-manifest.json`, writes `SHA256SUMS`, self-checks the generated directory, then creates `.tmp/security/production-exposure-handoff/<timestamp>.tar.gz` plus a tarball checksum and self-checks the archive before reporting success. The summary preserves blockers, unblock plan, next actions, required evidence, verification commands, returned closeout command coverage and firewall source sha256 requirements; the operator checklist preserves the same blocker-source checklist, returned artifact names and closeout commands in a short machine-readable file for external operators; the returned-evidence manifest records source manifest/request sha256 metadata, the exact standard filenames, required hosts, delegation domains and returned-evidence subset of the unblock plan the operator must satisfy. Verify the exported directory before sending it out:

```bash
tools/security/check-production-exposure-handoff-bundle.sh .tmp/security/production-exposure-handoff/<timestamp>
```

The bundle checker accepts either the exported directory or the `.tar.gz` archive, verifies the archive `.sha256` by digest so the archive can be moved with its checksum file, verifies `SHA256SUMS`, checks the copied release manifest artifact digests against bundled files, and rejects unsafe archive member paths, unsupported archive entry types, symlinks, and any handoff summary, operator checklist, README or returned-evidence manifest whose unblock plan, required hosts, delegation domains, standard evidence filenames or closeout commands no longer match the request and handoff summary. It is still a blocked handoff artifact until real DNS/firewall/live evidence makes `complete-production-exposure-closeout.sh` pass.

When an operator returns the standard evidence files, validate that returned directory before attempting production closeout:

```bash
tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>
```

The returned directory can be the bundle's `returned-evidence/` directory after the operator fills in the real JSON artifacts. It must contain `production-firewall-policy.json`, `production-dns-readiness.json`, `production-dns-delegation.json` and `production-exposure-live.json`. The verifier derives the current production host/domain scope from `FSUSBLOG_LIVE_HOSTS` or the production env source, validates `expected-evidence-manifest.json` when present, rejects any returned request or expected manifest that narrows that scope, and rejects an expected manifest whose source metadata or returned `unblockPlan` sources/count, evidence keys, evidence file basenames, artifact names or commands no longer match the required returned file set. It then points the existing firewall, DNS, live evidence and status reporter at that directory. It refreshes `production-exposure-status.json` and `production-exposure-evidence-request.json` in place, collects a release evidence manifest for the returned files, and runs the handoff checker against that manifest. It exits non-zero while the returned evidence is still blocked, but leaves the status, request and manifest artifacts behind for the next handoff cycle.

After returned evidence validates as `ok`, complete production closeout from that same returned directory or from a returned handoff bundle:

```bash
tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>
tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>
```

Both closeout commands require `expected-evidence-manifest.json`, rerun returned evidence verification, then invoke the normal production closeout verifier against the returned live evidence and status report. The direct returned-evidence closeout also detects when the provided directory is `returned-evidence/` inside a full handoff bundle and preflights that parent bundle before it verifies returned files. The handoff-bundle command accepts either the whole handoff directory or a returned `.tar.gz` with adjacent `.sha256`, verifies the full bundle first when release evidence, `SHA256SUMS` or `handoff-summary.json` are present, locates `returned-evidence/`, requires the expected evidence manifest, and then delegates to the returned-evidence closeout. That full-bundle preflight catches rewritten release evidence, summary, operator checklist, README and expected manifest metadata before any returned file can complete production closeout, regardless of whether the operator passes the whole bundle or only its `returned-evidence/` directory. They refuse to report success while the returned status is blocked. If a returned tarball fails after extraction, the wrapper preserves the extracted evidence under `.tmp/security/production-exposure-returned-handoff/` by default so the blocked status/request artifacts can be inspected after the temporary extraction directory is removed.

## Retention Cleanup

Use dry-run cleanup to verify retention behavior before deleting local artifacts:

```bash
tools/operations/cleanup-retention.sh
```

The retention script records intended cleanup for release/security evidence, coverage, upload sessions and historical AOT/search files. It must not delete article-referenced assets or the only copy of audit/security evidence required by the current release. Author asset cleanup is narrower: `/api/binary/author/assets/orphans` removes only zero-reference `asset_library_item` rows after an admin reindex/audit, and does not remove files under `/uploads/illustration/`.

Upload asset file deletion is opt-in and guarded. Set `FSUSBLOG_RETENTION_SCAN_UPLOAD_ASSETS=1` only with a non-empty `FSUSBLOG_RETENTION_REFERENCED_ASSETS` file containing `/uploads/illustration/*` URLs; referenced files are counted as `assetGuard.protectedReferencedAssets` and are never deleted. The fixture test `tools/operations/test-retention-cleanup-fixture.sh` proves an old referenced asset survives while an old unreferenced fixture asset is removed.

## Disk Hygiene

- Serilog file logs are retained by app settings.
- Docker stdout/stderr logs are rotated by compose `json-file` options.
- AOT cache is a named volume; clean it during maintenance only after confirming public fallback still works.
- Do not commit `.env`, logs, coverage, Playwright outputs, local probes, or temporary build spillover.

## Incident Recovery

- App fails liveness: inspect container logs, then restart the app container.
- App fails readiness only: inspect `/api/ops/health/ready-detail` to distinguish DB, Redis, config, or resource failure.
- DB pressure: lower public traffic at the gateway, check DB concurrency gate detail, and inspect slow SQL logs.
- Redis outage: keep the app isolated from new traffic until readiness returns; public hot paths may degrade without L2 cache.
- WebSocket pressure: inspect readiness runtime detail and logs for slow consumer disconnects.
