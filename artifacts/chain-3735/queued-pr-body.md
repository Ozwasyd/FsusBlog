## Linked Issue

Refs #3735

## Scope Summary

- Connect private Canvas endpoints and typed AEDS browser transport to the existing sole Server document/operation/reference authority; preserve Shared contract ownership and canonical article transactions.
- Integrate owned property definition/value primitives and their canonical article participant, scoped read, additive migrations and immutable receipts. Read payload v2 now requires authorized owner/site/schema even for empty results; the client binds the article/scope and re-reads after a canonical save receipt, refusing a raced revision.
- Integrate the exact parent-supplied ordinary Snapshot/Graph/Bulk/SavedView source increments under their canonical owners. Supply the real Snapshot Server transport, DI, source identity and migration/runtime registration. Retain Snapshot QA hold, failed reset qualification and all unavailable production adapters.
- Refresh the three metadata products through official producers using the actual compiled 9bb observer. Scope DTO verification is a separate actual Shared DLL reflection gate because OpenAPI observes frame references rather than DTO fields.
- Root assignment is 70 retained issues (62 execution, eight tracking), with 53 explicitly transferred. No issue is fully accepted or closed; tracking issues aggregate evidence only. Related to [#3736](https://github.com/Ozwasyd/FsusBlog/issues/3736), [#3738](https://github.com/Ozwasyd/FsusBlog/issues/3738) and [#2323](https://github.com/Ozwasyd/FsusBlog/issues/2323).

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: breaking

## Tests Run

- [ ] `./tools/test.sh fast`
- [x] Targeted backend tests: exact 9bb full canonical Release build passed with zero errors and 1522 warnings; fresh focused Snapshot/RuntimeRollup 48/48 passed. Exact c3 executed 653 units (652 pass, one strict SQL parity failure), 18 PostgreSQL cases passed; the unchanged strict SQL test subsequently passed on 9bb. Component wire reuse remains bound to the actual c3 91-run rather than invented newer execution. New exact 54f stamped full build passed (zero errors, 1522 warnings); actual358/358 units passed (ReadV2 91 + SnapshotABI53 + property214), zero skips, exact actual DLL source metadata and all input hashes stable.
- [x] Targeted frontend checks: ordinary new property API boundary 52/52 passed using actual client/registry/v2 codecs with only network/native-extraction mocks; strict standalone codec/frame types passed. Full API/test import closure still fails with the same 195 diagnostics, zero added and zero direct owned errors. Snapshot HTTP 23 plus Canvas API 11 passed against actual generated route bytes. Local FsusUI source is diagnostic evidence, not published-package parity or formal baseline qualification.
- [x] Other: actual native dispatcher exercised 87 property v2 goldens (24 valid, 63 negative, including all 35 exact original-family samples retained as retired-family negatives); combined Node/native ten tests passed. Official producer checks, scoped C# style and standalone generated TypeScript checks passed. Both 9bb and fresh54f compiled observers registered290 operations and passed seven self-tests/matrix parity. Fresh54f actual Shared reflection proved requiredScope/types/wire2. All three products were byte-identical and official no-rebuild sync passed; its failed unreferenced Migration dependency probe is preserved separately. Formal runtime/HTTP/session/UX and full CI acceptance remain open.

## UI Evidence

- [x] Screenshots or video attached for UI changes
- [x] Mobile layout checked
- [x] Dark mode checked
- [x] Accessibility and reduced-motion impact considered

Independent display checks bind committed057c2066 and actual local FsusUI f2b3bb89. Four screenshots inspected at1440×900 light and390×844 dark. Pager y58–98, selected9999 fully inside the owned list, row/pager/external focus, actions, same-page selection, reorder, shrink, empty and repeated10k display controls pass. Old062 offscreen negative is retained. This is scoped component evidence with synthetic display props, not authenticated Canvas, Server/HTTP/PG or full mobile workspace acceptance. Evidence: `.tmp/chain-3735/ui-evidence/outline-pagination-reachability-final/`.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

Scoped repository style and official dotnet whitespace checks pass for new owners. There is no format-only change requiring blame-ignore registration. Commit-range policy currently fails: some published own commits used unsupported authoring/canvas scopes, and supporting imports lack a usable Refs footer in the resulting message. This failure is retained; published history is not rewritten or waived.

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/issue-3735-canvas-external-naming.json

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

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

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no performance claim; bounded synthetic display checks do not prove product performance

## Release Note

- Audience: user-facing
- Category: Added
- Summary: connect remote canvas and canonical article links

## Generated Output

- Generator source: eslint.config.mjs, src/backend/Modules/Endpoints/AuthoringCanvasEndpoints.cs, src/backend/Modules/Endpoints/AuthoringEndpoints.ArticleCanvasLinkRoutes.cs, src/backend/Modules/Endpoints/AuthoringEndpoints.ArticlePropertyValueRoutes.cs, src/backend/Modules/Endpoints/AuthoringEndpoints.WorkspaceSnapshotRoutes.cs, src/backend/Modules/Endpoints/AuthoringEndpoints.cs, src/backend/Services/Authoring/ArticlePropertyDefinitionContracts.cs, src/backend/Services/Authoring/ArticlePropertyDefinitionCoreModels.cs, src/backend/Services/Authoring/AuthoringWorkspaceSnapshotStore.cs, src/backend/Services/Authoring/IArticlePropertyValueAuthority.cs, src/core/Cache/PodBinaryCodec.AuthoringCanvas.Generated.cs, src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts, src/frontend/wasm/aeds/include/authoring_canvas_wire.generated.hpp, src/migration/Definitions/ArticleCanvasLinkMigrationDefinitions.cs, src/migration/Definitions/ArticlePropertyValueMigrationDefinitions.cs, src/migration/Definitions/AuthoringWorkspaceSnapshotMigrationDefinitions.cs, src/migration/OfflineMigrationClassificationFacts.cs, src/migration/SchemaMigrationManifest.cs, src/shared/Contracts/ArticleProperties/ArticlePropertyValueContracts.cs, src/shared/Contracts/ArticleProperties/ArticlePropertyValueReadContracts.cs, src/shared/Contracts/Articles/ArticleCanvasLinkContracts.cs, src/shared/Contracts/AuthoringCanvas/AuthoringCanvasDocumentContracts.cs, src/shared/Contracts/AuthoringCanvas/AuthoringCanvasOperationContracts.cs, src/shared/Contracts/AuthoringCanvas/AuthoringCanvasReferenceContracts.cs, src/shared/Contracts/AuthoringCanvas/AuthoringCanvasTransportContracts.cs, src/shared/Contracts/AuthoringWorkspace/AuthoringWorkspaceSnapshotContracts.cs, src/shared/Contracts/AuthoringWorkspace/AuthoringWorkspaceSnapshotTransportContracts.cs, src/shared/Contracts/Validation/aeds-endpoint-contracts.json, src/shared/Contracts/Validation/aeds-protocol.json, src/shared/Contracts/Validation/article-canvas-link-wire.json, src/shared/Contracts/Validation/article-property-value-read-wire.json, src/shared/Contracts/Validation/authoring-canvas-wire.json, src/shared/Contracts/Validation/authoring-workspace-snapshot-wire.json, tests/fixtures/protocol/article-property-value-read-wire-v1-retired.json, tests/frontend/fixtures/cross-stack-contract-matrix.json, tools/contracts/format-generated-property-value-read-typescript.mjs, tools/contracts/generate-article-canvas-link-golden.mjs, tools/contracts/generate-article-canvas-link-wire.mjs, tools/contracts/generate-article-property-value-read-golden.mjs, tools/contracts/generate-article-property-value-read-wire.mjs, tools/contracts/generate-authoring-canvas-wire.mjs, tools/contracts/generate-authoring-workspace-snapshot-golden.mjs, tools/contracts/generate-authoring-workspace-snapshot-wire.mjs, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.ts.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.cs.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.ts.inc, tools/contracts/workspace-snapshot-wire-templates/primitives.cs.inc, tools/contracts/workspace-snapshot-wire-templates/primitives.hpp.inc, tools/contracts/workspace-snapshot-wire-templates/primitives.ts.inc, tools/frontend/style-toolchain/eslint.config.mjs, tools/frontend/style-toolchain/package-lock.json, tools/frontend/style-toolchain/package.json, tools/schema/generate-article-property-value-runtime-tables.mjs, tools/schema/generate-authoring-workspace-snapshot-runtime-tables.mjs
- Generated outputs: src/backend/Infrastructure/SchemaMigration/ArticlePropertyValueRuntimeTables.Generated.cs, src/backend/Infrastructure/SchemaMigration/AuthoringWorkspaceSnapshotRuntimeTables.Generated.cs, src/backend/Infrastructure/SchemaMigration/SchemaAllowedExtraLinkNames.generated.cs, src/core/Algorithms/AedsFrameType.cs, src/core/Cache/PodBinaryCodec.ArticleCanvasLink.Generated.cs, src/core/Cache/PodBinaryCodec.ArticlePropertyValueRead.Generated.cs, src/core/Cache/PodBinaryCodec.AuthoringCanvas.Generated.cs, src/core/Cache/PodBinaryCodec.AuthoringWorkspaceSnapshot.Generated.cs, src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts, src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts, src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts, src/frontend/src/codecs/binary/authoringWorkspaceSnapshotWire.generated.ts, src/frontend/src/generated/fsusBinaryRoutes.ts, src/frontend/wasm/aeds/include/aeds_frame.hpp, src/frontend/wasm/aeds/include/article_canvas_link_wire.generated.hpp, src/frontend/wasm/aeds/include/authoring_canvas_wire.generated.hpp, src/frontend/wasm/aeds/include/authoring_workspace_snapshot_wire.generated.hpp, src/frontend/wasm/aeds/include/property_value_read.generated.hpp, src/frontend/wasm/web/protocol/frame.ts, src/migration/OfflineMigrationCatalogEntries.generated.cs, src/shared/AedsFrameHeader.cs, src/shared/Contracts/Validation/fsusblog.openapi.json, tests/backend/Fixtures/aeds-golden-catalog.json, tests/fixtures/protocol/article-canvas-link-wire-golden.json, tests/fixtures/protocol/article-property-value-read-wire-golden.json, tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json, tests/frontend/fixtures/cross-stack-contract-matrix.generated.json
- Digest/evidence: artifacts/change-contract/issue-3735-canvas-generated-binding.json
- Automation identity: none

The binding retains all 27 outputs and 81 declared inputs across the owned incremental producers. Products were generated through their existing owners; the exact original v1 property fixture is retained as a producer input and retired-wire negative. New source and actual compiled observation are separately bound in the evidence ledger.

## Rollout / Rollback

- Rollout: Draft source integration only; no merge, auto-merge, deployment, package publication or incomplete issue closure.
- Rollback: revert each coherent source/contract/output increment together; preserve existing data and immutable revisions/history. No production migration was run.
- Deferred work: formal schema issuer/parser and backup/restore admission; actual qualified PostgreSQL/HTTP/session/PoW/rendered UX; full frontend/local CI; production property/reference/query receivers; qualified zero-write package planner.
- Known limitations: formal schema/runtime admission, canonical current-recipe syntax support, real Writer lifecycle/link producer, qualified FsusUI factory/restore API, production adapters, full types and rendered authenticated UX remain blocked. Exact root3521 authority and historical policy failures are retained in the ledger.

## Notes For Reviewers

Initial verified master baseline: 3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8. Latest fetched origin/master: b9c076e4b763130075218ff9d50f9a6c36784f59. Isolated branch: codex/chain-3735-20261008. Current published source: 54f1c0ab4d3adfd6caf0b92a6d7d2b5309732a38. Preserve precise historical components: c3c0945520fefda4c6d868a999689e192626f25f and 9bb4b1304458d809237043f15d52fdf9bd3efbdd; later commits do not silently inherit whole-candidate acceptance.

Current PostgreSQL 18.6 9bb Snapshot cases passed (two), while the original strict DDL recipe comparison failed (one); all task containers were cleaned. Read-only diagnosis found 80 recipes, 69 extracted and 11 explicitly refused for unsupported current syntax including inline CHECK/arrays. This is an unresolved parser/qualification capability, not an environment-only exception or a passed runtime admission. Actual prior server startup failed before listening; formal schema issuers and real FsusUI restore/session APIs remain unavailable.

Snapshot ordinary race fix supplied as 8f7ac0f357c37966c68ca8607a02f000bf41407a was incorporated as 9bb with a semantic documentation resolution. Its independent QA/harness was refused/withdrawn by the coordinator and remains on hold; ordinary source tests do not clear it. Current outline default remains true and reset refuses unqualified layout; no guessed default-owner ancestor, signed-data rewriting or client-preference deletion was performed.

Commit-range governance failures in already published history and the root3521 release-final source-closure mismatch remain visible; history and policy gates were not rewritten. Published locked FsusUI installation returned E401; real local source f2b3bb89 is only authorized diagnostic fallback against the unchanged formal baseline.

Run identity: chain-3735-20261008. Exact commands, exit codes and artifact locations are retained under .tmp/chain-3735. Durable per-issue accounting and supporting evidence are artifacts/chain-3735/assignment-status-20261008.json and verification-20261008.json. All 70 retained issues remain unaccepted. This PR is draft and cannot be merged, deployed, auto-merged or used to close incomplete issues.

GitHub secondary throttling blocks PR body/comment updates. This local description is queued for review when that restriction is lifted; the remote description has not been patched during the throttle. Code pushes were separately permitted and their exact remote branch SHA verified.
