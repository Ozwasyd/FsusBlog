## Linked Issue

Refs #2179

Related to [#2178](https://github.com/Ozwasyd/FsusBlog/issues/2178) and [#2177](https://github.com/Ozwasyd/FsusBlog/issues/2177). All remain open.

## Scope Summary

The canonical comment observer previously read only the first moderation queue page and newest reply-message page, and relied on a timeline Consistent flag without reconstructing event continuity. This cumulative change shares the existing production initial-outbox/revision constructors, extends the existing fixture owner with formal-command mutation and separate read-only delivery observations, and composes the released queue/reply readers and timeline verifier.

Published candidate: `86b02bc431251901d3ebba0306a371903b1d0bf7`. This successor changes only the naming manifest: three required paths are added; both existing exception entries and reasons are preserved. Production/test source remains exactly identical to tested `1f218e33afb889afd4b321ac4eb612d2ac9dd809`; its 16-case receipt retains that original binding and is not reissued for this metadata-only successor.

Original integration baseline: `9d50f803f0eced061e7a0b2d369f7dbdd711000e`. Fetched master: `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. PR merge-base: `1cd4e060acedfd7838a477842685e0052d8e4107`. The complete cumulative PR delta is 18 files, 2202 insertions and 62 deletions:

| Path | Added / removed |
|---|---:|
| `artifacts/change-contract/issue-2177-initial-outbox-source-external-naming.json` | 26 / 0 |
| `docs/architecture/comment-command-boundary.md` | 38 / 0 |
| `docs/testing.md` | 59 / 0 |
| `src/backend/Services/CommentAuthorManagementService.cs` | 18 / 27 |
| `src/backend/Services/CommentService.cs` | 41 / 29 |
| `src/backend/Services/Fixtures/CommentFixtureQueuePageReader.cs` | 89 / 0 |
| `src/backend/Services/Fixtures/CommentFixtureReplyMessagePageReader.cs` | 83 / 0 |
| `src/backend/Services/Fixtures/CommentFixtureTimelineVerifier.cs` | 51 / 0 |
| `src/backend/Services/Fixtures/CommentThreadFixturePort.Delivery.cs` | 199 / 0 |
| `src/backend/Services/Fixtures/CommentThreadFixturePort.Mutations.cs` | 306 / 0 |
| `src/backend/Services/Fixtures/CommentThreadFixturePort.cs` | 22 / 6 |
| `tests/backend/Unit/CommentAuthorManagementServiceTests.cs` | 27 / 0 |
| `tests/backend/Unit/CommentFixtureMutationRoutingTests.cs` | 531 / 0 |
| `tests/backend/Unit/CommentFixtureQueuePageReaderTests.cs` | 207 / 0 |
| `tests/backend/Unit/CommentFixtureReplyMessagePageReaderTests.cs` | 177 / 0 |
| `tests/backend/Unit/CommentFixtureTimelineVerifierTests.cs` | 159 / 0 |
| `tests/backend/Unit/CommentInitialOutboxContractTests.cs` | 112 / 0 |
| `tests/backend/Unit/CommentRevisionContractTests.cs` | 57 / 0 |

The source branch has not incorporated later unrelated master changes. A two-tree comparison is not the PR merge-base delta; no rebase, conflict resolution or merge was performed.

### Released component provenance

| Component | Supplied SHA | Incorporated SHA |
|---|---|---|
| queue reader | `cd68d64d5eca7a49ce9d40b0be88d5edb997a422` | `cd68d64d5eca7a49ce9d40b0be88d5edb997a422` |
| reply reader | `96c6d47696147456954dcc4b1f156a1dcef6dcaf` | `315953c40d1297a9fe79cf3b602e3007c48bc4da` |
| timeline verifier | `890efc138bc1c91e876fa186c8dcc1b836865f4d` | `1e790bd9f15d4b0a84ccdc6d18cc94abcadf5ee7` |

All six component source/test files remain byte-identical to their supplied commits. The coordinator reported 6/8/7 component cases at those original SHAs; those receipts are not rebound to this candidate.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible

Public C# constructor and fixture observation surfaces are extended. Existing wire/ABI/database names and AdminQueueFirstPage serialized spelling are preserved.

## Tests Run

- [ ] `./tools/test.sh fast`
- [x] Targeted backend tests: original backend project, locked restore and NuGet audit, SDK10.0.302/runtime10.0.10; 16 passed, zero failed/skipped/extra, exit0 at `1f218e33afb889afd4b321ac4eb612d2ac9dd809`.
- [ ] Targeted frontend checks
- [x] Other: metadata-only successor manifest JSON syntax, trusted naming schema, complete changed-surface roster, offline proposed PR contract, complete cumulative commit range and diff checks. These are local offline checks, not live GitHub checks or full acceptance.

The backend project and compilation exclusions were unchanged. Existing audit/compiler warnings remain in the raw log. No backend tests are rerun for the metadata-only correction; generated/output, SDK and restored execution files and all remaining tracked inputs are compared without rebinding the original receipt.

### Exact original caller cases

```text
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.CallerCancellation_StopsBeforeReadOrCommand
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_FindsTargetQueueItemAndLeaseBeyondFirstPage
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsOlderReplyMessagesInProductionOrder
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsProductionContractsAndModelsWithoutCommands(eventType: "CommentCreated")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsProductionContractsAndModelsWithoutCommands(eventType: "CommentEdited")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsProductionContractsAndModelsWithoutCommands(eventType: "CommentReplyNotificationRequested")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_RefusesMissingReplyContinuation
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_RefusesPartialQueueWhenCursorRepeats
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationObservation_RejectsBrokenTimelineBeforeCommands
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationObservation_RejectsGrantedAppealTimelineGapAfterCommand
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "appeal")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "edit")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "moderate")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "report")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "review-appeal")
FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority(kind: "soft-delete")
```

### Original backend command

Executed from `/workspace/FsusBlog-2179-queue-caller-integration`, at the original tested SHA:

```bash
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home \
NUGET_PACKAGES=/workspace/.setup/nuget \
DOTNET_CLI_TELEMETRY_OPTOUT=1 \
MSBUILDDISABLENODEREUSE=1 \
/workspace/FsusBlog/.tmp/fixture-chain-preflight-20261008/dotnet302/dotnet test tests/backend/FsusBlog.Server.Tests.csproj -p:RestoreLockedMode=true -p:NuGetAudit=true -m:1 -nodeReuse:false -p:UseSharedCompilation=false --filter 'FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationOnlyEntry_UsesFormalCommandAndRereadsAuthority|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.CallerCancellation_StopsBeforeReadOrCommand|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsProductionContractsAndModelsWithoutCommands|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_FindsTargetQueueItemAndLeaseBeyondFirstPage|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_RefusesPartialQueueWhenCursorRepeats|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_ReadsOlderReplyMessagesInProductionOrder|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.DeliveryObservation_RefusesMissingReplyContinuation|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationObservation_RejectsBrokenTimelineBeforeCommands|FullyQualifiedName=FsusBlog.Server.Tests.Unit.CommentFixtureMutationRoutingTests.MutationObservation_RejectsGrantedAppealTimelineGapAfterCommand' --logger 'trx;LogFileName=caller.trx' --results-directory /workspace/FsusBlog-2179-queue-caller-integration/.tmp/comment-ordinary-composition-20261009
```

The exact positive allowlist was inspected before execution; the selected class has no fixture/lifecycle hook. The assembly diagnostic initializer returned immediately with its opt-in absent. The new controls cover a queue target/lease beyond page one, repeated cursor refusal, older reply ordering, missing continuation refusal, and timeline gaps before/after commands.

### Public original execution evidence

- [Handoff](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/handoff.json)
- [Caller TRX](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/caller.trx)
- [Exact membership](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/trx-membership.json)
- [Command and environment](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/test-command.json)
- [Raw restore/build/test log](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/test.log)
- [Component byte identities](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/component-byte-identity.json)
- [SDK/project/lock/assembly identities](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/runtime-and-build-identities.json)
- [Entire 41-issue status accounting](https://github.com/Ozwasyd/FsusBlog/blob/7598b65bde01d3a47b70f8a0c3842604bdd80424/artifacts/handoffs/comment-ordinary-composition-20261009/assignment-status-update.json)

The original four-file C# style, official whitespace, 9d50-to-1f218 commit range and diff checks remain recorded at their original SHA. Historical results are not current native/terminal acceptance evidence.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

Not applicable: no rendered UI changes.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

Recorded C# checks cover four caller/test files at the original tested SHA. This correction adds three JSON paths and preserves formatting; it introduces no mechanical-only commit requiring blame registration.

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/issue-2177-initial-outbox-source-external-naming.json

The manifest binds exactly eight registered C# paths under environment-variable and one maintained command-boundary document under css-like-contract. Both existing reason texts and all prior paths remain unchanged. The three readers/verifier paths are required by the trusted src/**/*.cs naming surface; this correction introduces no environment-variable spelling change and modifies no policy.

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

Command-boundary and testing docs distinguish shared constructors, complete traversal, authority observation and native acceptance. No new TODO/FIXME is introduced.

## Compatibility And Risk

- [x] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [x] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

Queue page/item/lease budgets, opaque cursors and terminal-page counts remain intact. Repeated cursors/items, cancellation and exhausted budgets refuse partial output. Full traversal is not an atomic snapshot. Reply identity and production ordering remain intact: initial absence stays absent, but invalid or missing continuation refuses output. Exact revision-history checks remain; the granted-appeal gap is rejected without repairing production events or policy.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: performance or native-delivery claims

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: compose complete canonical comment fixture observations

Required publication label: release-note:internal. The offline proposed contract uses that label; it is not evidence that a live label was written.

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

No generated regions or policy outputs change.

## Rollout / Rollback

- Rollout: draft source review only; no deployment, issue closure, merge or auto-merge.
- Rollback: revert the manifest correction if its declared paths are invalid; keep source and original evidence. Revert caller composition with its documentation if observation behavior regresses.
- Deferred work: qualified initial refs/permissions; native atomic audit/outbox/capability rollback; sealed event/revision coordinates and owner1653 current-run queue/cache/stream/recipient terminal evidence; independent fixture verification; coordinated conflict resolution and separate final merge review.
- Known limitations: ordinary read-port mocks do not qualify native delivery; granted-appeal continuity remains defective and refused; initial observation entry was compiled only; broad Comment suites, held receipt/cohort/artifact/alias/race/TOCTOU audits and matrix gates were not run. The remaining #3576 publication gates and #2046 authority contracts remain open.

## Notes For Reviewers

All findings and receipts retain their exact source bindings. The offline proposed PR body is metadata validation only, using trusted master policy and a planned release-note label. A live exact-head PR/body/label check is still the coordinating root's responsibility. No complete-chain acceptance or merge authorization is asserted.
