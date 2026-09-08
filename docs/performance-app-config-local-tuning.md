# Application configuration local sensitivity and safe steps

This page describes application-level performance-configuration experiments. The only machine-readable authority is [`config/performance/app-config-knob-catalog.v1.json`](../config/performance/app-config-knob-catalog.v1.json). The catalog defines the experimental feasible region; it does not cover `appsettings.Production.json`, and the runner never writes a running instance.

## Scope and boundaries

Phase one covers:

- `PublicAot` SSR worker, backfill concurrency/queue, and two interaction groups covering timeout, circuit, and route quarantine;
- `PublicHotRead` article admission, compression savings, and resident-variant client-share interaction group;
- only the `SyntheticNotification:*` notification-stream fixture. Until issue #1451 defines delivery, loss, ordering, and lane policy as an explicit contract, the catalog rejects real notification candidates.

CLR, libc, R2R, PGO, GC, ThreadPool, and container release profiles remain owned by #1064. PublicHotRead resident bytes, snapshot overlap, and artifact count remain hard budgets; the tuner cannot relax them. Capacity conclusions continue to consume the performance-saturation authority. Synthetic surfaces validate algorithms and constraints only, not production-throughput claims.

Each catalog knob requires a stable ID, real configuration key, owner, correctness/security owner, type, range/step, lifecycle, baseline, rollback, maximum normalized step, observables, guardrails, and interaction group. Unknown keys, missing owners or guardrails, invalid lifecycle/range/step, missing configuration, and derived-constraint conflicts fail closed. Because the current runtime reads these PublicAot and PublicHotRead build parameters at service construction/snapshot-build boundaries, the catalog conservatively marks them `restart-required`; an `IOptions` registration is not treated as safe hot reload.

## Local experiments

The fixed synthetic fixture reproduces baseline/candidate measurements:

```bash
node tools/perf/run-app-config-local-experiment.mjs \
  --fixture tests/performance/fixtures/app-config-local-surfaces.v1.json \
  --out .tmp/perf/app-config-local-evidence.json
```

To select one interaction group:

```bash
node tools/perf/run-app-config-local-experiment.mjs \
  --group public-hotread-residency \
  --out .tmp/perf/public-hotread-local-evidence.json
```

The design binds source commit/worktree, build artifact, fixture, toolchain, security policy, and container-budget digests. Each repeat uses a deterministic balanced order, records cleanup/cooldown, and never reuses a previous dynamic outcome. Failed candidates remain in raw measurements and are not silently removed from model evidence. A center, one-axis positive/negative points, and pairwise four-corner points use fewer physical samples than a complete three-level Cartesian grid; the runner executes only the selected interaction group.

When a real local Kestrel/TestServer or existing open-loop runner is connected, it must keep the same design and evidence schema and satisfy:

1. The same source, build artifact, fixture/data scale, security policy, container budget, and toolchain.
2. At least two repeats recording p50/p95/p99/p99.9, safe throughput/saturation knee, errors/timeouts/cancellation, CPU/RSS/heap/LOH/GC, queue depth/bytes/oldest age, cache stale/fallback/rebuild, AOT backfill/drop/quarantine/publish latency, and applicable Redis/PostgreSQL wait.
3. Cleanup/cooldown after every round, with failures written to evidence.
4. A correctness/security failure rejects the candidate and excludes it from profile adoption.

## Model and trust region

Catalog/constraint validation lives in `app-config-catalog.mjs`; local design in `app-config-local-tuner.mjs`; model fitting and proposal/rollback in `app-config-local-model.mjs`. This keeps authority, experiment orchestration, and numerical/decision responsibilities separate. The local model uses normalized-knob first-order, square, and primary pairwise-interaction terms. Its output includes Jacobian, pairwise coefficients, curvature, residuals, repeat coefficient of variation, direction conflict, and capacity-cliff markers. It seeks no global optimum and does not interpret one timing fluctuation as a gradient.

- Insufficient samples, a degenerate matrix, repeat variance, or residual above threshold yields `insufficient-evidence` and no candidate profile.
- Candidate knobs and groups are bounded by the maximum normalized step, then revalidated against range, step, and hard constraints.
- A predicted guardrail breach skips the candidate and shrinks the radius.
- Only a measured direction matching the prediction, repeatable benefit, and passing correctness/security/resource guardrails yields `accepted` and a small radius increase.
- Prediction error or measured guardrail/correctness/security failure yields `rejected`, a smaller radius, and a rollback profile.

High-condition-number signals include a degenerate design, relative residual, curvature materially greater than first-order direction, adjacent candidate failures, and direction conflict. These signals require a smaller local region or focused subsystem diagnosis; do not mask blocking, ordering, cache consistency, or security defects with larger queues or wider thresholds.

## Evidence and profile adoption

Each evidence record retains complete config/config digest, catalog/design digest, raw measurements, model and residuals, predicted-versus-actual delta, guardrails, the reason for trust-region changes, conclusion, named profile, and rollback profile. Repository fixture evidence is [`tests/performance/app-config-local-evidence.v1.json`](../tests/performance/app-config-local-evidence.v1.json); it is explicitly `synthetic` and proves only that the algorithm can recover direction/interaction, identify cliffs, and obey the feasible region.

`accepted` means “eligible for a submitted suggestion,” not adopted configuration. Making a value the default requires:

1. An explicit profile/config change with normal code review.
2. Existing correctness, security, performance-saturation, and release gates.
3. A controlled restart through the deployment lifecycle; the runner cannot modify production.
4. Retained catalog rollback value and complete rollback profile.

Rollback does not depend on the tuner: do not submit the candidate, or explicitly restore the rollback profile. If a guardrail fires during an experiment, stop that candidate, clean the local runtime/fixture, and shrink the radius. Because the runner never writes online instances, no automatic production change needs reversal.
