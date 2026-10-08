# Production Vitest rolling hosts

The Production `unit`, `property`, and `model` projects use a coarse-grained rolling coordinator instead of one
fixed-concurrency Vitest process. The coordinator is application-level grant consumption inside the cgroup/OCI
boundary documented for #1072; it does not replace OS enforcement.

## Authoritative catalog and partition identity

Each run performs exactly one `vitest list` for the three projects. The resulting catalog contains every test name,
groups it by file, rejects duplicate canonical test IDs, and records the current source fingerprint, config digest,
Node/Vite/Vitest versions, relevant environment, and transform-cache identity. Immutable partition identities include
that catalog identity and their exact file/project membership. A changed source, config, toolchain, or environment
therefore cannot consume stale partition or timing identity.

Files are assigned by deterministic longest-processing-time planning. Same-identity file timing p95 is preferred when
available; file size plus catalog test count is the deterministic fallback. Host count, workers per host, and partition
count are separate values. The machine-derived default creates more partitions than peak hosts to absorb long tails,
but never creates one process per file or one full Vitest host per CPU. The planner is contract-tested for 4, 8, 16,
and 32 CPU machines and also applies available-memory and optional `FSUSBLOG_VITEST_HOST_LIMIT` bounds.

## Live admission and contraction

The coordinator repeatedly reads the current run's atomic scheduler resource-grants document. It initially admits only
the CPU and memory available to the step. A larger grant can admit additional fixed-size hosts while unclaimed
partitions remain. A smaller grant never kills a running host; it blocks further claims until active worker and memory
reservations fit the new grant. Every host receives a unique report ID, partition ID, JSON, JUnit, blob, log, and
coverage directory. Mock state, globals, and module singletons remain process-isolated.

The reader validates the declared parent resource budget as well as the selected grant: CPU allocations must be positive integers, memory must be positive, and neither grant may exceed its parent. Missing or invalid parent budgets fail closed before coordinator host admission. Grant generation and stale-time qualification require the canonical scheduler conformance contract; these budget checks alone do not establish it.

The catalog pass also warms one run-bound transform-cache seed. Each admitted host receives a reflink/copy clone of
that seed, so concurrent Vite processes never mutate the same cache directory. Successful host caches are merged in
stable path order after execution. Byte-identical entries are reused; equivalent transformed code with different
`vitestCache` import metadata is resolved deterministically, while any executable-code conflict fails closed.

Host failures are collected rather than fail-fast: independent partitions finish, then duplicate, missing, unexpected,
empty, and non-passing files/test IDs are checked against the authoritative catalog and the aggregate fails closed.
SIGINT, SIGTERM, and the inherited step deadline terminate all active Vitest process groups, including Vite/esbuild
descendants. The coordinator drains every active host promise before cache/output invalidation; after a bounded grace
period it escalates unresponsive process groups from `SIGTERM` to `SIGKILL`, so cancellation cannot leave a writer
mutating the current run after the coordinator has returned.

## Coverage and stable artifacts

The first real test partition is the coverage-universe owner and runs with `coverage.all=true`; other partitions collect
only executed-file coverage. Its all-files map becomes the authoritative zero-and-hit universe, then the other isolated
maps are merged into it. This removes the previous second no-matching Vitest cold start while preserving the configured
file universe and final line, branch, function, and statement threshold semantics.

The stable consumer paths remain:

- `.tmp/test-results/vitest/production-rolling/merged.json`;
- `.tmp/test-results/vitest/production-rolling/merged.xml`;
- `.tmp/test-results/vitest/production-rolling/summary.json`;
- `src/frontend/coverage/unit/coverage-summary.json`.

The v2 summary records catalog/discovery identity, initial and peak host counts, workers per host, partition identities
and durations, grant history, startup/time-to-first-test, file runtimes, transform-cache warm/growth observations,
load dispersion, coverage, exact-once counts, and the current scheduler resource-evidence binding.

Rollback is local to the coordinator: revert the runner/config change while retaining the stable merged artifact paths.
No API, runtime application behavior, or ordinary developer Vitest command changes.
