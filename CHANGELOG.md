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

### Fixed

### Security

Release tooling archives this section without deriving or incrementing a product version. Historical product-version entries remain in [the legacy backend changelog](src/backend/CHANGELOG.md) without fabricated ReleaseId mappings.
