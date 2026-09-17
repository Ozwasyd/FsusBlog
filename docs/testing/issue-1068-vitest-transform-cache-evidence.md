# #1068 Vitest transform cache evidence

Production ordinary Vitest hosts and the isolated perf process may share only the
run-bound filesystem transform cache. The perf process remains a separate
process, starts after the ordinary lifecycle is sealed, writes its own report,
and does not collect or mutate ordinary coverage.

## Machine-evidence integrity

`production/perf-isolated-timing.json` is authoritative only when all of the
following checks pass:

- cache hit, miss, and write events come from the `vitest:cache:fs` debug
  namespace and name the validated run-bound cache directory; benchmark stdout
  containing strings such as `[read]` is not cache evidence;
- process start, Vitest start, first perf test start, and process finish are
  finite, non-negative, and monotonic;
- the perf report contains passing, exactly-once test IDs disjoint from the
  ordinary report, and the ordinary coverage directory digest is unchanged;
- lifecycle identity matches source commit/worktree fingerprint, Node, Vitest,
  Vite, config digest, relevant environment, and project identity.

Missing, corrupt, mismatched, or non-monotonic evidence fails the perf step. A
missing or corrupt individual transform entry is removed and rebuilt; an
identity or lifecycle mismatch is never reused.

## Isolation and rollback

The cache does not contain test results, module singleton state, mocks, globals,
coverage payloads, or pass evidence. To diagnose a cache-specific problem, omit
`FSUSBLOG_VITEST_TRANSFORM_CACHE_PATH` and
`FSUSBLOG_VITEST_TRANSFORM_CACHE_IDENTITY` from the production Vitest config
invocation. This restores an independent cold perf process without changing the
perf case or benchmark budget and does not require restarting the application.

## Remaining release evidence

Focused contract tests prove identity invalidation, lifecycle transitions,
safe repair, exact/disjoint IDs, coverage immutability, debug-event provenance,
and timing validation. Closing #1068 still requires the authoritative
`./tools/test.sh production --fresh` run and at least three same-machine,
same-SHA before/after samples for perf process startup, time-to-first-test,
frontend bundle wall-clock, and total Production wall-clock. This document does
not substitute focused results for that release evidence.
