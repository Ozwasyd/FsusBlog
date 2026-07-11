# Rate limiter rejection sampler operations

This runbook is the verification and handoff companion for issue #1055. It does
not record a pass result. The implementation was intentionally landed without
running tests, builds, linters, restores, syntax checks, or profilers.

## Evidence contract

The machine-readable plan is
`tests/backend/issue-1055-rate-limiter-rejection-sampler-evidence.json`. A fresh
verification must preserve all of the following:

1. the matched and unmatched 10,000-path cases retain exactly two buckets and
   only four writes per logical route;
2. 10,000 unique logical buckets retain exactly the configured capacity and
   return `DropCapacity` for every excess bucket;
3. 20,000 concurrent same-bucket samples produce exactly four writes;
4. a 20,000-request cross-minute fan-in publishes only one new window and
   retains no more than the configured capacity;
5. the saturated 4096-bucket capacity-drop p95 is no more than eight times the
   saturated 64-bucket p95, with a 0.05 ms per-operation noise floor.

The latency comparison alternates small/large measurement order, prewarms both
states, measures 64 batches of 512 preallocated subjects, and divides batch
duration by operation count. It measures the actual rejected-new-bucket path;
it is not a source-shape assertion. A failure must remain a failure—do not widen
the budget without attaching fresh machine and run evidence.

## Commands for the later verification phase

Focused behavior and pressure coverage:

```text
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter FullyQualifiedName~RateLimiterRejectionRiskSamplerTests
```

The matrix-owned concurrency selection also includes the cross-minute,
same-bucket, and latency cases through `Category=Concurrency`:

```text
tools/test/legacy-test.sh backend-concurrency
```

The parameterized BenchmarkDotNet profile compares the identical capacity-drop
operation at 64 and 4096 retained buckets and records allocation data. The
shared `benchmarks/core/Program.cs` currently belongs to another thread; its
handoff must first append `RateLimiterRejectionSamplerBenchmarks` to
`BenchmarkSwitcher.FromTypes`:

```text
dotnet run --project benchmarks/core/FsusBlog.Core.Benchmarks.csproj \
  -c Release -- --filter '*RateLimiterRejectionSamplerBenchmarks*'
```

These commands are documentation only in the current implementation phase; no
result is asserted here.

## Operator signals and response

The existing `rate_limiter_risk` sampled/dropped security events remain
low-cardinality. A drop increase can mean either the four-write bucket limit or
the global capacity boundary. Investigate it together with the normal
`rate_limited` rejection rate and edge-gateway metrics; never add raw path or raw
IP metric tags.

When capacity pressure is active:

- leave the in-process hard cap enabled;
- tighten existing gateway route-family limits if immediate containment is
  required;
- confirm 429 latency remains stable and normal requests are not starved;
- capture a fresh focused test result and production-profile evidence before
  changing the cap;
- treat missing or stale evidence as blocked, not passed.

## Shared governance handoff

The main thread owns `tests/coverage-registry.json`, `tests/matrix.yml`,
`tests/backend/Fixtures/backend-test-requirements.json`, and
`tools/test/lanes/static-governance.sh`. Exact deferred edits are in
`tests/backend/issue-1055-rate-limiter-rejection-sampler-evidence.json`.
No new static source checker is required: #1055 is proved by executable behavior
and pressure tests, so `static-governance.sh` should remain unchanged.
