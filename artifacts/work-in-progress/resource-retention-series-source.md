# Resource retention series source WIP

Historical source handoff only. This record is not a policy declaration, runtime
observation, receipt, independent acceptance or qualification authority. Issues
[#1621](https://github.com/Ozwasyd/FsusBlog/issues/1621) and
[#1622](https://github.com/Ozwasyd/FsusBlog/issues/1622) remain open.

## Exact source binding

- Repository: `Ozwasyd/FsusBlog`, physical checkout `/workspace/FsusBlog`.
- Initial saved checkout: clean `work@29051db2a80db7770dfe78a1db6e4c6998337324`.
- Selected base: [draft #4335](https://github.com/Ozwasyd/FsusBlog/pull/4335),
  `codex/issue-2295-seven-reviewed-source-composition-20261014` at
  `1016c633466fb18083a8ac0f6cc56e9bb448b99f`. The exact object was fetched before
  creating the new branch; the remote branch matched that SHA.
- Isolated branch: `codex/resource-retention-series-source`.
- Source commit: `c2c0c156495b4726409fc7dc864faa41d62f1df7`, whose parent is the
  selected base. The final documentation commit and exact PR head are recorded in
  the draft PR body to avoid a self-referential commit digest.
- Only executable source added: `tools/test/resource-retention-series.mjs`.
  The other changed file is this WIP. All existing source, shared probes,
  controllers, policies, schemas, catalogs, fixtures and receipts are preserved.

## Calculation boundary

`summarizeResourceRetentionSeries(input)` is a pure, unconnected source leaf with
no imports, CLI, environment access, timers, filesystem/process/network access,
collector or controller. It consumes observations; it does not generate them.
Every returned summary contains `qualificationEligible: false` and
`evidenceClass: calculation-only`, including when both numerical threshold
comparisons are true. It never returns runtime `status: ok` or a qualifying
receipt. Missing or malformed calculation inputs throw `TypeError`.

Input has exactly `mode`, `contract`, `phases`. Mode is `memory-leak` or
`open-handle`. Samples carry exactly `status`, `monotonicMs`, `value`; status must
be `ok`, and value is a safe integer containing positive RSS bytes or a
non-negative total handle/FD count. A successful count of zero is possible for
handles; collector failures cannot be marked missing and then silently accepted.
This function cannot authenticate a producer's claim of successful collection,
detect a fabricated successful zero or prove actual process identity.

The complete explicit contract contains these fields, with no defaulting:

| Fields | Validation |
| --- | --- |
| `warmupDurationMs` | Memory 60000; handles 30000 |
| `cycleCount` | 5 |
| `loadDurationMsPerCycle` | 30000 |
| `recoveryDurationMsPerCycle` | 15000 |
| `finalRecoveryDurationMs` | 30000 |
| `sampleIntervalMs` | 1000 |
| `loadConcurrency` | 8; a declaration, not evidence of an actual workload |
| `threshold` | Memory 67108864 bytes; handles 16 |
| `minimumSamplesPerLoadCycle` | 25 |
| `minimumSamplesPerRecoveryCycle` | 10 |
| `baselineRecoveryDurationMs` | Required positive safe integer, whole 1000ms intervals; no value supplied here |
| `minimumSamplesPerWarmup`, `minimumSamplesPerBaselineRecovery`, `minimumSamplesPerFinalRecovery` | Each required, positive, safe and no greater than its available slots; no values supplied here |
| `maximumSampleLatenessMs` | Required safe integer in [0, 1000); no value supplied here |

These are local input-validation invariants, not a second policy source. Caller
data cannot stand in for owner-approved, source-bound policy admission. The new
sampling convention is a calculation interface proposed for review, not an
approved execution plan or permission to select the unresolved policy values.

The thirteen phases must be ordered as warmup, baseline recovery, five load and
recovery pairs, final recovery. Phase data has exactly `phase`, `cycle`,
`startMonotonicMs`, `endMonotonicMs`, `samples`. Phase names are `warmup`,
`baseline-recovery`, `load`, `recovery`, `final-recovery`. Cycle is 1 through 5
for load/recovery and null otherwise. All durations are explicit and exact;
adjacent phases must be contiguous, without overlap or gaps.

Windows are half-open [start, end). Sampling slot zero is phase start; every
1000ms slot must have exactly one observation, ordered by slot and within the
explicit maximum lateness. Missing, extra, duplicated, early, late, non-finite,
failed, out-of-window or sparse sample entries are rejected. The minimum counts
of 25/10 never excuse missing slots: full 30/15 slot series are required here.
Warmup, baseline and final sampling must also fill every slot. A recovery window
without any observation in its latter half is rejected.

Recovery median uses actual monotonic timestamps in [midpoint, end), including
the arithmetic midpoint of the two middle values for even counts. Baseline,
each cycle recovery and final recovery use their own latter-half samples. Load
peaks do not enter retained medians. Both calculations preserve signed growth:

```text
maxRetainedGrowth = max(cycleRecovered[1..5], finalRecovered) - baseline
finalRetainedGrowth = finalRecovered - baseline
```

The result includes phase counts, latter-half counts, medians, total duration,
sample count, threshold and separate max/final comparison booleans. It does not
verify load probes, cancellation, actual concurrency, no-load recovery,
identity, platform type counts, policy provenance or sample/receipt digests.

## Missing contracts and HOLD

The selected base still has the old 12-request/two-point resource measurement.
Neither the current resource policy nor the issue definitions supply a complete
baseline recovery duration. This leaf does not change that producer or create a
competing controller. It does not publish an incomplete policy as sealed input.

An independent baseline recovery of duration B would make contiguous totals
315000+B ms for memory and 285000+B ms for handles. The policy owners must resolve
whether baseline recovery is additional or has a fully specified distinct window
inside another phase. This implementation only accepts the explicit additional
phase representation, always unqualified. It does not assume B or reuse warmup,
load or final samples as baseline. The current outer budget declarations do not
resolve this ambiguity or authorize subtracting another phase's duration.

Remaining work belongs to the original owners: complete policy/window definitions
and independent verification; actual sampler and phase controller; structured
load completion/cancellation; exact backend identity re-observation at every
window through [#1623](https://github.com/Ozwasyd/FsusBlog/issues/1623); supported
RSS/handle collectors and type classification; environment admission and forbidden
override checks through [#1626](https://github.com/Ozwasyd/FsusBlog/issues/1626);
and original independent verifiers, receipt/catalog binding and full acceptance.

All runtime execution, tests, test collection/discovery, product-module imports,
DB/native/browser work, frozen receipts/catalogs/fixtures and qualification remain
HOLD under the delegation. No observations were synthesized. No merge, Ready,
issue closure, package publication or safety-setting changes were performed.

## Static verification

On source commit `c2c0c156495b4726409fc7dc864faa41d62f1df7`, Node v24.19.0:

- `node --check tools/test/resource-retention-series.mjs`: exit 0; syntax only,
  without importing or invoking the new module.
- `node tools/frontend/style-toolchain/node_modules/eslint/bin/eslint.js tools/test/resource-retention-series.mjs`:
  exit 0, no diagnostics; targeted source lint using the original repository
  config and rules, without overrides or replacement config. ESLint loads the
  original tooling configuration and local alias helper; it does not run product
  modules or import the calculation module.
- `git diff --cached --check`: exit 0 for the source commit.
- Original change-contract title and source commit-message checks: exit 0.

The original locked style toolchain was installed with `npm ci --ignore-scripts
--prefix tools/frontend/style-toolchain --cache
/tmp/fsusblog-resource-retention-npm-cache --no-audit --no-fund`: exit 0, 257
packages. The first attempt without an explicit cache failed with ENOENT at the
unwritable default cache `/home/agent/.npm/_cacache`; no policy, lock or security
configuration was changed to recover. Dependencies are ignored and uncommitted.

No complete application compilation, complete repository lint or runtime/test
check was run or claimed PASS. No .NET SDK was available on PATH; frontend
application dependencies were absent. Previous #4335 compile/lint results are
historical context only and were not reused as this candidate's validation.
Behavior and negative-case execution remain unverified under HOLD.
