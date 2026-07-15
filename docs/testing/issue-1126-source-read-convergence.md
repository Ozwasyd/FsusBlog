# Issue #1126 source-read convergence

Backend tests must not infer production behavior by reading implementation source and matching text. The #1126 migration replaces every violation reported by `tools/check-test-suite-convergence.mjs`, not only the original public-article test file.

The retained evidence is executable or owned by a production-consumed internal contract:

- public article reads expose the prepared-query behavior and fixed ordinals; projection publication executes `upsert -> shadow parity -> artifact write`, and unavailable publication executes `mark unavailable -> artifact removal`;
- mutation event names, admin backfill actions, active-release SQL, metric names, advisory locks, and worker operation scopes have one owner used by the runtime path;
- schema migration transaction wrapping is executed through a testable production helper;
- VisitLog tests inspect SQL captured from `PersistAggregatesAsync`, while the PostgreSQL privacy test verifies the resulting aggregate rows;
- the AEDS cross-language test executes the protocol generator in `--check` mode instead of parsing the C++ header;
- PostgreSQL integration verifies the public projection query plan, visibility boundary, durable pause/resume, outbox retry edges, and fenced commits.

Issue-specific retention manifests must use the same current replacement test IDs as `tests/test-retention-replacements.json`. A replacement test rename therefore requires updating both declarations in the same change; stale duplicates are a convergence failure, not an allowed historical alias.

Focused verification for this migration is:

```bash
node tools/check-test-suite-convergence.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter "FullyQualifiedName~PublicArticleProjectionContractTests|FullyQualifiedName~ActiveReleaseFenceAvailabilityTests|FullyQualifiedName~ActiveReleaseFenceDurableWitnessTests|FullyQualifiedName~ActiveReleaseFencedCommitTests|FullyQualifiedName~AedsProtocolCrossLanguageTests|FullyQualifiedName~SchemaMigrationDdlPrimitivesTests|FullyQualifiedName~VisitLogProcessorServiceTests"
```

The PostgreSQL slice additionally runs `ActiveReleaseFencedCommitIntegrationTests`, the two public-projection methods in `SchemaMigrationIntegrationTests`, and `HumanReadProofPersistencePrivacyTests`. No checker filter, waiver, or source-string fallback is part of acceptance.
