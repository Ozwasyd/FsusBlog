# Exact remaining integration seams

Source `0df1a63682e8e357b397dc1d19cbee30fdc94ef9` is published on
`codex/chain-3582-authenticated-review-transport-20261009`. This is a source handoff,
not a machine receipt, admitted input, execution grant or product acceptance.

## Completed consumer work

- `RuntimeDomainServiceCollectionExtensions.AddFsusRuntimeDomainServices` now calls
  the original `AddFsusArticleVaultProtectedRecoveryStage` after canonical stores
  and readers, only with an explicitly configured opaque Vault site and the
  original application `IAuditRetentionEpochKeyStore` already registered.
  The actual host registers infrastructure keys before domain services. No
  replacement keys, connection pool, storage or schema were added.
- `ArticleVaultRecoveryServiceCollectionExtensions.AddFsusArticleVaultRecoveryReaders`
  registers the new scoped authenticated adapter using the original proposal store
  and `ArticleVaultConflictReviewReader`. Its `ReadFromHttpContextAsync(reference,
  articleId, HttpContext, ArticleVaultResolutionPlanInput, CancellationToken)` maps
  original authenticated claims and **admin_sid**, checks the exact stored document
  and trusted Vault site, and calls original `ReadAsync`. It does not supply current
  facts or replace live permissions or sealed-bundle actor checks.
- `useArticleVaultRecoveryHistory` calls the existing authenticated AEDS historical
  reader. Exact host references and context are required. Context changes and the
  original private-surface transitions synchronously clear/abort old state. Repeated
  reads, ignored aborts, exceptions, stale focus intents and disposal have executable
  controls. History remains historical, with execute/base grants false.

## Release precise interface work to the coordinating parent

These are missing interfaces/composition inputs, rather than a request to wait for
whole issues or all native qualification. Existing canonical owners retain their
implementations. No placeholder port has been added to make a test pass.

| Missing input | Exact consumer / owner handoff | Required shape and limits |
| --- | --- | --- |
| Immutable installation SiteIdentity | Group 4 canonical installation authority; root retains `RuntimeDomainServiceCollectionExtensions` and `ArticleVaultRecoveryServiceCollectionExtensions` consumer hookup | Publish the actual read-only provider/API and exact source SHA returning the nonempty opaque immutable site identity or a real unavailable/refusal result. Consumer needs that value at `AddFsusArticleVaultRecoveryReaders`, `AddFsusArticleVaultCurrentUploadAssetInputs` and authenticated adapter construction. Current `ISystemService` exposes SEO/compliance/page operations, not this identity. Neither SEO BaseUrl/title nor editable config is authority. Permission `SITE_BASEURL` remains a separate namespace. Root has not edited SystemService/SystemConfig or created an identity registry. |
| Legitimate current review input acquisition | Coordinator assigns the trusted acquisition owner; canonical #2120 plan/verification and #2106 materialization owners remain sole owners. Root retains the authenticated adapter and endpoint mapping. | Produce actual `ArticleVaultResolutionPlanInput` for a named immutable `ArticleVaultConflictReviewReference` and authenticated current article, with cancellation: Metadata, Evidence, Git, Decisions, MetadataCandidate, Confirmation, ExpiresAtUnixMs. The original server source/property/upload readers are available and must be consumed, not requested again or reimplemented. Full base/local/server V1 metadata, root/local snapshots, current Git/permissions/coordinates and decision provenance still need actual authorities. This input must be acquired in process before calling adapter `ReadFromHttpContextAsync`; never deserialize it from a browser request or reuse old proposal facts as current. Exact refusal input in tests is not acquisition evidence. |
| Closed current-review AEDS contract | Release canonical cross-stack contract scope to the coordinator's wire owner: `src/shared/Contracts/ArticleVault/`, original `src/core/Algorithms/AedsFrameType.cs` registry and corresponding original ABI/decoder/TS registration paths. Root retains `AuthoringEndpoints.ArticleVaultRoutes.cs` and `src/frontend/src/api/articleVault.ts` consumer hookup. | Request identifies article, resolution operation/digest and optional **exact** canonical operation/checkpoint reference. Auth actor/site/current facts are server-owned. Response is an approved read-only projection of actual `ArticleVaultConflictReviewSnapshot` (Proposal, CurrentEvidence, CurrentValidation, ExecutionAdmission, Checkpoint, PermissionSnapshotSha256), with closed codecs, budgets, registered frame identities and original interoperability/refusal controls. Frames 253/254 are the existing historical contract and must not be silently repurposed. Canonical frame assignment belongs to original registry owner; no new frame number, JSON fallback, DTO, parser or wire grant is invented here. |
| Editor-host exact operation selection | Coordinator supplies canonical selected operation/proposal/checkpoint and Vault/device/document context; root retains actual editor host integration | Existing `useAdminArticleWrite` does not expose canonical Vault operation/checkpoint refs. Mounting either historical host or owner component `VaultStoredConflictReview.vue` requires those real references. Consume the actual owner fields at `6019f3834df477627cd59e55e297cf086ff0bae3` in `components/article-vault/storedConflictReviewPresentation.ts`. Its requestIdentity/context wrapper is host correlation, not wire authority. Do not convert historical response to its current snapshot, create refs from title/URL, or create a fake installation/connection state. |
| Admitted native host session binding | Sole #2113 dispatcher and #2114 lifecycle owner; root retains canonical operations consumer composition | The actual Linux endpoint already has its admitted peer/root/grant dispatcher callback. No second dispatcher is needed. Root `AddFsusArticleVaultAgentCanonicalOperations(binding, rootManifestSha256, adminPrincipalId)` needs actual current authenticated admin plus the original admitted binding/root digest/session state. Supply exact APIs/source and applicable admission evidence per operation. Do not infer live authority from socket reachability, process presence, historical checkpoints or fixture identities; do not edit dispatcher/lifecycle/state semantics in this branch. |

The authenticated adapter and history host are executable consumer implementations,
but they are **not yet a mounted current-review product flow**. The two new owner
current-review presentation files have been inspected, not copied merely to create
an unused UI. Once genuine input/contract/reference owners are supplied, the root
can connect the original reader and component without changing their algorithms.

## Scope claims and holds

The three callbacks reserved for #3654 in
`ArticleService.ArticleVaultTransaction.cs` and `ArticleService.ArticleVaultWriter.cs`
have no changes in this increment. The source branch does not modify #2113 dispatch,
#2120 planner, #2106 stores, SystemService/config writers or shared wire registries.

Mother branch `codex/chain-3582-current-acceptance-20261008` / draft PR #3900 stays
read-only. No PR/body/comment/label/ready/merge writes, graph/lease/occurrence/custody/
receipt-substitution/native/replacement audits, deployment, issue closure, production
migration or denied RepositoryRoot action were executed in this increment. The
canonical #3582 required full scanner/matrix/PR and actual applicable persistence
acceptance remain open; controlled tests and prior owner source are not substitutes.
