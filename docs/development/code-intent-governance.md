# Code intent governance

The sole code-style authority remains [Coding conventions](coding-conventions.md). This document records constraints, public contracts, and performance evidence that syntax alone cannot express as machine-verifiable code intent; it does not create a second style standard.

## When comments are required

Ordinary internal helpers do not require comments. Keep a short comment only when removing it would hide one of these boundaries from maintainers, and place it before the statement it explains:

- ownership/lifetime for pooled buffers, leases, disposal, and callbacks;
- when sensitive bytes are cleared;
- unsafe code, ABI, wire layout, compatibility markers, and copy/no-copy boundaries;
- concurrency, backpressure, fail-open/fail-closed behavior, and deliberate locks, validation, or branches;
- cache hit/miss/cold/warm boundaries;
- workaround exit conditions, benchmark comparison paths, and deliberate non-goals.

Prefer these searchable markers:

| Marker | Meaning |
| --- | --- |
| `OWNERSHIP:` | Who owns a resource, when ownership transfers, and when it is released |
| `SECURITY-INVARIANT:` | A clearing, validation, or failure policy that must not be weakened |
| `PERF-INVARIANT:` | A source-proven structural boundary protected by evidence |
| `COMPATIBILITY:` | Why an external wire/ABI/storage identity must remain unchanged |
| `MEASUREMENT:` | Which producer, policy, and machine evidence support the conclusion |
| `NON-GOAL:` | A path the change explicitly does not claim to improve |

Markers are not decoration. `tests/governance/code-intent-registry.json` must bind high-value markers to existing source paths and symbols; deleting or renaming the implementation makes stale references fail the gate.

## Prohibited comment debt

Source comments must not:

- repeat the next return, assignment, or increment statement;
- append an explanation at the end of a statement;
- record edit dates, fix history, version graduation, or release dates;
- keep a long design history in `/* ... */`;
- make absolute performance claims such as “zero allocation,” “nanosecond-level,” or “physical limit” without an evidence boundary;
- add a TODO/FIXME without a linked open issue and removal condition.

Put history and design rationale in `docs/`; source comments retain only constraints that still hold. Use native structured documentation for public APIs: C# XML documentation, TS/JS TSDoc, TSDoc on Vue props/emits, and C++ Doxygen. Shell/CMake public entry points use adjacent `Contract/Input/Output/Failure` fields. Documentation must describe inputs, outputs, failures, borrow/lifetime, or security boundaries that the type system cannot express.

## TODO lifecycle

The only allowed format is:

```text
TODO(#1234): incomplete reason; removal condition: observable exit condition.
```

The registry entry must contain the path, issue number, `state: open`, the latest live GitHub verification time, and the same removal condition. The checker verifies source/registry presence in both directions, rejects stale verification, and reads the current issue state from GitHub when a TODO exists; an unreadable, missing, or no-longer-open issue fails closed. Delete the TODO and registry entry in the same change when the issue closes, the implementation lands, or the exit condition is met.

## Performance claim levels

| Level | Allowed conclusion | Required authority |
| --- | --- | --- |
| `S` structural | Source-visible copy, allocation, lookup, branch, or lifetime facts | Source path, intent marker, and explicit structural boundary; never upgrade to “measured faster” |
| `M` local measured | Before/after allocation, mean, p50, and p95 on the same machine and runtime | Current commit, Release artifact digest, CPU/OS/runtime identity, raw rounds, iterations, and noise policy |
| `R` route measured | Runtime result for a route/protocol/status/cache/error-frame combination | All `M` conditions plus complete route dimensions and same-source runtime evidence |
| `C` capacity measured | Saturation, capacity, or hardware-counter conclusion | All `R` conditions plus an isolated target/load generator, saturation phase, and real counter authority |

With a stale or wrong SHA, mismatched artifact bytes, missing machine identity, or incomplete statistics, `M/R/C` can only be `blocked`; `S` remains `structural-only` regardless of measurement fields. Absolute performance numbers cannot be inferred from structural facts, cache-miss results cannot be generalized to cache-hit QPS, and application copy reduction cannot be generalized to Redis/socket/filesystem zero-copy.

Source comments and the registry state proof boundaries; they do not replace a benchmark, test, validator, or its raw output. Without corresponding execution evidence, a claim cannot be upgraded to measured even when its wording is correct.

## Registry and checker

`tests/governance/code-intent-registry.json` is the sole machine-readable registry. It contains:

<!-- fsus-doc-claim
claimId: code-intent-governance.intent-entry-count
behaviorId: code-intent-governance
claimType: generated-section
generatedSectionId: governance.intent-entry-count
render: scalar
-->
<!-- FSUSBLOG-GENERATED:BEGIN governance.intent-entry-count -->
16
<!-- FSUSBLOG-GENERATED:END governance.intent-entry-count -->

- comment-scan roots, language extensions, and the reused generated/vendor/fixture/lock/minified classifications;
- unbounded-performance wording gates for public entry documents such as README and the architecture overview;
- `trackedTodos[]`, `publicContracts[]`, and `intents[]`;
- `S/M/R/C` requirements;
- measured-intent producers, policy anchors, evidence paths, required statistics, and non-goals.

Registry `M/R/C` entries record only a `measurement-contract`; they do not statically mark historical prose as currently `measured`. A claim can be upgraded only after a receipt bound to the current commit passes authority validation. Dates/history, TODO/FIXME, and unbounded absolute-performance words receive a high-confidence repository-wide scan; end-of-line, repetition, and long-block rules apply only to registered intent/public-contract surfaces, avoiding mechanical rewrites of protocol literals, language conventions, or unreviewed paths. The semantic registry declares this scope positively; it is not a baseline generated from current errors.

The registry accepts no baseline, maximum-error count, or broad exception. The checker enumerates Git-tracked, nonignored files and excludes only generated, vendor, fixture, lock, and minified classifications defined by authoritative documents; it aggregates all errors instead of stopping at the first. Strings, URLs, SQL literals, and shell expressions are not comment-scan targets.

Run the focused gates:

```bash
node tools/governance/check-code-intent.mjs
node --test tests/tools/code-intent.test.mjs
```

`static-governance` runs both the checker and fixture contract. A fallback checker must not change runtime semantics; if a rule reports a false positive, fix the tokenizer or narrow the semantic classification and add positive/negative fixtures rather than adding a current-state baseline to hide real debt.
