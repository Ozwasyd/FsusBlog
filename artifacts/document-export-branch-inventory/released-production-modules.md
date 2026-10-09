# Two released production implementation scopes

Coordination root creates workers. Integration consumer is root3653. New exclusive files below are released; root3653 stops implementing them. Frozen candidates, sole Jobs/providers/API/UI/Shared owners and existing file ownership remain intact. This replaces the earlier ready-count0 conclusion: real persisted data makes two missing production modules implementable.

Both workers may immediately use compiled source dec33cb67ec41424abd1226efaec6113105f2860. Ordinary integration branch5674cf93b8815bd9de96c0e2fc5634ca452064b8 retains Shared71179 and has an unrelated sole Jobs contract compilation gap; workers need not wait for it to code on dec33. Exact integration input/output commits must be supplied before consumption.

## Module1: persisted session permission composition

Issues2434/2436. Missing behavior is current backend authorization without authenticated HTTP context. Sole Jobs already calls IDocumentExportJobAuthorization.IsAllowedAsync(DocumentExportJobActor, DocumentExportArticleCoordinate, DocumentExportJobOperation, CancellationToken) at admission/execution/commit/delivery. Current HTTP adapter denies without context.

Existing authority/API: SqlAuthorRecentArticleHistoryPermissionAuthority implements IAuthorRecentArticleHistoryPermissionProjectionProvider.ResolveAsync(AuthorRecentArticleHistoryPermissionRequest, CancellationToken). It reads real admin_principal/admin_session/article rows; ResolveSiteScope(IConfiguration) owns formal site and AuthorRecentArticleHistoryContract.ComputePermissionDigest owns sealing. Original IAdminSessionValidationService.ValidateAsync(ClaimsPrincipal?, string accessToken, CancellationToken) owns HTTP token admission and is not replaced or bypassed. Original permission service contains fresh SQL status/root/ArticleWrite/revocation/idle/absolute expiry/article lifecycle rules.

Exclusive new files:

- src/backend/Services/Authoring/AuthorRecentArticleHistoryPersistedPermissionReader.cs
- src/backend/Services/DocumentExport/DocumentExportSessionJobAuthorization.cs
- tests/backend/Unit/DocumentExportSessionJobAuthorizationTests.cs
- tests/backend/Integration/DocumentExportSessionJobAuthorizationPostgresTests.cs

First coding step: extract the existing persisted query and sealing implementation into the first new file, with new implementation API ResolveAsync(AuthorRecentArticleHistoryPermissionRequest request, string sessionId, CancellationToken). This signature is to be implemented, not an already available upstream port. Then implement the original Jobs authorization interface using that reader. No new entity or migration is needed. HTTP context, when present, must still be authenticated admin with exact principal/session matching; background calls use the sole job's already persisted actor/session, not caller-created claims/context or access tokens. Read/Download map to CanProject; Create/Cancel/Retry/Delete to CanWrite, retaining original current decisions. Every call rereads current persisted facts and validates snapshot owner/current status/decision count/digest. Missing/denied/stale data fails closed with no identity leakage.

Read-only shared boundaries: original Jobs sources/contracts, current auth/session/token projection, permission contracts, existing HTTP adapter, freezer/routes. Root3653 reserves small existing-file integration hunks: original SQL permission authority delegates its persisted portion to this same reader; guarded DI registers one intended authorization implementation. This is extraction of the existing canonical permission authority plus its Export consumer, not a second permission SQL authority, permissive fallback, fabricated worker principal, token storage or second Jobs worker.

Ordinary controls: isolated PostgreSQL actual valid session/root/explicit ArticleWrite/read/write operation mapping; revoked/idle/absolute expiry, disabled principal, permission removal, site mismatch, archived/deleted/missing article, cancellation and changes between successive reads. No production credentials. Original approved test lane only; do not run an alternate harness; current exact positive scope/hook/resource/discovery checks and actual denied-scope overlap govern original selections. Completion is real product source, scoped style/SDK compile, actual ordinary positive/negative results and exact published source/evidence. Integration/root policy remains subject to original owners.

## Module2: persisted source choices and source-version authority

Issues2423/2436. Missing behavior is a real producer for DocumentExportWireUiOptions.sources and independent legitimate SourceVersion. Existing frontend requires real source choices/coordinate/prepareRequest; it neither reads nor creates source authority.

Existing reader/writer APIs in IAuthoringDraftLifecycle:

- GetDraftAsync(long ownerAdminPrincipalId, string draftKey, CancellationToken) and SaveDraftAsync(long ownerAdminPrincipalId, ServerDraftSaveRequest, CancellationToken)
- GetRevisionsAsync(int articleId, CancellationToken) and GetRevisionAsync(int articleId, long revisionId, CancellationToken)
- ArticleRevisionContentBlockStore.LoadAsync(ISqlSugarClient db, long contentBlockId, CancellationToken) owns persisted source bytes

Actual ArticleRevision rows contain immutable title/summary/cover/category/tags/content-block coordinate. ArticlePublicationRecord contains exact article/revision/rights/responsibility linkage. GetRevisionAsync's returned Release is latest for that revision, so it must not replace the explicitly selected publication; resolve that actual publication row and its exact associated snapshot rows. AuthoringRevisionCompareAuthority's literal primary site alias is not used. Canonical original permission and ResolveSiteScope configuration are required before source reads and again before publication of choices.

Exclusive new files:

- src/backend/Services/DocumentExport/Sources/DocumentExportSourceCatalogContracts.cs
- src/backend/Services/DocumentExport/Sources/DocumentExportSourceCatalog.cs
- src/backend/Services/DocumentExport/Sources/DocumentExportSourceCatalogStore.cs
- src/backend/Services/DocumentExport/Sources/DocumentExportSourceCatalogSchema.cs
- src/backend/Entities/DocumentExportSourceCatalogEntry.cs
- tests/backend/Unit/DocumentExportSourceCatalogTests.cs
- tests/backend/Integration/DocumentExportSourceCatalogPostgresTests.cs

First coding step: authorized exact revision/publication reads, then transactionally capture a private bounded source-choice binding. Opaque choice id is randomly allocated and persisted; positive Int64 SourceVersion is independently allocated and persisted by this source-binding authority. It is never copied/derived from revision database ID, RevisionNo, publication number, draft ServerRevision, title/slug, label or guessed epoch. Internal article/revision/publication coordinates remain the explicit original contract coordinates, not portable artifact IDs. Repeated same exact stored fingerprint returns the existing binding; changed draft bytes/metadata/server revision produces a new binding. A request for an old coordinate/version cannot silently resolve to latest. Only explicitly supplied owned draft keys are queried; no guesses or other administrator draft enumeration. Preserve actual list bounds; do not imply unbounded history from the existing50-row reader.

This source-version/choice module does real persisted reads/writes. It does not claim complete freezer success: properties/assets/font/renderer provenance must subsequently be read and verified by the original full-source/freezer authority against the same binding. No empty manifest, invented property snapshot, fake renderer/tool digest, new Markdown parser or export success is allowed. Store only the minimum private binding/fingerprint facts, not an unrelated archival store or portable identity derived from source DB IDs. Additive schema is proposed in the domain schema source; registration/execution stays in the original migration authority. No independent bootstrap, production migration or release is authorized.

Read-only boundaries: article/draft lifecycle writers, property/asset/private stores, original permission/session authorities, Jobs, provider registry and Shared wire. Root3653 reserves existing DI/endpoints/frontend prepareRequest/wire registration and original migration registration hunks; worker implements the domain producer/entity/store.

Ordinary controls: actual owned draft/revision/publication; repeat and concurrent fingerprint capture; database reopen retaining binding; changed draft and rejected old version; wrong owner/site/session/revoked permission; incorrect publication/revision relation; missing/deleted data; canceled/rolled-back transaction; private scope isolation and no raw source/internal identity leak. Isolated PostgreSQL and original approved lane; held audits remain not run; original ordinary selections require exact scope/hook/resource/discovery preflight. New schema may be validated through legitimate disposable setup; destructive acceptance, if introduced, requires real isolated backup/restore evidence. Completion is usable production domain code and scoped compile/style/ordinary positive/negative evidence, with separate wire/migration/full freezer gates accurately left open.

## Current authorization handoff

Source935dc8871af2b89a97fa3b4214821f70f37ef0c3 has parent-supplied original-project27/27 unit and29/29 isolated PostgreSQL verification, matched discovery/TRX and cleanup. Root has imported its four files exactly and implemented canonical SQL delegation and guarded session DI. These supplier results do not qualify the full root integration. Source catalog/version implementation remains with its sole assigned owner.
