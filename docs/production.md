# FsusBlog Production Deployment

## Topology

Production is a Docker VPS deployment:

- `fsus-app`: one ASP.NET Core container serving API, public HTML, static frontend assets, SSE, and the Node SSR runtime.
- PostgreSQL: external service reachable from the Docker network.
- Redis: external service reachable from the Docker network.
- Host Nginx/OpenResty: TLS, HTTP/2, request size policy, and reverse proxy to Kestrel `127.0.0.1:8080`.

The app container owns only application runtime state. Persistent state is kept in PostgreSQL, Redis, and Docker volumes:

- `fsus-uploads`: uploaded files under `/app/wwwroot/uploads`
- `fsus-aot-cache`: public AOT shell cache under `/app/wwwroot/aot-cache`
- `fsus-logs`: rolling Serilog files under `/app/Logs`

## Required Configuration

Create a private `.env.production` from `.env.production-template` and replace every `CHANGE_ME` value.

Required variables:

- `EXTERNAL_DB_HOST`
- `EXTERNAL_REDIS_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `REDIS_PASSWORD`
- `Jwt__SecretKey`
- `SITE_BASEURL`
- `CORS_ALLOWED_HOSTS`
- `APP_ALLOWED_HOSTS`
- `FIDO2_SERVER_DOMAIN`
- `REVERSE_PROXY_KNOWN_PROXIES` or `REVERSE_PROXY_KNOWN_NETWORKS`

Production validation rejects default JWT secrets, placeholder secrets, empty Redis passwords, HTTP CORS origins, non-HTTPS `SITE_BASEURL`, wildcard `AllowedHosts`, and missing reverse-proxy trust configuration. Invalid production validation marks `/health/ready` as `503`, and the hosted validation task reports the detailed degraded state in runtime health.

DataProtection keys are persisted by default under `FSUSBLOG_DATA_ROOT/data-protection-keys`; override with `DataProtection:KeyRingPath` or `FSUSBLOG_DATA_PROTECTION_KEY_RING` when running multiple instances or using a mounted secrets volume. Keep `DataProtection:ApplicationName=FsusBlog` consistent across rolling deployments so protected MFA/session payloads remain readable during restart and rollout windows.

Set `FSUSBLOG_BACKUP_ROOT` to a persistent backup volume. `tools/operations/backup-site.sh` writes complete site packages there, and `/user/manage/ops` reports the latest database/uploads/DataProtection/config/package/drill artifact status. Keep `FSUSBLOG_DATA_ROOT`, uploads, AOT cache and search artifact paths stable across image rollouts so restore packages can be replayed on a new host without path guessing.

## Build And Deploy

```bash
export GITHUB_PACKAGES_TOKEN=...
./tools/build-final-image.sh
docker compose --env-file .env.production config
docker compose --env-file .env.production up -d
```

Do not use `.env.production-template` to start production. It is only safe for `docker compose config` structure checks.

The compose file binds Kestrel to `127.0.0.1:8080:8080`. Do not change it back to `8080:8080` unless another private gateway container owns the only public entrypoint and the replacement binding is covered by an equivalent security check.

## Health Checks

- `GET /health/live`: process/Kestrel liveness only; safe for Docker healthcheck; returns `application/json`.
- `GET /health/ready`: readiness for rollout and operations; checks configuration, PostgreSQL, Redis, public webroot, IP2LOCATION data, DB gate snapshot, SSE connection count, typed startup runtime snapshot, scheduled publish worker snapshot (`lastPublishedCount` / `lastFailedCount` / `dueBacklog`), and public hot-read snapshot state/version/error metadata; returns `application/json`.

Health checks are an ops JSON protocol. They do not emit PublicAOT bootstrap frames or AEDS binary payloads, so rollout probes can evolve independently from public-page payload changes.

Use readiness before switching traffic:

```bash
curl -fsS http://127.0.0.1:8080/health/ready
```

## SLO Alert Closeout

Before promoting a candidate release, generate the SLO alert fixture:

```bash
tools/operations/check-slo-alert-fixture.mjs
```

The default synthetic fixture proves that the alert definitions for readiness degradation, PostgreSQL latency, Redis latency, AOT backfill failure, search rebuild failure, SSE slow-disconnect spikes and security blockers are still executable. For production evidence, pass a JSON fixture built from the current `/health/ready` response, the latest SSE slow-disconnect metric window and `.tmp/security/production-exposure-status.json`.

Traffic promotion is blocked while any `critical` alert is firing. `warning` alerts require an operator note in the release evidence manifest explaining impact, investigation result and the chosen rollback or degradation action. The detailed runbook and per-alert actions live in `docs/operations.md`.

## Capacity Baseline

The default compose file is tuned for a practical 2C/2G VPS baseline:

- Kestrel serves static frontend assets directly.
- L1 memory cache and Redis L2 absorb public hot reads.
- Public hot-read L0 serves preencoded `.aeds` snapshots ahead of the normal pipeline; misses and not-ready responses are `no-store` and must be watched through `/health/ready` runtime metadata.
- DB concurrency gate protects PostgreSQL during cache misses and DB-heavy background jobs such as visit-log flush, view reconciliation, scheduled publish and PublicHot rebuild.
- Article mutations write `article_mutation_outbox` in the same DB transaction as the primary row change; the dispatcher replays cache/search/AEDS/PublicHot/SSE side effects with bounded retry after a crash.
- Visit-log view projection is batched and periodically reconciled from `sys_visit_log`, so a projection failure after log persistence is repairable.
- SSE backlog multi-target writes are pipelined and local fanout runs from a bounded queue; frames remain bounded per connection and slow consumers are disconnected.
- Upload-session expiration scans run in `UploadSessionCleanupWorker`, not on init/status request paths.
- Content-filter dictionary reloads are serialized through one reload queue to coalesce file watcher bursts.
- Docker log rotation caps container stdout/stderr growth.

For larger machines, override compose resource limits and DB/Redis pool settings with a production override file. Do not raise DB concurrency without checking PostgreSQL connection limits.

## Runtime Tuning

Host runtime tuning is deployment-driven. The application does not mutate startup-sensitive `DOTNET_ReadyToRun`, `DOTNET_TC_QuickJitForLoops`, or `DOTNET_TieredPGO` after `WebApplication.CreateBuilder(args)`, because the CLR can read those switches before app code runs. Set those values in Docker/systemd/Kubernetes/runtimeconfig before process start and keep the benchmark evidence with the release notes:

```json
{
  "RuntimeTuning": {
    "ReadyToRun": "1",
    "QuickJitForLoops": "1",
    "TieredPGO": "1",
    "ThreadPool": {
      "Enabled": true,
      "MinThreadsPerCpu": 50
    }
  }
}
```

The default Docker publish profile is throughput/TieredPGO-first and keeps `PublishReadyToRun=false` consistently in both `src/backend/FsusBlog.Server.csproj` and `ops/docker/FsusBlog.Server.Dockerfile`. Use `tools/build-native.sh` or a named publish profile when a startup/R2R benchmark explicitly chooses a different profile.

The startup log line `Runtime tuning effective values` records the configured values, confirms startup environment variables were not mutated by app code, and records before/after ThreadPool minimums. `tools/operations/collect-release-evidence.sh` also records the effective `DOTNET_*` runtime preset values, optional ThreadPool override evidence, the perf artifact pointer, and the rollback instruction in `evidenceSummary.operations.runtimeTuning`. Prefer measuring request path, search rebuild, and Public AOT backfill latency before raising these defaults in production; rollback is to unset deployment `DOTNET_*` overrides and restart on the same image.

Toolchain pins are part of the release input. The Docker wasm builder pins Emscripten by image digest and vcpkg by `VCPKG_COMMIT`; bump both in the Dockerfile in the same commit as the rebuild evidence.

## Gateway Notes

The host gateway must:

- use `deploy/production-openresty.conf` as the production baseline,
- reject unknown Host values with the default server,
- terminate TLS and forward `X-Forwarded-*` headers only from the configured trusted proxy path,
- expose only `80/tcp` and `443/tcp` publicly,
- keep Redis and PostgreSQL on private network/security-group reachability only,
- rate-limit login/admin/global request paths,
- deny hidden files and backup/archive files,
- disable buffering for `/api/notifications/stream`,
- keep upload limits explicit,
- proxy `/health/live` and `/health/ready`,
- preserve immutable caching headers generated by Kestrel for hashed assets.

If OpenResty/Nginx runs on the same host, keep `REVERSE_PROXY_KNOWN_PROXIES=127.0.0.1`. If it runs from a private gateway subnet, set `REVERSE_PROXY_KNOWN_NETWORKS` to the exact CIDR. Never use `0.0.0.0/0` or a public subnet as a trusted forwarded-header source.

Before treating the external network exposure checklist as complete, run the live probe from a network that can resolve the production DNS:

```bash
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
tools/security/write-production-exposure-evidence-request.sh

FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE=.tmp/security/production-exposure-live.json \
tools/security/complete-production-exposure-closeout.sh
```

The evidence request command writes `.tmp/security/production-exposure-evidence-request.json` with the required host set, root delegation domains, port policy, expected firewall evidence file, DNS/live/status artifact paths, operator input commands, direct closeout command, returned evidence verifier/closeout commands, returned handoff closeout command and release evidence command. It also includes `requiredEvidence` entries for every closeout artifact, standard release artifact names, `verificationCommands`, `handoffChecks`, `currentStatus`, `blockers`, source-specific `nextActions`, and an `unblockPlan` that groups each blocker source with its expected artifacts and commands when a status report is available. It is an operator handoff artifact, not a passing signal. The complete closeout command writes the same request package automatically, then checks local tool prerequisites, runs the production network config baseline, checks DNS delegation, verifies firewall/security-group policy evidence, checks production DNS readiness, generates live exposure evidence, verifies that evidence, and updates `NB-P0-001` in `TODO.md` only after every check passes. When closeout writes a fresh status report, it refreshes the request package again so release evidence contains the latest blockers. If `FSUSBLOG_CLOUD_FIREWALL_SOURCE` is set, complete closeout first normalizes that cloud export into `FSUSBLOG_FIREWALL_POLICY_EVIDENCE`; if `FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY=1` or `FSUSBLOG_UFW_STATUS_FILE` is set, it first collects host-firewall evidence from UFW. Both paths immediately run the shared firewall verifier before DNS readiness and live probing.

For a narrower operations check, run `tools/security/check-production-dns-delegation.sh`, then `tools/security/check-production-dns-readiness.sh`, then `tools/security/check-production-exposure-live.sh`. DNS delegation writes `.tmp/security/production-dns-delegation.json` and checks whether each root production domain has NS/SOA answers from public resolvers plus NS delegation from TLD authoritative nameservers. DNS readiness writes `.tmp/security/production-dns-readiness.json` by default and fails if any required production host lacks local resolver resolution or an A/AAAA answer from every configured public resolver. The live exposure script requires production DNS resolution, verifies public reachability for `80/tcp` and `443/tcp`, rejects public reachability for `22/tcp`, `6379/tcp`, `5432/tcp`, and `8080/tcp`, and checks HTTPS plus `Strict-Transport-Security`. Set `FSUSBLOG_LIVE_HOSTS` to the complete production host list before final closeout, or let `tools/security/collect-production-hosts.sh` derive it from production env values including `SITE_BASEURL`, `Seo__BaseUrl`, `CORS_ALLOWED_HOSTS`, `APP_ALLOWED_HOSTS`, and Fido2/WebAuthn domain/origin settings. The host collector rejects wildcards, localhost values, IP literals, and malformed hostnames, so final closeout is always scoped to real production DNS names. Live evidence records that list as `requiredHosts`, DNS readiness records the same host set as `requiredHosts`, and DNS delegation records root domains as `delegationDomains`; the verifier/status report/TODO closeout chain accepts generated space-delimited fields or operator-supplied JSON arrays for those fields, and rejects evidence that omits the field or lacks any required host/domain. Set `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE` to persist a JSON evidence file for release notes or TODO closeout. The evidence records local resolver results plus public A/AAAA checks against `1.1.1.1` and `8.8.8.8`; override that list with `FSUSBLOG_DNS_RESOLVERS` if release policy requires a different resolver set. Live evidence must include `generatedAt` and is valid for 24 hours by default; override with `FSUSBLOG_PRODUCTION_EXPOSURE_MAX_AGE_SECONDS` only for an explicit release policy exception.

After generating or receiving evidence, run `tools/security/report-production-exposure-status.sh` to write `.tmp/security/production-exposure-status.json`. The status report is read-only: it runs the firewall policy verifier and live evidence verifier against the configured evidence files, requires live evidence `requiredHosts` to cover the complete production host list, requires fresh DNS readiness evidence for every production host, requires fresh DNS delegation evidence for every root production domain, normalizes string or JSON-array `requiredHosts`/`delegationDomains` evidence fields, records the complete production host list plus delegation domains, and emits `status=ok` only when every evidence chain has no blockers. When blocked, the JSON `blockers` array keeps release notes and `TODO.md` comments aligned with the exact missing proof, such as absent firewall policy evidence, live evidence missing a production host, absent or stale DNS readiness/delegation evidence, missing DNS, unproven closed ports, missing HTTPS, or missing HSTS.

Before handing off release evidence, run `tools/security/check-production-exposure-handoff.sh .tmp/release-evidence/<timestamp>/manifest.json`. The handoff checker confirms the request package, status report and manifest agree on status, validity, blocker count, blocker sources, blocker details, required hosts and delegation domains, every blocker source has a next action and an `unblockPlan` entry, request `requiredEvidence` covers every configured evidence file with standard artifact names, request keeps the firewall raw source sha256 requirement enabled, request `verificationCommands`/top-level command fields/`handoffChecks` include direct closeout, returned evidence verification, returned evidence closeout, returned handoff closeout, release evidence collection and handoff verification, manifest `externalExposure.request` preserves the request required-evidence keys/count, unblock plan sources/count, firewall source sha256 requirement flags, verification command names/count, returned closeout command count and closeout command fields, manifest `externalExposure.blockers` exactly matches the status report, request `evidenceFiles` point at the configured firewall/live/DNS/status source files, the bundle contains copied request/status/live/DNS/firewall artifacts under standard file names matching those source files, those artifacts match their sha256 digests in the manifest, manifest component statuses for firewall policy, DNS readiness, DNS delegation and live exposure match the configured source evidence, and evidence paths are not fixture `/tmp/tmp...` paths. Exported handoff bundles include `operator-checklist.json`, a machine-readable blocker-source checklist that must match request `unblockPlan`, artifact names and closeout commands. Bundle README files are checked too: they must retain the standard returned evidence filenames, verifier/closeout commands, operator checklist reference and blocked-closeout warning. The exporter self-checks both the generated directory and tarball before reporting success. Archive members are rejected before extraction if they use absolute paths, `..` traversal, or unsupported entry types such as symlinks and special files. Bundle and returned evidence directories must not contain symlinks, so closeout never follows an operator-supplied link outside the verified evidence tree. Exported returned-evidence manifests preserve source manifest/request sha256 metadata plus returned `unblockPlan` sources/count, evidence key, evidence file, artifact and command mappings; returned closeout requires `expected-evidence-manifest.json` and rejects a manifest that loses or rewrites that plan before TODO closeout.

Firewall/security-group policy evidence is a small JSON file consumed by `tools/security/verify-production-firewall-policy-evidence.sh`. The verifier expects a fresh `generatedAt`, a supported `evidenceSource.kind`, an `evidenceSource.sourceSha256` digest for the raw firewall export, a non-empty `appliesToHosts` list, and an `ingressRules` array. Supported source kinds are `aws-security-groups` and `ufw-status`; prefer the repo normalizer/collector because they write the source metadata automatically. When `evidenceSource.sourceFile` or `evidenceSource.statusFile` is readable on the current machine, the verifier compares `sourceSha256` against that raw file before checking rules. Complete closeout and direct TODO closeout pass the same required host set into the firewall verifier, derived from `FSUSBLOG_LIVE_HOSTS`, production env values, or live evidence `requiredHosts`; every required host must appear in `appliesToHosts`, so unrelated policy exports cannot satisfy final closeout. The verifier requires public `tcp/80` and `tcp/443` allow rules, rejects any other public TCP allow rule including `fromPort`/`toPort` ranges and all-protocol rules, rejects any non-private non-web port, rejects public `tcp/22`, and requires every SSH rule to declare `sourceType` as `fixed-management-ip`, `vpn`, or `private-management-network`. A `fixed-management-ip` SSH source must be a single host CIDR (`/32` or `/128`), while `private-management-network` must be a private source range. Redis `tcp/6379` and PostgreSQL `tcp/5432` must come only from private sources; fixed public CIDRs are rejected for database/cache and other non-web ports. SSH remains allowed only through `fixed-management-ip`, `vpn`, or `private-management-network` source types. Firewall policy evidence is valid for 24 hours by default; override with `FSUSBLOG_FIREWALL_POLICY_MAX_AGE_SECONDS` only for an explicit release policy exception.

Use a real cloud security-group or host-firewall export as the source for that JSON, then normalize it to this shape. `tools/security/production-firewall-policy.evidence.example.jsonc` is a documentation-only template with placeholders and comments; do not pass it to the verifier, and do not synthesize passing evidence for final closeout.

On a production host that uses UFW as the host firewall, the repo can collect and verify the normalized evidence directly from `ufw status`:

```bash
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES='203.0.113.4/32=fixed-management-ip,10.0.0.0/24=vpn' \
tools/security/collect-host-firewall-policy-evidence.sh
```

The collector refuses inactive UFW, requires explicit `tcp/80` and `tcp/443` allow rules, parses both IPv4 and `(v6)` UFW rows, records the raw UFW status sha256 in `evidenceSource.sourceSha256`, rejects generated evidence that the firewall policy verifier would reject, and requires SSH sources to be classified as `fixed-management-ip`, `vpn`, or `private-management-network`. Private RFC1918/loopback/ULA sources are classified as `private-management-network` automatically; public SSH source CIDRs must be mapped with `FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE` or `FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES`.

For AWS EC2 security groups, export the active production group and normalize it before final closeout:

```bash
aws ec2 describe-security-groups --group-ids sg-0123456789abcdef0 > .tmp/security/aws-security-groups.json
FSUSBLOG_LIVE_HOSTS=fsus.blog,www.fsus.blog \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES='203.0.113.4/32=fixed-management-ip,10.0.0.0/24=vpn' \
tools/security/normalize-cloud-firewall-policy-evidence.sh .tmp/security/aws-security-groups.json
```

The normalizer currently supports the `describe-security-groups` JSON shape, auto-detects that format, writes the same normalized evidence schema with the raw export sha256, and immediately runs `verify-production-firewall-policy-evidence.sh`. A non-private database/cache rule, non-private extra-port rule, public SSH, wide public range, all-protocol public rule, stale evidence, source digest mismatch, or missing required host still fails through the shared verifier.

```json
{
  "generatedAt": "2026-05-17T13:54:00Z",
  "evidenceSource": {
    "kind": "aws-security-groups",
    "sourceFile": ".tmp/security/aws-security-groups.json",
    "sourceSha256": "REPLACE_WITH_SHA256_OF_RAW_EXPORT"
  },
  "appliesToHosts": ["fsus.blog", "www.fsus.blog"],
  "ingressRules": [
    { "protocol": "tcp", "fromPort": 80, "toPort": 80, "source": "0.0.0.0/0", "action": "allow", "purpose": "http" },
    { "protocol": "tcp", "fromPort": 443, "toPort": 443, "source": "0.0.0.0/0", "action": "allow", "purpose": "https" },
    { "protocol": "tcp", "fromPort": 22, "toPort": 22, "source": "203.0.113.4/32", "sourceType": "fixed-management-ip", "action": "allow", "purpose": "ssh-management" }
  ]
}
```

When `FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE` is set, `./tools/test.sh security` also runs `tools/security/verify-production-exposure-evidence.sh` after a successful live probe. That verifier rejects incomplete DNS evidence, reachable forbidden ports, missing HTTPS/HSTS, and `FSUSBLOG_LIVE_TARGETS` pre-cutover evidence for final closeout.

After the firewall, DNS readiness/delegation, live evidence, and status report verifiers pass against the real production domains, close `NB-P0-001` with:

```bash
FSUSBLOG_FIREWALL_POLICY_EVIDENCE=.tmp/security/production-firewall-policy.json \
tools/security/close-production-exposure-todo.sh .tmp/security/production-exposure-live.json
```

The closeout script refuses to edit `TODO.md` unless the firewall policy verifier, live evidence verifier, DNS readiness evidence, DNS delegation evidence, status report, and the `NB-P0-001` `Comment:` evidence slot all succeed first. Prefer `tools/security/complete-production-exposure-closeout.sh` for the final release closeout because it runs every prerequisite in order. If one evidence step fails, the complete closeout script still attempts later DNS readiness/live/status checks before exiting, so release evidence can archive the freshest blocker set without marking the TODO item complete. When closing from a returned full handoff directory, tarball, or its nested `returned-evidence/` directory, the returned closeout path first verifies the original handoff bundle metadata before reading returned evidence, so a tampered operator checklist, summary, checksum or expected manifest cannot close the TODO item even if the returned JSON files are otherwise valid.

`tools/security/check-production-network-baseline.sh` runs `tools/security/check-production-exposure-prereqs.sh` and `tools/security/test-production-exposure-tools.sh` by default. The prereq check verifies required shell tools and executable scripts before a live closeout attempt. The local self-test uses synthetic evidence to prove public SSH or Redis/PostgreSQL firewall policies are rejected, failed DNS evidence cannot edit `TODO.md`, pre-cutover target evidence is rejected for final closeout, the status report captures firewall, DNS readiness, DNS delegation, and live blockers, the handoff checker rejects fixture `/tmp/tmp...` evidence paths unless tests explicitly allow them, the complete closeout script writes a blocked status report on failed evidence, DNS delegation failure still refreshes later DNS readiness/live evidence before exit, valid firewall plus DNS readiness/delegation plus live evidence can close `NB-P0-001` in a fixture, and the complete closeout script leaves no unchecked production exposure TODO item after valid evidence.

If the gateway is ready before DNS cutover, `FSUSBLOG_LIVE_TARGETS=fsus.blog=203.0.113.10,www.fsus.blog=203.0.113.10` can probe a concrete address while preserving Host/SNI. That pre-cutover probe is useful for operations rehearsal, but it does not satisfy the final production-domain checklist until public DNS resolves. HSTS `includeSubDomains` or preload should only be enabled after every production subdomain is HTTPS-clean.

## Post Deploy Evidence Loop

For the single-author blog release flow, keep these artifacts with the release:

```bash
FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh
tools/operations/collect-release-evidence.sh
```

The smoke output belongs in `.tmp/operations/post-deploy-smoke.json`; the evidence collector writes `.tmp/release-evidence/<timestamp>/manifest.json`. The manifest may be `collected-blocked`; in that case `evidenceSummary` is the release-blocking record and must show the missing image digest, firewall policy, DNS, live exposure or other invalid evidence directly. The collector also copies `production-exposure-evidence-request.json` when present and summarizes its current status, blocker count, blocker sources, next action sources, unblock plan sources/count, required hosts, delegation domains, verification command names/count, returned closeout command count and closeout command fields under `evidenceSummary.externalExposure.request`, so the release artifact records exactly what external inputs and closeout paths were requested. These files complement, but do not replace, `tools/security/complete-production-exposure-closeout.sh`: external production exposure is complete only when real DNS delegation/readiness, firewall/security-group evidence, HTTPS/HSTS and live forbidden-port checks all pass for the production host set.

Closeout levels:

| Evidence | Responsibility |
| --- | --- |
| coverage, ZAP, attack matrix, permission matrix, supply-chain audit, SBOM, load result | CI forced before release evidence collection |
| image digest, DNS readiness/delegation, firewall policy, live HTTPS/HSTS/forbidden-port exposure, post-deploy smoke | release closeout required before promotion |
| backup restore drill, retention cleanup and SLO alert replay | scheduled operations drill, copied into release evidence when available |

Run `tools/operations/check-release-evidence-manifest.mjs .tmp/release-evidence/<timestamp>/manifest.json` before treating a manifest as a release credential. Use `--require-ok` only for final promotion, because local CI can legitimately produce `collected-blocked` while waiting for external production evidence.
