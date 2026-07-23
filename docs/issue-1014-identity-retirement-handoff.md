# Issue #1014 identity retirement handoff

Issue #1014 removes the temporary identity-reset surface and every request-time
fallback that derived an account subject from an internal account id. This handoff
records the current implementation and test ownership only. It does not claim a
production SQL observation, deployed-configuration observation, or unified
validation run. The machine-readable companion is
`tests/backend/legacy-identity-retirement-evidence.json`.

## Current implementation

| acceptance concern | authoritative current path |
| --- | --- |
| physical projection and new writes | `src/backend/Entities/User.cs` maps nullable `account_subject_hash`; `src/backend/Services/UserService.cs` persists the final physical digest inside anonymous-account creation rather than leaving a request-time derivation path |
| cached account reads | `src/backend/Services/UserService.Ports.cs` accepts only snapshots with a valid physical `AccountSubjectHash`, versions the namespace as `account:subject-v1:*`, and never calls `AccountSubjectHasher.Create` while serving reads |
| notification admission | `src/backend/Infrastructure/NotificationStream/NotificationStreamAdmissionService.cs` reads the physical projection through `AccountSubjectHashRequirement`; a missing or malformed value returns `401 account_subject_invalid` before blacklist lookup |
| binary and credential step-up | `src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs` and `src/backend/Services/Security/UserSecurityStepUpService.cs` accept only the physical projection and return `ACCOUNT_SUBJECT_REQUIRED` when it is unavailable |
| one-time destructive reset | no current production definition, DI registration, lifecycle task, or environment-driven bootstrap branch for `LegacyIdentityColdStartResetOperation` exists; the deleted mixed source-contract suite remains named only in the historical test-retention replacement manifests |
| rolling data cutover | `src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs` registers `20260711-pre-account-subject-hash-expand`; `src/backend/Infrastructure/SchemaMigration/AccountSubjectHashBackfillStep.cs` owns the resumable canonical C# backfill used by `20260711-post-account-subject-hash-backfill` |
| permanent readiness boundary | `src/backend/Infrastructure/Auth/AccountSubjectHashInvariantGate.cs` counts null, blank, or malformed projections; `src/backend/Infrastructure/Bootstrap/LifecycleHostedBootstrapService.cs` runs it immediately after schema migration and before AOT cache, search, or cache initialization |
| runbook | `docs/anonymous-identity-smoke-flow.md` documents a non-destructive expand/backfill/readiness sequence and the exact permanent-gate zero-count query |

The physical column remains nullable at the model/expand boundary for rolling
compatibility. That does not make null a supported runtime state: the backfill,
assertion step, permanent startup gate, token issuer, binary auth, notification
admission, blacklist, and account-state cache all fail closed.

## Direct behavior ownership already present

- `tests/backend/Unit/UserServiceValidationTests.cs` covers anonymous-account writes
  with and without a public handle and verifies that the final physical projection is
  persisted in the creation transaction.
- `tests/backend/Unit/AccountSubjectHashProjectionTests.cs` covers the physical entity
  mapping, stable projection semantics, malformed-value rejection, and cache read
  behavior without `AccountSubjectHasher.Create`.
- `tests/backend/Integration/AccountSubjectHashMigrationIntegrationTests.cs` executes
  the PostgreSQL backfill, idempotency, durable keyset resume, format constraint, and
  permanent invariant gate against a real test database.
- `tests/backend/Unit/SchemaMigrationRegistryTests.cs` owns the additive Expand and
  canonical Backfill descriptor shapes.
- `tests/backend/Unit/NotificationStreamBoundaryTests.cs` contains
  `Admission_MissingPhysicalSubjectFailsClosedWithoutBanLookup`.
- `tests/backend/Unit/BannedUserMiddlewareIdentityKindTests.cs` contains
  `InvokeAsync_AccountWithoutPhysicalSubjectClaimFailsClosedBeforeLookup`.
- `tests/backend/Unit/LifecycleHostedBootstrapServiceTests.cs` contains
  `StartAsync_ChecksPhysicalAccountSubjectProjectionAfterSchemaMigration` and
  `StartAsync_StopsRemainingTasks_WhenAccountSubjectProjectionIsIncomplete`.
- `tests/backend/Unit/JwtHelperTests.cs` contains
  `GenerateAccessToken_MissingPhysicalSubjectFailsClosed`.

`tests/backend/Unit/RecoveryKeyServiceTests.cs` does **not** currently assert the
`ACCOUNT_SUBJECT_REQUIRED` branch. It owns recovery endpoint shape, rate-limit,
no-store, request identity, and unified step-up delegation. Direct fail-closed
behavior is instead owned by
`UserSecurityStepUpServiceTests.MissingOrMalformedPhysicalSubject_FailsClosedBeforeProofValidation`
and
`UserIdentityRetirementBinaryEndpointTests.MfaChallengeStart_MissingOrMalformedPhysicalSubjectReturnsAccountSubjectRequired`.
The latter invokes the real mapped RouteEndpoint delegate and decodes its AEDS
`ApiError`; neither test substitutes source-text inspection for runtime behavior.

The issue's exact repository-residue command is intentionally left for the unified
validation phase. Historical governance artifacts legitimately retain the deleted
symbol and test names: `docs/planning/dead-code-audit-index.json`,
`tests/test-retention-replacements.json`, and the #1036 retention handoff. A later
residue check must distinguish those audit records from a live production definition,
DI registration, lifecycle invocation, or operations control; a raw repository-wide
zero-match claim would be false.

## Unified fail-closed stage gate

`docs/dead-code-audit-tracking.md` and
`docs/planning/dead-code-audit-index.json` now use the same four trigger ids:

1. `physical-account-subject-expand-backfill-verified`;
2. `production-account-subject-invalid-count-zero`;
3. `retired-identity-reset-surface-and-control-absent`;
4. `full-issue-verification-complete`.

All four remain unsatisfied. Source and test implementation paths are inspectable,
but no executed integration result, production SQL observation, deployed control
inventory, residue report, backend summary, or Playwright summary was produced in
this pass. The non-destructive replacement cannot be used to invent historical
reset-completion evidence.

## Documentation update list

- `docs/anonymous-identity-smoke-flow.md`: non-destructive migration and production
  zero-count/readiness procedure.
- `docs/api/design.md` and `docs/api/contracts.md`: the physical subject projection,
  token/binary semantics, and fail-closed boundary.
- `docs/security.md` and `docs/architecture.md`: runtime consumers, cache namespace,
  permanent startup invariant, and admin-plane separation.

## Risk and no-restart recovery

- A candidate with an incomplete projection must remain out of traffic. Repair or
  resume the exact backfill, confirm the invalid-count query is zero, and retry
  candidate startup; do not restore an id-derived subject or destructive reset.
- If an old account snapshot lacks the physical field, invalidate that versioned
  snapshot and let the supported PostgreSQL projection reload. No process-wide cache
  flush or server restart is required on already healthy nodes.
- If notification or binary requests reject a historical session, keep current nodes
  serving, repair the data projection, then require reauthentication so a new token
  carries the persisted subject.

## Deferred external acceptance

The following still require real release evidence and cannot be inferred from source:

1. the production zero-count query for null or blank subject projections;
2. confirmation that the retired environment control is absent from the deployed
   operations configuration, not only from this repository;
3. an executed residue report that distinguishes historical audit records from live
   production/DI/lifecycle/operations definitions;
4. the unified backend and Playwright runs requested by the issue.

No test, build, lint, restore, syntax, migration, SQL, browser, or deployment command
was executed while authoring this handoff.
