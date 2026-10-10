# Internal Application API AEDS-only Policy

This document defines FsusBlog's protocol governance: **internal application APIs are AEDS-only**. The browser-to-server application protocol is converged on AEDS v2 frames; do not spread `JsonApiResponse<T>`, `response.json()`, or JSON error envelopes. RSS, health probes, JSON Feed, build tools, and third-party provider contracts are outside this API class and are not required to use AEDS.

Canonical references are [API design](design.md), [API contracts](contracts.md), [schema and error reference](schemas-and-errors.md), the [allowlist](../../tools/contracts/aeds-only-policy.allowlist.json), and the [policy gate](../../tools/contracts/check-aeds-only-policy.mjs). The shell entry point is [`tools/check-aeds-only-policy.sh`](../../tools/check-aeds-only-policy.sh); the focused observation test is [`tests/tools/openapi-aeds-observation.test.mjs`](../../tests/tools/openapi-aeds-observation.test.mjs).

<a id="内部应用-api-定义"></a>

## Internal application API definition

An endpoint is an internal application API when any of the following is true:

- FsusBlog's frontend runtime calls it for site UI, public reading, authentication, authoring, administration, notifications, or telemetry.
- It is under `/api/**` and is not a standard protocol, health probe, or build/operations-tool-only entry point.
- It returns a business DTO, error envelope, pagination data, operation result, or administration-console data.

The default contract is:

```text
request:  application/octet-stream AEDS v2 frame
response: application/octet-stream AEDS v2 frame
error:    AedsFrameType.ApiError
```

## AEDS-only requirements

- New internal application APIs use AEDS request and response frames.
- Successful writes should return `EmptySuccess` or `MutationId` where applicable.
- Failures, authorization denials, rate limits, protocol errors, and exception fallbacks use an `ApiError` frame.
- Frontend callers decode through a binary adapter; do not add internal `response.json()` calls.
- A new frame type, POD codec, or Wasm/TypeScript adapter must ship with a golden fixture or contract/static test.

<a id="允许豁免"></a>

## Permitted exemptions

The following JSON/XML/text paths are permitted only when registered in `tools/contracts/aeds-only-policy.allowlist.json`:

| Scope | Path / contract | Reason |
| ------ | ------------------ | ------ |
| Health | `/health/live`, `/health/ready` | Kubernetes/systemd/monitoring probes consume JSON; `/health/ready` exposes only `status` and `checkedAt`. |
| Feed | `/feed/rss.xml`, `/feed/atom.xml`, `/feed/feed.json` | RSS, Atom, and JSON Feed standard protocols. |
| SEO | `/sitemap.xml`, `/robots.txt` | Search-engine standard entry points. |
| Operations probe | `/api/ops/health/ready-detail`, `/api/ops/crawler-ranges/status` | Admin-only operations diagnostics; public `/health/ready` stays minimal, while the production admin UI reads business operations data through AEDS paths. |
| Public AOT tooling | `/internal/public-aot/manifest`, `/internal/public-aot/health` | Build/backfill manifest and SSR-worker diagnostics, not browser runtime APIs. |
| Local fixture tooling | `/__local/auth-fixture/status`, `/api/local/auth-fixture/status`, `/api/local/demo-fixture/prepare`, `/api/local/public-content-fixture/prepare`, `/__local/public-content-fixture/prepare`, `/__local/temporal-observation` | Development-only fixture producers/observation probes; loopback plus shared-secret access only, and production startup validation refuses to enable them. |
| Auth fixture lifecycle | `/api/local/auth-fixture/prepare`, `/api/local/auth-fixture/verify` | The `auth-session` tooling producer consumes preparation and verification receipts; Development plus explicit fixture gate, secret and loopback only. |
| Audit fixture lifecycle | `/__local/audit-fixture/prepare` | The `audit-records` tooling producer consumes the preparation receipt; Development plus explicit fixture gate, secret and loopback only. |
| Profile fixture lifecycle | `/__local/account-profile-preferences/prepare`, `/__local/account-profile-preferences/verify` | The `account-profile-preferences` tooling producer consumes lifecycle receipts; Development plus explicit fixture gate, secret and loopback only. |
| Comment fixture lifecycle | `/api/local/comment-fixture/prepare`, `/api/local/comment-fixture/cleanup` | The `comment-moderation` tooling producer consumes lifecycle and failure-recovery receipts; Development plus explicit fixture gate, secret and loopback only. |
| Messaging fixture lifecycle | `/api/local/messaging-fixture/prepare` | The `account-messaging` tooling producer consumes the preparation receipt; Development plus explicit fixture gate, secret and loopback only. |
| Security fixture lifecycle | `/__local/security-fixture/apply`, `/__local/security-fixture/observe`, `/__local/security-fixture/cleanup`, `/__local/security-fixture/observe-cleanup` | The `security-state` tooling producer consumes domain receipts; Development/Test plus explicit fixture gate, secret and loopback only, never mapped in Production. |
| Runtime-cache fault probe | `/_fsus/testing/runtime-cache/redis-fault/{operationClass}` | The runtime-cache evidence runner consumes Redis fault classifications; the parent registers the probe only in Development/Test with a configured evidence secret, and the handler requires middleware-authenticated evidence access. |
| Third-party moderation provider | HTTP JSON provider contract | External provider compatibility protocol. |
| Evidence/tool/docs | `.tmp/release-evidence/**`, `tools/**`, `docs/**`, tests | Build, test, audit, and evidence files, not runtime APIs. |

Exemptions may not use broad wildcards. Each entry must bind a concrete file, path or scope, matching pattern, and reason.

The fixture lifecycle and runtime-cache fault exemptions retain JSON only for their named tooling consumers. Retire the entry when its route is removed; if a route becomes a browser-runtime application API, migrate it to AEDS instead of extending the exemption. These registrations do not admit public JSON fallbacks or bypass the existing environment, identity, secret, or caller checks.

## #105 convergence result

The `must-migrate` set must be empty. After #105, these former internal JSON paths are no longer exposed as external APIs:

| Former path | Current entry point |
| -------- | ---------- |
| `/api/public/articles/{articleId}/related` | `/api/binary/article/{articleId}/related.aeds` |
| `/api/read-proof/challenge`, `/api/read-proof/submit` | `/api/binary/read-proof/challenge.aeds`, `/api/binary/read-proof/submit.aeds` |
| `/api/telemetry/rum` | `/api/binary/telemetry/rum` |
| `/api/subscriptions` | `/api/binary/subscriptions` |
| `/api/author/**` | `/api/binary/author/**` |
| `/api/admin/security/**` | `/api/binary/admin/security/**` |
| `/api/notifications/stream/preflight` JSON failure envelope | `204` success or an AEDS `ApiError` failure frame |

`JsonApiResponse<T>` is permitted only in registered tool/compatibility files. Internal APIs do not promise early-project historical compatibility. The authoring and security backends are mounted directly as native `/api/binary/**` AEDS endpoints, with no runtime internal-bridge compatibility allowlist. Legacy database migration and old-user/old-comment cleanup remain maintenance exceptions, but never justify a JSON bridge for a browser-reachable business API.

## New endpoint selection

1. A new browser-runtime `/api/**` endpoint defaults to AEDS.
2. If JSON/XML/text appears necessary, first establish that the endpoint is an external standard protocol, health probe, build/operations tool, or third-party provider contract.
3. A valid exemption requires a new allowlist entry documenting its path, consumer, retention reason, and exit condition.
4. When uncertain, classify the endpoint as an internal application API and use AEDS.

## Error semantics

Internal application API errors map to `AedsFrameType.ApiError` with:

```text
ErrorCode
HTTP status
trace id
message
details / reason code
```

JSON error envelopes are limited to explicitly exempted paths. A new business error code must update [schemas-and-errors.md](schemas-and-errors.md) and a corresponding AEDS golden fixture or contract test.

## Frontend adapter rules

- Call internal APIs through `requestBinaryOnly`, a frame adapter, or an explicit AEDS request codec.
- Do not add unregistered `response.json()`, `Accept: application/json`, `Content-Type: application/json`, or `JSON.stringify` request bodies under `src/frontend/src/api/**`.
- Keep migration-era JSON adapters in registered files; do not scatter parsing through Vue components or composables.
- An AEDS adapter must cover success frames, `ApiError`, wrong content type, wrong frame type, and decoder failure.

## Gate and inventory

The policy is enforced by:

```text
tools/contracts/aeds-only-policy.allowlist.json
tools/contracts/check-aeds-only-policy.mjs
tools/check-aeds-only-policy.sh
```

The scanner covers backend endpoint/health/preflight files and frontend runtime API adapters, writing:

```text
.tmp/gate-logs/aeds-only-policy-inventory.json
```

| Classification | Meaning | Gate behavior |
| ------ | ------ | ----------- |
| `allowed-exemption` | Standard protocol, health probe, or tool-only JSON | Allowed |
| `must-migrate` | Registered internal JSON not yet migrated | Blocks |
| `test-tool-docs-only` | Test/tool/document JSON | Allowed; runtime is not scanned |
| `unknown` | Unregistered JSON residue | Blocks |

`static-governance` runs `tools/check-aeds-only-policy.sh`. Register new JSON usage before adding it; otherwise the fast gate fails.

## Contract requirements

Adding or migrating an AEDS API must update at least:

- `src/core/Algorithms/AedsFrameType.cs`
- `src/shared/Contracts/Validation/aeds-protocol.json`
- the corresponding POD codec, TypeScript adapter, and Wasm decoder mapping
- a golden fixture or contract/static test
- [`docs/api/contracts.md`](contracts.md) and this quick reference

After migration, remove the JSON path's `must-migrate` entry from the allowlist and verify that it no longer appears in the scanner inventory.
## Current public protocol

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.protocol
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.protocol
render: scalar
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.protocol -->
AEDS
<!-- FSUSBLOG-GENERATED:END api.protocol -->

### Current protocol state partitions

Active frame identities, retired numeric values and migration-only reservations are disjoint parts of the observed protocol. A frame name containing historical terminology is not retired unless the typed partition says so; migration-only reservations are not current frames.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.aeds-only
behaviorId: binary-api-aeds-contract
claimType: boolean
factPath: protocolStates.aedsOnly
render: boolean-affirmed
-->

The current public protocol sets `aedsOnly` to `true`.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.migration-only-state
behaviorId: binary-api-aeds-contract
claimType: failure-mode
factPath: protocolStates.migrationOnlyState
render: failure-mode-code
-->

The migration-only partition state is `present`; its IDs remain separate from active frame identities and retired numeric values.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.protocol-states
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.protocol-states
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.protocol-states -->
| Key | Value |
| --- | --- |
| activeFrameIds | &#91;"AccountConversationReplyRequest","AdminCacheActionRequest","AdminCacheActionResponse","AdminChangeUserStatusRequest","AdminConversationDetail","AdminConversationList","AdminPrincipalSnapshot","AdminSessionList","AdminStats","AdminUserList","AiAssistRequest","AiAssistResponse","AnonymousCommentCreateRequest","AnonymousCommentCreateResult","AnonymousCommentTicketRequest","AnonymousCommentTicketResponse","AnonymousCredentialRevocationDelta","AnonymousCredentialRevocationSnapshot","AnonymousCredentialRootSnapshot","AnonymousGovernanceActionRequest","AnonymousGovernanceActionResponse","AnonymousPrivacyStateSnapshot","AntiCrawlerListEntryDeleteResponse","AntiCrawlerListEntryList","AntiCrawlerListEntryRequest","AntiCrawlerListEntryResponse","AntiCrawlerOptionsUpdateRequest","AntiCrawlerOverview","AntiCrawlerPolicySnapshot","AntiCrawlerRuleDeleteResponse","AntiCrawlerRuleList","AntiCrawlerRuleRequest","AntiCrawlerRuleResponse","AntiCrawlerSimulationRequest","AntiCrawlerSimulationResult","ApiError","ArticleDetail","ArticleFeatured","ArticleHot","ArticleList","ArticlePreviewRequest","ArticlePreviewResponse","ArticleRelatedReading","ArticleResponsibilityHistory","ArticleResponsibilityRequest","ArticleResponsibilityResponse","ArticleRevisionDetail","ArticleRevisionList","ArticleRevisionRollbackRequest","ArticleRevisionRollbackResponse","ArticleSearch","ArticleWriteRequest","AssetCleanupResponse","AssetLibraryList","AuditLogDetail","AuditLogList","AuditLogSummary","AuditTamperVerifyResponse","AuthAnonymousBootstrapRequest","AuthDeleteAccountRequest","AuthLoginFlow","AuthSessionList","AuthUpdatePublicHandleRequest","AuthorAnalytics","AuthorDraftDiscardResponse","AuthorDraftResponse","AuthorDraftSaveRequest","AuthorTaxonomyCategoryList","AuthorTaxonomyTagList","BackupStatus","BlindCredentialIssueRequest","BlindCredentialIssueResponse","BlindCredentialIssuerMetadata","CacheDiagnostics","CategoryList","CategoryWriteRequest","ClusterLeaseReleaseRequest","ClusterNodeStateRequest","ClusterRuntimeSnapshot","ClusterSchedulerStateRequest","CommentAppealDecisionRequest","CommentAppealDecisionResult","CommentArticleCursor","CommentAuthorAppealRequest","CommentAuthorEditRequest","CommentAuthorMutationResult","CommentAuthorStatusRequest","CommentAuthorStatusResult","CommentAuthorView","CommentChildCursor","CommentCreateResult","CommentCreateV2Request","CommentManagementChallengeRequest","CommentManagementChallengeResponse","CommentModerationBulkRequest","CommentModerationBulkResponse","CommentModerationClaimMutationRequest","CommentModerationClaimRequest","CommentModerationClaimResponse","CommentModerationQueue","CommentModerationRequest","CommentModerationResult","CommentModerationTimeline","CommentPermalinkContext","CommentPolicySnapshot","CommentPolicyUpdateRequest","CommentReportRequest","CommentReportResult","CommentRevisionList","CommentThreadReplyCursor","CommentTreeRootCursor","CommentUserCursor","ContentBackupExport","ContentExport","ContentImportRequest","ContentImportResponse","ConversationCreateRequest","ConversationDetail","ConversationDetailV2","ConversationDetailV3","ConversationList","ConversationMessage","ConversationReadRequest","ConversationReplyRequest","ConversationStatusMutationResult","ConversationStatusRequest","CrawlerRangeSyncResponse","CrawlerRangesAdminStatus","CurrentUserSnapshot","DangerousOperationPolicy","EmptySuccess","FileDeleteRequest","FontActivationList","FontRegistryDetail","FontRegistryList","HumanReadChallengeRequest","HumanReadChallengeResponse","HumanReadSubmitRequest","HumanReadSubmitResponse","IdentityAccountSnapshot","IntegrityFixPreview","IntegrityFixRequest","IntegrityFixResponse","IntegrityReport","MfaChallengeResult","MfaChallengeStartRequest","MfaChallengeVerifyRequest","MfaPasswordProofRequest","MfaProfile","MfaSetupStart","MfaSetupVerify","MfaSetupVerifyRequest","ModerationDictionaryReloadResponse","ModerationDictionarySnapshot","ModerationDictionaryStateRequest","ModerationEffectivePolicy","ModerationEffectivePolicyPreviewRequest","ModerationModelRuntimeRequest","ModerationModelStatus","ModerationOverview","ModerationPolicyTemplateList","ModerationRegionGroupList","ModerationRegionList","ModerationReplayPreview","ModerationReplayPreviewRequest","ModerationRuntimeGlobalStateRequest","ModerationRuntimeRegionStateRequest","ModerationRuntimeStatus","MutationId","NotificationEvent","NotificationHeartbeat","OpsHealth","PageContent","PageContentUpdateRequest","PasskeyCredentialFriendlyNameUpdateRequest","PasskeyCredentialList","PasskeyLoginBegin","PasskeyLoginCompleteRequest","PasskeyRegisterBegin","PasskeyRegisterCompleteRequest","PasskeySignalState","PerceptionSealedChallengeV2","PerceptionSealedResultV2","PluginAdminMutationRequest","PluginAdminSnapshot","PluginPackageInstallRequest","PowChallenge","PowOptionsUpdateRequest","PowOverview","PowPolicySnapshot","PrepublishCheckRequest","PrepublishCheckResponse","PublicAotBootstrap","RecentCommentStats","RecoveryKeyCreateResponse","RecoveryKeySessionRequest","RecoveryKeyVerifyRequest","RecoveryKeyVerifyResponse","RegionPolicySummaryList","RegionStats","RetiredCredentialSpecificRevocationRequest","RetiredCredentialSpecificRevocationResponse","RumMetricBatchRequest","RumMetricIngestResponse","SecurityChallengeAssignment","SecurityChallengeCancelRequest","SecurityChallengeEnvelope","SecurityChallengeIssueRequest","SecurityChallengeIssueResponse","SecurityChallengeVerifyRequest","SecurityChallengeVerifyResponse","SecurityOverview","SecurityRiskEventList","SecurityRiskResetRequest","SecurityRiskResetResponse","SecurityRiskSnapshotList","SeoConfig","SeoConfigUpdateRequest","SiteComplianceConfig","SiteComplianceConfigUpdateRequest","SiteSubscriptionRequest","SiteSubscriptionResponse","SystemMessageRequest","TagList","TagWriteRequest","TaxonomyExactMetadata","ThemeActivation","ThemeActivationHistory","ThemeActivationList","ThemeRegistryDetail","ThemeRegistryList","TrashClearResponse","UploadComplete","UploadCompleteRequest","UploadInit","UploadInitRequest","UploadPartAck","UploadPartMap","UploadStatus","UserLocalePreference","UserLocalePreferenceUpdateRequest"&#93; |
| aedsOnly | true |
| migrationOnlyFrameIds | &#91;"Reserved177","Reserved178"&#93; |
| migrationOnlyState | present |
| retiredFrameValues | &#91;40,43,44,45,46,180,181&#93; |
| supportedVersions | &#91;2&#93; |
<!-- FSUSBLOG-GENERATED:END api.protocol-states -->
