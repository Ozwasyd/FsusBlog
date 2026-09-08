# Performance Governance

This document records ongoing frontend performance rules below the public first-screen P0/P1 work.

## Measurement noise qualification

Every product-performance conclusion first requires host measurement-noise qualification. The authoritative policy is `config/testing/measurement-noise-policy.json`, executed by `tools/test/measurement-noise-envelope.mjs`. A lane or nested producer may not maintain a second threshold set or interpret a missing collector as zero load.

Within its admission deadline, each measurement window waits for one clean preflight observation, starts the workload from an independent monotonic clock, and records a post observation. Preflight, during, and post include host and current-run metrics. A blocking over-limit classifies the run as `infra.noisy-measurement-window`; it cannot be attributed to product regression or published as a product pass. Diagnostic-only fields explain the run but do not qualify it.

External-process identity coverage is diagnostic and cannot substitute for required metric-collector coverage. Identity-read failure does not authorize terminating that process. CPU/I/O authority remains the policy-defined combination of host cumulative and current-run cgroup cumulative deltas plus pressure metrics. If one cgroup metric is missing, retain other partial evidence, but preflight remains unsatisfied: do not start the workload, and fail qualification and product conclusions closed. Measured host noise over the limit likewise blocks startup during preflight.

Each of the three Production fresh-qualification rounds must be independently clean; a retry cannot overwrite the first noisy evidence.

In the matrix, a tier that directly owns the envelope does not share its execution wave with sibling tasks, and `benchmark-window` prevents measurement-owner overlap. This scheduling isolation does not change workload concurrency or require locking/cleaning the whole host; the collector still classifies external processes fail closed. Before admission, the benchmark build producer is independently reaped and records proof that any attached or detached build server belongs to this run, namespace, build root, and `Fresh` or resume source. The qualification owner only observes and never terminates processes. Siblings, IDEs, unknown owners, and other external processes remain for policy-based fail-closed collector classification.

The Linux direct lane creates a task-owned cgroup through a transient user-systemd service. The collector requires `cgroup.procs` to exactly equal the complete process tree rooted at the measured root; shared or incomplete cgroups fail closed. The command environment reaches bootstrap through a run-local `0600` JSON carrier, not `systemd-run` argv. Matrix-owner audit is fixed by `config/testing/measurement-window-inventory.json`. An external 72h soak counts toward release-final only after an `external-soak/72h` envelope receipt is imported and fully verified.

## Markdown preview paired Release diagnostic acceptance

`markdown-preview-release-performance` compares two explicit, immutable, independent Release sides. It does not checkout, build, seek `latest`, or copy both sides from one artifact root. Base and candidate each require a clean source checkout, production build receipt, Release static/backend runtime, and the same `acceptance-representative` fixture. Callers may not hand-compose side manifests: each side first supplies a declaration without source identity, artifact digest, machine, browser version, storage-state digest, or identity-probe response, then invokes the sole sealer:

```bash
npm --prefix src/frontend run seal:markdown-preview-release-side -- \
  --declaration /evidence/base-declaration.json \
  --output /evidence/base-side.json

npm --prefix src/frontend run seal:markdown-preview-release-side -- \
  --declaration /evidence/candidate-declaration.json \
  --output /evidence/candidate-side.json
```

The declaration schema is `fsusblog.markdown-preview-release-performance-side-declaration.v1`. It declares only side, source root, production artifact root/receipt, Release runtime URLs/routes, identity-probe header names, and fixture root/profile/identity. The sealer runs `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`, and the canonical worktree fingerprint in the live environment; the checkout must be clean and match the production receipt's commit/fingerprint. Frontend domain and SSR/client entry digests derive from the receipt. Machine/cgroup/cpuset, managed Chromium version, storage-state digest, and identity-probe status/body/headers are measured from the current environment.

Probe names are limited to lowercase `x-fsus-release-id` and `x-fsus-build-identity` (the lowercase forms of `X-Fsus-Release-Id` and `X-Fsus-Build-Identity`) and must include `x-fsus-release-id`; the observed value must equal declaration `releaseId`. `releaseId` must satisfy the canonical release-id contract, with a commit prefix matching the side source commit; `buildIdentity` must equal `releaseId`. An image digest without an independent live or manifest authority is outside this diagnostic-side schema. Manifests and evidence must not inline cookies, authorization, tokens, keys, or storage state.

Output is atomically sealed with mode `0444`, then passed through the measurement consumer's exact-schema verifier.

After both manifests exist, the only measurement entry point is:

```bash
FSUSBLOG_MARKDOWN_PREVIEW_BASE_MANIFEST=/evidence/base-side.json \
FSUSBLOG_MARKDOWN_PREVIEW_CANDIDATE_MANIFEST=/evidence/candidate-side.json \
npm --prefix src/frontend run check:markdown-preview-release-performance
```

This is manual diagnostic acceptance owned by `browser-diagnostics`: the matrix marks it `evidenceClass: diagnostic` and `requiredFor: none`, so it is not part of authoritative `release-final` closure. A noise receipt with `qualificationEligible: true` only says that this measurement window can support this product-performance conclusion; it does not change evidence class or become release-final evidence.

At startup the lane deletes only its three fixed output owners, then wraps the real runner in measurement-noise admission. The order is one warmup per side followed by five serial retained rounds, alternating the first side; each side ends with exactly five retained samples. Candidate/base ratios for AOT and client Markdown medians must be at most `1.02`; private preview must be at most `1.03`. No corresponding retained sample or either-side maximum may show increased raw AEDS response bytes. Compare unrounded medians. Missing, duplicate, zero, NaN, order-drift, feature/placeholder/browser-error, or runtime/source/machine-drift evidence fails closed.

Every retained/warmup article, about, and admin-write navigation response must carry the side-matching `x-fsus-release-id`. Article/about must also expose the same identity through `#fsus-public-boot-config.frontendBuildIdentity` in served HTML. Per-navigation evidence is written to raw measurement and independently rechecked by the final sealer against the side manifest; admin routes do not require a public boot config that does not exist.

For private preview, `preview:sha256:*` is the backend-response/DOM-completion source identity; FsusUI `markdown:*` is only render/activation completion. They must be equal within their respective domains and must not be compared directly. Rebuild `.tmp/perf/markdown-preview-release-performance/summary.json` only after raw measurement, independent recomputation with fixed threshold/schedule, and a clean noise receipt bound to the same raw-file digest all pass. Keep `raw-measurements.json` and `measurement-noise.json` in the same directory with the complete binding.

## Application configuration experiments

Application-level PublicAot and PublicHotRead knobs use one versioned catalog and a bounded repository-local runner. It estimates local first-order sensitivity, pairwise interaction, and curvature, but cannot write production configuration or relax correctness, security, resident-memory, snapshot-overlap, stale/fallback, queue-age, or release guardrails. High noise, residual drift, or guardrail failure produces `insufficient-evidence`/`rejected`, shrinks the trust region, and emits an explicit rollback profile.

Notification-queue tuning remains synthetic-only until issue #1451 defines delivery, loss, ordering, and lane semantics. Catalog authority, commands, evidence fields, model limits, and profile adoption are in [Application configuration local sensitivity and safe steps](performance-app-config-local-tuning.md).

## Admin route chunks

Admin code is split by domain rather than one oversized `route-admin` chunk:

- `route-admin-article`
- `route-admin-moderation`
- `route-admin-security`
- `route-admin-users`
- `route-admin-ops`
- `route-admin-dashboard`
- `route-admin-content`
- `route-admin-messages`

`check:asset-size-budget` enforces raw, gzip, and brotli budgets for `route-admin-*`. After a Vite build, `check:route-asset-budget` reads `.vite/manifest.json`, reports route-level raw/gzip/brotli first-entry cost, async dependency count, and forbidden public imports, and writes `.tmp/frontend/route-asset-budget.json` for CI evidence. ECharts remains within the lazy `echartsRuntime` boundary and must not be imported directly by public routes or ordinary components.

## Public image delivery

Public images require explicit delivery metadata:

- `width` and `height` for layout stability;
- `decoding="async"` for non-blocking decode;
- `loading="lazy"` for below-fold and secondary images;
- `loading="eager"` only above the fold;
- `fetchpriority="high"` only for true LCP candidates, currently the public article-detail cover image;
- responsive visuals using `object-cover` or an `aspect-*` constraint must include `sizes`.

Prefer manual WebP/AVIF cover uploads. The application must not synthesize fake covers to satisfy layout requirements.

## Production telemetry console noise

High-frequency info telemetry must not write to the production console by default. Warning and error audits remain visible. Info-level audit console output requires `VITE_FSUSBLOG_AUDIT_CONSOLE_INFO=1` for local diagnostics.

## Route render pressure

`check:route-render-pressure` and `check:dom-budget` cover public, user, and admin domains, including admin moderation and security routes. New policy/model/security surfaces therefore require render-pressure evidence before they can grow.

## Full app takeover

Public-shell takeover keeps non-first-frame plugins out of the mount window. `FsuMotion` installs dynamically after mount through an idle/timer gate. AppRuntime ownership lives only in `bootstrap/runtimeActivation.ts` (`dormant` → `scheduled` → `active`); the FullApp composition root schedules activation after interactive takeover (inheriting the first intent) or after first paint for direct SPA boots. Public AOT hydration must not mount AppRuntime. New full-app plugins must either be required for first paint or use the same deferred installation pattern.

## Perception-sealed v2 security budget

perception-sealed@v2 challenge telemetry records issue p99, verify p99, payload p95, and client-render p95. The readiness-detail budget snapshot warns when issue p99 exceeds 100 ms, verify p99 exceeds 32 ms, payload p95 exceeds 6200 bytes, or client render p95 exceeds 55 ms. These warnings gate security observability rollout; metric-collector failure remains best-effort and cannot change provider verification outcomes.

The perception-sealed@v2 issue path is intentionally stateless: providers generate the challenge ID, render material, sealed token, assignment, and payload, then return them without PostgreSQL or Redis writes. The verify path owns mutable state: Redis `INCR` gates attempts, SETNX-style Redis lease acquisition enforces consume-once replay protection, asynchronous audit records verify outcomes, and the orchestrator mints short-lived `X-Fsus-Challenge-Proof` only after provider verification succeeds. The CI matrix keeps `issue-no-db-redis-write` and `verify-redis-setnx-incr` separate so issue-p99 regressions cannot hide behind verify-path work.
