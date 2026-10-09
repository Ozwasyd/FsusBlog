Title: feat(backend)!: compose persisted export session authorization and bounded selection
Base: master (a281fb6e9802471c3a44569c3ccab84f88c8d816)
Head: codex/chain-3653-session-authority-integration-20261009
Exact remote SHA: b4c3b71e0bb5578ab9df44998eb599bde5ee0715
Draft: yes
Existing PRs: none found by read-only query

## Linked Issue

Refs #3653

Related to [#2423](https://github.com/Ozwasyd/FsusBlog/issues/2423), [#2425](https://github.com/Ozwasyd/FsusBlog/issues/2425), [#2427](https://github.com/Ozwasyd/FsusBlog/issues/2427), [#2434](https://github.com/Ozwasyd/FsusBlog/issues/2434), [#2436](https://github.com/Ozwasyd/FsusBlog/issues/2436) and [#3578](https://github.com/Ozwasyd/FsusBlog/issues/3578).

## Scope Summary

- The existing HTTP recent-article authority delegates persisted principal/session/article facts and original digest sealing to the sole shared reader. A new explicit session transport rechecks stored job actors without fabricated claims or stored access tokens, and refuses incomplete/invalid DI before mutation. Export routes and workers remain inactive.
- Import the exact four approved supplier files from935dc8871af2b89a97fa3b4214821f70f37ef0c3 and exact seven approved bounded-entry files fromd8e138182d0444f975623c6d52ff39951e57f7ee. Existing source/permission requirements, resource admission, audited locked restore and deliberate exit3/incomplete coverage remain.
- Complete inherited PR diff: **220 name/status records; 223 distinct affected paths**, merge base `be7c53d99b64342925ca63d061bacde34d22ba4c`. This includes all inherited backend, UI, Shared/generated, test, tool and document source. Full exact paths and statuses are appended below and in inventory.json. No scoped check approves this whole range.
- Complete immutable comparison: https://github.com/Ozwasyd/FsusBlog/compare/a281fb6e9802471c3a44569c3ccab84f88c8d816...b4c3b71e0bb5578ab9df44998eb599bde5ee0715

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: breaking

Inherited inputv4/formal SiteScope/frozen fields change source-bound digests; full contract/wire/schema integration requires original owners and does not qualify old inputs. Full inherited Shared/generated changes remain subject to owner review.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Root integration tests: NOT_RUN pending exact denied-scope overlap check and sole Jobs contract consumption.
- [ ] Full frontend/native/provider/storage/HTTP/UI acceptance: not qualified.
- [x] Other: nine changed C# files pass scoped source style and official SDK10.0.302 whitespace; audited locked Server restore and candidate commit/diff checks pass. These are source checks only.

Tested root product source: `ba4681746999eb366aece2175c347665e471515c`. Actual original Server Release build FAIL exit1,326warnings/41errors; every unique error binds to the unconsumed sole Jobs contract SiteScope/scoped usage/resource fence gap. Published head adds exact approved lane source and observation artifacts; no C# source was changed after the compile observation. JSON observation: `artifacts/document-export-integration/session-authority-source-observation.json`.

Coordinating parent supplied real original-project evidence on unchanged supplier935dc887:27/27 unit,8exact methods;29/29 PostgreSQL,6exact methods and original SchemaMigrationPostgresCollectionB. Discovery IDs/counts matched TRX,0fail/0skip, task-owned DB cleanup confirmed. These are supplier results, not root full-integration acceptance; no status-only rerun occurred. Read-only sole Jobs repair4fd5c1 compiles its original Server and test projects, but awaits formal parent consumption. Its first test-project build failed disk full; original negative record was preserved and retry used unchanged source/argv after reclaiming only task-generated copies.

The independently reviewed d8 lane source was consumed exactly; its owner-reported24ordinary source controls were not rerun. Original14method/29row Export selection is not blanket-denied by historical aggregate coupling. Execution requires current exact positive cases, all selected hooks, resource admission, discovery identity/counts and no actual overlap with seven denied scopes. The PostgreSQL29 is a separate integration scope and is excluded by backend-unit's unchanged Category/Fixture rules. No held audit, alternate harness, native acceptance, broad aggregate or testhost was invoked.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

Latest nonvisual changes do not replace inherited UI owner evidence. No rendered acceptance is inferred.

## Coding Convention

- [ ] C# mother-style mapping checked for the complete diff
- [ ] Formatter/linter run for the complete diff
- [x] No tool default overrides repository style
- [ ] Mechanical formatting separated from logic for the complete diff
- [ ] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: original official C#/frontend authorities; current whole-diff verification outstanding
- Formatter version: candidate-specific actual version is recorded above when known
- Formatter command: original scoped `dotnet format whitespace . --folder --include <owned-CSharp-paths> --verify-no-changes --verbosity minimal`
- Formatter idempotence evidence: none (whole inherited range requires owner binding)
- Blame-ignore revision: none claimed by this draft inventory

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/backend-unit-server-selection-external-naming.json for the imported bounded-entry surface; complete inherited naming coverage still requires owner review.

## Documentation / Intent

- [ ] Public API docs updated for the complete diff
- [ ] Ownership/security/performance intent updated for the complete diff
- [x] Historical handoff archived or source-of-truth updated
- [ ] TODO/FIXME references valid issues for the complete diff

## Compatibility And Risk

- [ ] Cross-language coding conventions reviewed for the complete diff
- [ ] Document lifecycle updated for the complete diff
- [ ] External wire / ABI / database / third-party names preserved or explicitly adapted
- [ ] Public API impact reviewed
- [ ] AEDS frame / binary contract impact reviewed
- [ ] Database migration impact reviewed
- [ ] Security, auth, moderation, PoW, or privacy impact reviewed for the complete diff
- [x] Docs updated or a reason recorded: this draft explicitly records pending full review
- [x] Known limitations updated

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: performance or runtime/product acceptance

## Release Note

- Audience: internal
- Category: none
- Summary: none

## Generated Output

- Generator source: inherited canonical tools/contracts and tools/frontend producers; exact binding coverage outstanding
- Generated outputs: all inherited generated surfaces listed in complete PR diff
- Digest/evidence: none approved for the complete range; original owners must bind the actual source/products
- Automation identity: none

## Rollout / Rollback

- Rollout: draft/source handoff only; no activation, merge, auto-merge, issue closure, deployment or master push.
- Rollback: retain frozen source and negative evidence; revert only an authorized owning increment on actual regression. No force-push/delete or cross-chain conflict resolution.
- Deferred work: complete persisted source/property/assets/fonts/renderer/retained input, real catalog/source projections, real worker execution, current native and four-format/product/cleanup acceptance.
- Known limitations: sole Jobs contract formal consumption and current root build remain pending; complete frozen source/property/assets/fonts/renderer authority, source catalog/version/schema/wire and product/native receipts remain open. Original29 must pass its exact scope/hook/resource/discovery preflight before execution.

## Notes For Reviewers

This complete draft template intentionally leaves whole-diff review boxes incomplete. Read-only source absorption/identity is not a merge or acceptance decision. Artifact-only latest commits may inherit real broad source. No fake green, private runtime path or internal session ID is included.

Public dependencies: [#2423](https://github.com/Ozwasyd/FsusBlog/issues/2423), [#2434](https://github.com/Ozwasyd/FsusBlog/issues/2434), [#3653](https://github.com/Ozwasyd/FsusBlog/issues/3653), [#3578](https://github.com/Ozwasyd/FsusBlog/issues/3578), [#2650](https://github.com/Ozwasyd/FsusBlog/issues/2650).3578 still requires qualified sole3644 outputs [#3632](https://github.com/Ozwasyd/FsusBlog/issues/3632), [#3634](https://github.com/Ozwasyd/FsusBlog/issues/3634), [#3636](https://github.com/Ozwasyd/FsusBlog/issues/3636). Shared closure is [71179da](https://github.com/Ozwasyd/FsusBlog/commit/71179da783bae459b665b1ca168a97b718b4b01b).

Next original commands: original scoped source checks; approved bounded-server backend-unit only after current source declaration, exact positive scope/hook overlap, resource admission and discovery preflight. No default whole-suite fallback or alternate runner. Supplier unchanged unit/PG tests are not repeated for status. Acceptance additionally requires current exact candidate real permissions/storage/native CPU/deadline/cancellation/physical cleanup, four-format/private HTTP/download/browser/accessibility and full original CI evidence.

Current source-byte disposition after ordinary composition publication: unique source variants remain. Complete details in inventory.json; no acceptance inferred.

## Complete Candidate Name/Status/Path Scope

Every inherited addition, modification, deletion and rename endpoint from the exact comparison above:

```text
A	artifacts/change-contract/backend-unit-server-selection-external-naming.json
A	artifacts/document-export-integration/job-contract-compatibility.json
A	artifacts/document-export-integration/ordinary-source-composition.md
A	artifacts/document-export-integration/ordinary-source-preimages.json
A	artifacts/document-export-integration/ordinary-source-verification.json
A	artifacts/document-export-integration/private-delivery-handoff.md
A	artifacts/document-export-integration/selected-server29-preflight.md
A	artifacts/document-export-integration/session-authority-source-observation.json
A	artifacts/document-export-integration/session-authority-source-observation.md
A	artifacts/document-export-integration/shared-registration-consumer-handoff.md
A	artifacts/document-export-integration/shared-registration-consumer-verification.json
A	artifacts/shared-registration-current/handoff.md
A	artifacts/shared-registration-current/ordinary-managed/GlobalUsings.cs
A	artifacts/shared-registration-current/ordinary-managed/OrdinaryManaged.csproj
A	artifacts/shared-registration-current/ordinary-managed/packages.lock.json
A	artifacts/shared-registration-current/source-provenance.json
M	src/backend/GlobalUsings.cs
M	src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs
A	src/backend/Modules/Endpoints/Binary/BinaryEndpoints.DocumentExport.cs
A	src/backend/Modules/Endpoints/Binary/DocumentExportEndpointBinding.cs
A	src/backend/Services/Authoring/AuthorRecentArticleHistoryPersistedPermissionReader.cs
A	src/backend/Services/Authoring/AuthoringWorkspaceSnapshotStore.cs
A	src/backend/Services/Authoring/IArticlePropertyValueAuthority.cs
M	src/backend/Services/Authoring/SqlAuthorRecentArticleHistoryPermissionAuthority.cs
M	src/backend/Services/DocumentExport/CanonicalDocumentRendererAdapter.cs
A	src/backend/Services/DocumentExport/DocumentExportAttemptDeadline.cs
A	src/backend/Services/DocumentExport/DocumentExportAttemptResources.cs
M	src/backend/Services/DocumentExport/DocumentExportContractValidator.cs
M	src/backend/Services/DocumentExport/DocumentExportContracts.cs
A	src/backend/Services/DocumentExport/DocumentExportFrozenEmbedSourceBridge.cs
A	src/backend/Services/DocumentExport/DocumentExportFrozenEmbeds.cs
M	src/backend/Services/DocumentExport/DocumentExportHtmlSanitizer.cs
M	src/backend/Services/DocumentExport/DocumentExportHtmlVerifier.cs
A	src/backend/Services/DocumentExport/DocumentExportHttpJobAuthorization.cs
A	src/backend/Services/DocumentExport/DocumentExportRequestFreezer.cs
M	src/backend/Services/DocumentExport/DocumentExportSandbox.cs
A	src/backend/Services/DocumentExport/DocumentExportServiceCollectionExtensions.cs
A	src/backend/Services/DocumentExport/DocumentExportSessionJobAuthorization.cs
A	src/backend/Services/DocumentExport/Jobs/DocumentExportJobPolicy.cs
A	src/backend/Services/DocumentExport/Jobs/DocumentExportJobRepository.cs
A	src/backend/Services/DocumentExport/Jobs/DocumentExportJobService.cs
A	src/backend/Services/DocumentExport/Jobs/README.md
A	src/backend/Services/DocumentExport/README.Transport.md
M	src/backend/Services/DocumentExport/SelfContainedHtmlDocumentExportProvider.cs
M	src/core/Algorithms/AEDS_V2_PROTOCOL.md
M	src/core/Algorithms/AedsFrameType.cs
A	src/core/Cache/PodBinaryCodec.ArticleCanvasLink.Generated.cs
A	src/core/Cache/PodBinaryCodec.ArticlePropertyValueRead.Generated.cs
A	src/core/Cache/PodBinaryCodec.AuthorArticleSelection.Generated.cs
A	src/core/Cache/PodBinaryCodec.AuthoringCanvas.Generated.cs
A	src/core/Cache/PodBinaryCodec.AuthoringWorkspaceSnapshot.Generated.cs
A	src/core/Cache/PodBinaryCodec.DocumentExport.cs
A	src/core/Cache/PodBinaryCodec.UploadAssetPreview.cs
A	src/core/Cache/PodBinaryCodec.WritingAidPreference.cs
A	src/core/Cache/PodBinaryCodec.WritingAidPreferenceReceipt.Generated.cs
A	src/core/Mapping/Models/DocumentExportModels.cs
A	src/frontend/src/api/documentExport.ts
A	src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts
A	src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts
A	src/frontend/src/codecs/binary/authorArticleSelectionWire.generated.ts
A	src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts
A	src/frontend/src/codecs/binary/authoringWorkspaceSnapshotWire.generated.ts
A	src/frontend/src/codecs/binary/documentExportWire.generated.ts
A	src/frontend/src/codecs/binary/writingAidPreferenceWire.generated.ts
A	src/frontend/src/components/document-export/documentExportCall.ts
A	src/frontend/src/components/document-export/documentExportUiPort.ts
A	src/frontend/src/components/document-export/documentExportWireUiPort.ts
A	src/frontend/src/composables/useDocumentExport.ts
M	src/frontend/src/composition/binaryDecoderRegistry.ts
A	src/frontend/src/composition/documentExport.ts
A	src/frontend/src/services/documentExportPrivateDelivery.ts
M	src/frontend/wasm/aeds/include/aeds_decode.hpp
M	src/frontend/wasm/aeds/include/aeds_frame.hpp
A	src/frontend/wasm/aeds/include/article_canvas_link_wire.generated.hpp
A	src/frontend/wasm/aeds/include/author_article_selection_wire.generated.hpp
A	src/frontend/wasm/aeds/include/authoring_canvas_wire.generated.hpp
A	src/frontend/wasm/aeds/include/authoring_workspace_snapshot_wire.generated.hpp
A	src/frontend/wasm/aeds/include/document_export_wire.generated.hpp
M	src/frontend/wasm/aeds/include/pod_views.hpp
A	src/frontend/wasm/aeds/include/property_value_read.generated.hpp
A	src/frontend/wasm/aeds/include/upload_asset_preview_pod.hpp
A	src/frontend/wasm/aeds/include/writing_aid_preference_wire.generated.hpp
M	src/frontend/wasm/aeds/src/aeds_decode.cpp
M	src/frontend/wasm/web/protocol/frame.ts
M	src/shared/AedsFrameHeader.cs
A	src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedFrozenDependencyProjection.cs
A	src/shared/Contracts/ArticleProperties/ArticlePropertyValueContracts.cs
A	src/shared/Contracts/ArticleProperties/ArticlePropertyValueDigest.cs
A	src/shared/Contracts/ArticleProperties/ArticlePropertyValueMutationContracts.cs
A	src/shared/Contracts/ArticleProperties/ArticlePropertyValueReadContracts.cs
A	src/shared/Contracts/Articles/ArticleCanvasLinkContracts.cs
R099	src/backend/Services/Authoring/AuthoringCanvasDocumentContracts.cs	src/shared/Contracts/AuthoringCanvas/AuthoringCanvasDocumentContracts.cs
R099	src/backend/Services/Authoring/AuthoringCanvasOperationContracts.cs	src/shared/Contracts/AuthoringCanvas/AuthoringCanvasOperationContracts.cs
R099	src/backend/Services/Authoring/AuthoringCanvasReferenceContracts.cs	src/shared/Contracts/AuthoringCanvas/AuthoringCanvasReferenceContracts.cs
A	src/shared/Contracts/AuthoringCanvas/AuthoringCanvasTransportContracts.cs
A	src/shared/Contracts/AuthoringNavigation/AuthorArticleSelectionRevalidationContracts.cs
A	src/shared/Contracts/AuthoringPreferences/WritingAidPreferenceContracts.cs
A	src/shared/Contracts/AuthoringPreferences/WritingAidPreferenceReceiptValidator.cs
A	src/shared/Contracts/AuthoringPreferences/WritingAidPreferenceValidator.cs
A	src/shared/Contracts/AuthoringWorkspace/AuthoringWorkspaceSnapshotContracts.cs
A	src/shared/Contracts/AuthoringWorkspace/AuthoringWorkspaceSnapshotTransportContracts.cs
A	src/shared/Contracts/Models/UploadAssetPreviewPod.cs
A	src/shared/Contracts/Models/WritingAidPreferencePods.cs
A	src/shared/Contracts/Outputs/UploadAssetPreviewDto.cs
M	src/shared/Contracts/Validation/aeds-protocol.json
A	src/shared/Contracts/Validation/article-canvas-link-wire.json
A	src/shared/Contracts/Validation/article-property-value-read-wire.json
A	src/shared/Contracts/Validation/author-article-selection-wire.json
A	src/shared/Contracts/Validation/authoring-canvas-wire.json
A	src/shared/Contracts/Validation/authoring-workspace-snapshot-wire.json
A	src/shared/Contracts/Validation/document-export-wire.json
A	src/shared/Contracts/Validation/writing-aid-preference-wire.json
M	tests/backend/Fixtures/aeds-golden-catalog.json
A	tests/backend/Fixtures/document-export-payload-goldens-v1.json
M	tests/backend/GlobalUsings.cs
M	tests/backend/Helpers/DocumentExportTestToolFixture.cs
M	tests/backend/Integration/AuthorRecentArticleHistoryStoreIntegrationTests.cs
A	tests/backend/Integration/DocumentExportSessionJobAuthorizationPostgresTests.cs
A	tests/backend/Unit/ArticleCanvasLinkWireCodecTests.cs
A	tests/backend/Unit/ArticlePropertyValueReadWireTests.cs
A	tests/backend/Unit/AuthorArticleSelectionWireTests.cs
A	tests/backend/Unit/AuthoringWorkspaceSnapshotWireTests.cs
A	tests/backend/Unit/DocumentExportAttemptResourcesTests.cs
A	tests/backend/Unit/DocumentExportBinaryCodecTests.cs
M	tests/backend/Unit/DocumentExportContractTests.cs
A	tests/backend/Unit/DocumentExportEndpointBindingTests.cs
A	tests/backend/Unit/DocumentExportEndpointsTests.cs
A	tests/backend/Unit/DocumentExportFrozenEmbedSourceBridgeTests.cs
M	tests/backend/Unit/DocumentExportHtmlProviderTests.cs
A	tests/backend/Unit/DocumentExportHttpJobAuthorizationTests.cs
A	tests/backend/Unit/DocumentExportJobServiceTests.cs
A	tests/backend/Unit/DocumentExportPayloadBoundsTests.cs
A	tests/backend/Unit/DocumentExportRequestFreezerTests.cs
M	tests/backend/Unit/DocumentExportSandboxTests.cs
A	tests/backend/Unit/DocumentExportSessionJobAuthorizationTests.cs
A	tests/backend/Unit/UploadAssetPreviewCodecTests.cs
A	tests/backend/Unit/WritingAidPreferenceWireTests.cs
A	tests/fixtures/protocol/article-canvas-link-wire-golden.json
A	tests/fixtures/protocol/article-property-value-read-wire-golden.json
A	tests/fixtures/protocol/article-property-value-read-wire-native.cpp
A	tests/fixtures/protocol/article-property-value-read-wire-v1-retired.json
A	tests/fixtures/protocol/author-article-selection-wire-golden.json
A	tests/fixtures/protocol/authoring-canvas-wire-golden.json
A	tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json
A	tests/fixtures/protocol/authoring-workspace-snapshot-wire-native.cpp
A	tests/fixtures/protocol/writing-aid-preference-wire-golden.json
A	tests/fixtures/protocol/writing-aid-preference-wire-native.cpp
A	tests/frontend/unit/services/documentExportPrivateDelivery.test.ts
M	tests/tools/aeds-protocol-generation.test.mjs
A	tests/tools/article-canvas-link-wire.test.mjs
A	tests/tools/article-property-value-read-native.test.mjs
A	tests/tools/article-property-value-read-wire.test.mjs
A	tests/tools/author-article-selection-wire.test.mjs
A	tests/tools/authoring-canvas-wire.test.mjs
A	tests/tools/authoring-workspace-snapshot-native.test.mjs
A	tests/tools/authoring-workspace-snapshot-wire.test.mjs
A	tests/tools/backend-unit-server-selection.test.mjs
A	tests/tools/document-export-registration.test.mjs
A	tests/tools/document-export-wire.test.mjs
A	tests/tools/writing-aid-preference-wire.test.mjs
A	tools/contracts/author-article-selection-wire-templates/wire.cs.inc
A	tools/contracts/author-article-selection-wire-templates/wire.hpp.inc
A	tools/contracts/author-article-selection-wire-templates/wire.ts.inc
A	tools/contracts/document-export-registration.mjs
A	tools/contracts/document-export-wire-templates/wire.hpp.inc
A	tools/contracts/document-export-wire-templates/wire.ts.inc
A	tools/contracts/format-generated-property-value-read-typescript.mjs
A	tools/contracts/generate-article-canvas-link-golden.mjs
A	tools/contracts/generate-article-canvas-link-wire.mjs
A	tools/contracts/generate-article-property-value-read-golden.mjs
A	tools/contracts/generate-article-property-value-read-wire.mjs
A	tools/contracts/generate-author-article-selection-wire.mjs
A	tools/contracts/generate-authoring-canvas-wire.mjs
A	tools/contracts/generate-authoring-workspace-snapshot-golden.mjs
A	tools/contracts/generate-authoring-workspace-snapshot-wire.mjs
A	tools/contracts/generate-document-export-wire.mjs
A	tools/contracts/generate-writing-aid-preference-golden.mjs
A	tools/contracts/generate-writing-aid-preference-wire.mjs
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.ts.inc
A	tools/contracts/workspace-snapshot-wire-templates/primitives.cs.inc
A	tools/contracts/workspace-snapshot-wire-templates/primitives.hpp.inc
A	tools/contracts/workspace-snapshot-wire-templates/primitives.ts.inc
A	tools/contracts/writing-aid-preference-wire-templates/receipt.cs.inc
A	tools/contracts/writing-aid-preference-wire-templates/wire.hpp.inc
A	tools/contracts/writing-aid-preference-wire-templates/wire.ts.inc
M	tools/frontend/generate-aeds-protocol.mjs
A	tools/test/backend-unit-server-selection.design.md
A	tools/test/backend-unit-server-selection.mjs
M	tools/test/lanes/_backend-test-runtime-support.sh
M	tools/test/lanes/_suite-support.sh
M	tools/test/run-migration-tests.mjs
```
