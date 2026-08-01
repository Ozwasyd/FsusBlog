# Changelog

This is the current repository changelog. Work may be aggregated under `Unreleased`; publishing archives that content under the exact canonical ReleaseId generated for the immutable build.

Product SemVer is not a release coordinate. A published heading must use:

```text
## 20260720143025-32a785eabb20
```

The timestamp and SHA suffix are illustrative. A real heading must equal the build's canonical ReleaseId and remain bound to its UTC creation time and full commit SHA.

## Unreleased

### Added

### Changed

- Product planning, stability, support, issue intake, and release documentation use capability stages, explicit contract classifications, and canonical ReleaseId evidence instead of product SemVer.
- Issue orchestration now treats the external `issue-orchestration.ledger.v1` append-only hash chain as the execution authority and derives DAG state from deterministic projection/recovery; implementer self-testing and independent behavior verification remain separate receipt-bound stages.
- Ready-frontier eligibility now consumes a validated `issue-orchestration.investigation-projection.v1` built from discovery, classification, and dispatch investigation layers; stale, unauthorized, or legacy `node.investigation` authority is rejected fail-closed.
- Layered investigation now deepens only ready-adjacent members, reuses unaffected shallow facts, invalidates dispatch evidence on base/epoch/owner-path drift, and preserves issue-specific contracts when acceptance groups share indexes.
- Stage dispatch now binds request and runtime-observed model, effort, role, sandbox, fork, cwd, Skill and candidate identities; `implementation.started` requires a verified dispatch receipt and `candidate-green` requires the complete v2 `issue-orchestration.implementer-self-test-receipt.v2` rather than a legacy candidate receipt.
- Dispatch/runtime contracts now use v2 request, root-startup, runtime-observation, dispatch-receipt and implementer-self-test schemas. Root actuals are independently verified as `luna-low`; routing is replayed from `stage-model-pool.v2`; missing capability is fail-closed; v1 receipts remain historical-only, and behavior-green requires a fresh read-only `test-owner` v2 receipt.
- Issue orchestration now uses the versioned `issue-orchestration.stage-model-pool-policy.v2` (`stage-model-pool.v2`) manifest: deterministic classification selects role-specific model pools, UI system disputes use a fresh read-only adjudicator, and cleanup green authority remains machine-owned rather than an LLM stage; legacy issue implementer/reviewer/cleanup-verifier aliases and node-local profile authority are retired.
- Trusted Change Contract checkouts now retain full reachable history, and release data-scale evidence must match the current commit, workflow run, attempt, and integration-runtime producer.
- Quality Gate now builds the Wasm release package once per workflow run and requires frontend consumers to download its manifest-, receipt-, and run-bound artifact without historical reuse or consumer rebuild fallback.
- Dispatch selection now produces a deterministic maximal safe batch from strict priority, downstream unlock, critical-path, starvation, acceptance, conflict-key, resource-lease, and stable task-identity evidence; root cannot reorder or rewrite the machine batch.
- Issue orchestration resources now use a versioned registry with same-attempt red/green retention, machine cleanup receipts, dirty-worktree quarantine, crash recovery, and group-owned retention through final group cleanup.

### Fixed

### Security

Release tooling archives this section without deriving or incrementing a product version. Historical product-version entries remain in [the legacy backend changelog](src/backend/CHANGELOG.md) without fabricated ReleaseId mappings.
