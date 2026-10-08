# AEDS v2 Protocol (Little Endian)

This is the current wire protocol specification. AEDS v2 is the only accepted runtime frame version; server, TypeScript, Worker, and Wasm decoders reject v1 frames.

## Generated Contract Surfaces

`src/shared/Contracts/Validation/aeds-protocol.json` is the single machine-readable source for the v2 header and active frame types. After changing the manifest, run `node tools/frontend/generate-aeds-protocol.mjs`; the generator owns these files, which must not be edited by hand:

- `src/core/Algorithms/AedsFrameType.cs`
- `src/shared/AedsFrameType.cs`
- `src/shared/AedsFrameHeader.cs`
- `src/frontend/src/wasm/web/protocol/frame.ts`
- `src/frontend/wasm/aeds/include/aeds_frame.hpp`

Core, backend, benchmarks, and backend tests import the generated Shared packed header rather than defining another `AedsFrameHeader`. `node tools/frontend/generate-aeds-protocol.mjs --check` fails for any stale generated surface. The cross-stack frame-schema check also compiles the production C++ decoder, runs every active manifest value through it, and decodes a C# golden frame. C++ callers use generated `IsKnownFrameType`; values absent from the active manifest, including retired slots, must be rejected rather than silently accepted.

Access profiles do not alter this wire protocol. `src/shared/Contracts/Validation/aeds-access-profiles.json` generates C#/TypeScript/C++ reader constants for existing payload layouts, while the frame header, CRC, frame type and POD layout authorities remain unchanged. A projection reader validates the complete frame and payload before returning selected fields; it may not skip CRC, range, UTF-8, reserved-byte, count or trailing-byte checks. The default `publicArticleListCard` profile accepts only cursor v2 with 100-byte ArticleList records. Retired 56/76-byte records, cursor v1, missing envelopes, unknown or malformed layouts fail closed. See `docs/architecture/aeds-access-projections.md`.

## Frame Layout

- Header: 16 bytes; payload: compact POD bytes (from `PodBinaryCodec`).

| Offset | Size | Field | Type |
| --- | ---: | --- | --- |
| 0 | 4 | Magic | `uint32` (`0x53444541`, bytes: `41 45 44 53`, text: `AEDS`) |
| 4 | 1 | Version | `uint8` (`2`) |
| 5 | 1 | HeaderLength | `uint8` (`16`) |
| 6 | 2 | Flags | `uint16` |
| 8 | 2 | FrameType | `uint16` |
| 10 | 4 | PayloadLength | `uint32` |
| 14 | 2 | PayloadCrc16 | `uint16` |

All `*UnixMs` payload fields are signed `int64` milliseconds from the UTC Unix epoch. Database timestamps materialized as `DateTimeKind.Unspecified` are already UTC wall-clock values and must not be shifted through the host local timezone; local `DateTime` values are converted by instant. This normalization rule does not change field widths, frame sizes, or the TypeScript/Worker/Wasm decoder ABI.

## CRC Rules

`PayloadCrc16 = CRC16(payload bytes)`, using polynomial `0xA001` with initial value `0xffff`. v2 has no header CRC; header integrity is validated by magic, version, header length, frame type, payload length, and transport framing.

## Flags Registry

- `0x0000`: current production value for request and response frames.
- `0x0001`: reserved for a possible response-only `NoPayloadCrc` flag. It is not active; request frames with any non-zero flags are rejected.
- `0x0002`: reserved for possible protocol-level payload compression on non-HTTP transports. HTTP hot-read uses `Content-Encoding: br|gzip` around the complete AEDS frame instead, so payload bytes and CRC semantics stay unchanged after browser fetch decompression.

Any non-zero flag must first be added to `aeds-protocol.json`, the negative contract matrix, TypeScript/Worker/Wasm decoders, and this document before production use.

## FrameType Mapping

- `1`: ArticleList
- `2`: ArticleDetail
- `3`: ArticleHot
- `4`: ArticleSearch
- `5`: CommentArticleCursor
- `6`: CommentUserCursor
- `7`: AdminStats
- `8`: CommentThreadReplyCursor
- `9`: CategoryList
- `10`: TagList
- `11`: RecentCommentStats
- `12`: RegionStats
- `13`: SeoConfig
- `14`: PageContent
- `15`: ArticleFeatured
- `16`: TrashClearResponse
- `17`: AdminUserList
- `18`: AuthLoginFlow
- `19`: CurrentUserSnapshot
- `25`: AuthSessionList
- `170`: AdminSessionList
- `171`: SecurityChallengeAssignment
- `172`: SecurityChallengeEnvelope
- `20`: UploadInit
- `21`: UploadStatus
- `22`: UploadPartAck
- `23`: UploadComplete
- `24`: UploadPartMap
- `30`: PowChallenge
- `31`: UploadInitRequest
- `32`: UploadCompleteRequest
- `33`: CategoryWriteRequest
- `34`: TagWriteRequest
- `35`: SeoConfigUpdateRequest
- `36`: PageContentUpdateRequest
- `38`: FileDeleteRequest
- `39`: AdminChangeUserStatusRequest
- `40`: retired legacy admin password reset slot. This numeric value is not reused, has no active frame name, and has no production codec or endpoint.
- `41`: ArticleWriteRequest
- `43`/`44`/`45`/`46`: retired legacy username/password auth slots. These numeric values are not reused, have no active frame names, and have no production codec or endpoint.
- `47`: AuthDeleteAccountRequest
- `48`: MfaSetupStart
- `49`: MfaSetupVerify
- `50`: MfaProfile
- `51`: MfaChallengeResult
- `52`: MfaSetupVerifyRequest
- `53`: MfaPasswordProofRequest
- `54`: MfaChallengeStartRequest
- `55`: MfaChallengeVerifyRequest
- `56`: ConversationList
- `57`: ConversationDetail
- `58`: ConversationMessage
- `59`: ConversationCreateRequest
- `60`: ConversationReplyRequest
- `61`: ConversationStatusRequest
- `62`: SystemMessageRequest
- `63`: PasskeyRegisterBegin
- `64`: PasskeyLoginBegin
- `65`: PasskeyCredentialList
- `66`: PasskeyRegisterCompleteRequest
- `67`: PasskeyLoginCompleteRequest
- `68`: PasskeyCredentialFriendlyNameUpdateRequest
- `212`: PasskeySignalState
- `213`: ArticleRevisionRollbackRequest
- `69`: NotificationEvent
- `70`: NotificationHeartbeat
- `71`: PublicAotBootstrap
- `72`: SiteComplianceConfigUpdateRequest
- `201`: ConversationReadRequest
- `202`: AccountConversationReplyRequest
- `203`: ConversationDetailV2
- `204`: ConversationDetailV3
- `73`: HumanReadChallengeRequest
- `74`: HumanReadSubmitRequest
- `75`: RumMetricBatchRequest
- `76`: RumMetricIngestResponse
- `166`: CommentCreateRequest
- `177`: reserved; no decoder or compatibility path
- `178`: reserved; no decoder or compatibility path
- `179`: AnonymousCredentialRootSnapshot
- `180`: retired (precise-anonymous-credential-ticket-request); must fail closed as a retired frame
- `181`: retired (precise-anonymous-credential-ticket-response); must fail closed as a retired frame
- `182`: AnonymousCommentCreateRequest
- `183`: AnonymousPrivacyStateSnapshot
- `184`: PerceptionSealedChallengeV2
- `185`: PerceptionSealedResultV2
- `186`: RetiredCredentialSpecificRevocationRequest (permanently rejected; must not carry handle/body again)
- `187`: RetiredCredentialSpecificRevocationResponse (number permanently reserved; no longer sent)
- `196`: AnonymousCredentialRevocationSnapshot
- `197`: AnonymousCredentialRevocationDelta
- `205`: CommentCreateResult
- `206`: AdminConversationList
- `207`: AdminConversationDetail
- `208`: CommentTreeRootCursor
- `209`: CommentChildCursor
- `210`: CommentPermalinkContext
- `211`: ConversationStatusMutationResult
- `214`: AnonymousCommentCreateResult
- `215`: CommentManagementChallengeRequest
- `216`: CommentManagementChallengeResponse
- `217`: CommentAuthorEditRequest
- `218`: CommentAuthorMutationResult
- `219`: CommentAuthorStatusRequest
- `220`: CommentAuthorStatusResult
- `221`: CommentAuthorAppealRequest
- `223`: CommentReportRequest
- `224`: CommentReportResult
- `225`: CommentModerationTimeline
- `226`: CommentAppealDecisionRequest
- `227`: CommentAppealDecisionResult
- `222`: CommentRevisionList
- `239`: UserLocalePreference
- `240`: EmptySuccess
- `241`: MutationId
- `242`: UserLocalePreferenceUpdateRequest
- `243`: TaxonomyExactMetadata
- `244`: FontRegistryList
- `245`: FontRegistryDetail
- `246`: FontActivationList
- `247`: ThemeRegistryList
- `248`: ThemeRegistryDetail
- `249`: ThemeActivationList
- `250`: ThemeActivation
- `251`: ApiError
- `252`: ThemeActivationHistory

`CommentArticleCursor`, `CommentThreadReplyCursor`, and `CommentUserCursor` records do not carry fixed legacy display-name slots. Each item blob stores the content slice first, then appends two length-prefixed `CommentAuthorView` payloads: required `author` and optional `replyToAuthor`. Decoders must reject missing author payloads instead of reconstructing display authors from legacy identity strings.

## Common Response PODs

- `EmptySuccess` payload: `EmptySuccessPod` (`Ok = 1`, remaining bytes reserved).
- `CommentCreateResult` payload: 40-byte `CommentCreateResultPod` (`int64 commentId`, `int64 rootId`, `int64 parentId`, `int64 createdAtUnixMs`, `int32 moderationStatus`, `uint8 visibilityState`, `uint8 isPubliclyVisible`, `uint8 idempotencyReplay`, `uint8 hasParentId`). `parentId=0/hasParentId=0` represents a top-level comment; all IDs are positive otherwise. Visibility values are `0 pending`, `1 public`, `2 hidden`, `3 rejected`.
- Frames `214`–`222` use UTF-8 JSON inside a normal AEDS v2 frame for private comment-author management. Secrets and challenges are body-only and `no-store`; public comment frames never include a capability, commitment, challenge, or revision body.
- `CommentTreeRootCursor` payload: standard cursor envelope followed by root `CommentTreeNodePod` records. Every root record is followed by its content/author blob, then a 4-byte direct-preview header (`uint8 count`, three reserved zero bytes), then exactly `count` direct-child node records. It never flattens deeper descendants.
- `CommentChildCursor` payload: 32-byte `CommentChildCursorPod` (`int64 parentId`, `int64 rootId`, `int64 nextCursor`, `int32 count`, `uint8 hasMore`, three reserved zero bytes) followed by exactly `count` direct-child `CommentTreeNodePod` records.
- `CommentPermalinkContext` payload: 32-byte `CommentPermalinkContextPod` followed by ordered ancestor nodes, optional target node, and sibling nodes. Status `unavailable` has no target and zero node counts; deleted, hidden, region-blocked, and absent targets intentionally share this shape.
- `CommentTreeNodePod` is 60 bytes and carries 64-bit `id/parentId/rootId/replyToCommentId`, `depth`, batch-derived `childCount`, tombstone/more flags, timestamp, and a content slice. IDs remain signed 64-bit values across C#/C++/TypeScript and TypeScript exposes them as decimal strings.
- `MutationId` payload: `MutationIdPod` (`int64 Id`).
- `UserLocalePreference` payload: 24-byte `UserLocalePreferencePod` (`int64 revision`, `int64 updatedAtUnixMs`, `uint8 mode`, `uint8 hasFixedLocale`, `uint8 fixedLocale`, one reserved zero byte, four reserved zero bytes). `mode=1` is `auto` and requires `hasFixedLocale/fixedLocale=0/0`; `mode=2` is `fixed` and requires `hasFixedLocale=1` plus an enabled canonical locale id.
- `UserLocalePreferenceUpdateRequest` payload: 16-byte `UserLocalePreferenceUpdateRequestPod` with the same mode/locale/reserved rules and `int64 expectedRevision`; device-scoped writes require revision zero, while account-scoped writes use optimistic revision matching.
- `ApiError` payload: `ApiErrorPod` (`byte Code`, `byte Category`, `int32 HttpStatus`, fixed UTF-8 `Message`, `Details`, `TraceId`).
- Font/Theme administration response frames `244`-`250` and `252` use a closed 16-byte `FontThemePayloadHeaderPod` (`int32 version = 1`, `int32 recordCount`, `int32 payloadLength`, `int32 reserved = 0`). `payloadLength` covers every byte after this header. List payloads then contain the exact fixed-size POD array, one `int32 blobByteLength`, and a canonical UTF-8 blob. Detail payloads contain one detail POD, exactly `recordCount` child PODs or mode slice references, the blob length, and the canonical blob. `ThemeActivation` is a singleton with `recordCount = 1`; a missing activation remains a typed record whose scope is present and whose nullable values are absent.
- Font/Theme slices must be contiguous in field and record order. Required strings are non-empty unless their field explicitly permits empty text; absent optional strings encode both presence `0` and slice `0/0`. Nullable scalars likewise require a zero value when absent. UTF-8 is strict, all boolean/presence bytes are `0` or `1`, reserved bytes are zero, counts and per-field byte lengths are bounded by `FontThemeAdminContractLimits`, and trailing bytes are rejected. Font install state is `1 installed`; Theme install states are `1 Discovered`, `2 Validated`, `3 Installed`, `4 Enabled`, `5 Disabled`, `6 Failed`, `7 RolledBack`, `8 Uninstalled`; Theme activation status is `1 Applied`, `2 Rejected`, `3 RolledBack`, `4 ResetToDefault`. The fixed POD sizes are `FontRegistryItemPod=76`, `FontRegistryDetailPod=100`, `FontFacePod=56`, `FontActivationPod=64`, `ThemeRegistryItemPod=84`, `ThemeRegistryDetailPod=148`, `ThemeActivationPod=64`, and `ThemeActivationHistoryPod=124` bytes.
- `CategoryWriteRequest` / `TagWriteRequest` payload: current requests use a 136-byte `TaxonomyMetadataMutationRequestPod` (`Utf8Fixed128 Name`, `Utf8SliceRef Description`) followed by the standard `int32 blobByteLength` and UTF-8 description blob. During migration, the backend also accepts the exact legacy 128-byte `NameMutationRequestPod`; legacy create interprets description as null and legacy update preserves the stored description. New-format description input is trimmed, whitespace-only input becomes null, and values over 500 Unicode scalar values are rejected before persistence.
- `SeoConfigUpdateRequest` payload: same layout as `SeoConfig`.
- `PageContentUpdateRequest` payload: same layout as `PageContent`.
- `CommentCreateRequest` payload: `CommentCreateRequestPod` followed by shared blob payload for anonymous scope, display language, proof token, ZK proof bytes, and comment content. The legacy `replyToUserId` compatibility slot at POD offset 4 and its presence flag at offset 11 are reserved and MUST be encoded as `0/0`; reply targets are identified by `replyToCommentId`.
- `FileDeleteRequest` payload: `StringMutationRequestPod` followed by blob payload for image URL.
- `AdminChangeUserStatusRequest` payload: `AdminChangeUserStatusRequestPod` with `accountId`, status, and blob payload for reason.
- Retired legacy admin password reset slot (`40`) has no payload contract. Decoders, AEDS catalogs, OpenAPI, frontend frame mirrors, and production endpoints must not expose it.
- `ArticleWriteRequest` payload: `ArticleWriteRequestPod`, `int32 tagIds[count]`, blob payload for title/content/summary/cover URL slices, then required V3 tail `int32 status`, `int64 scheduledPublishAtUnixMs`, `int32 version = 3`, `int32 rightsFlags`, `int32 copyrightYear`, `int32 maxExcerptChars`, `ArticleRightsWriteRequestPod`, rights blob. `rightsFlags` bits are `1 enabled`, `2 allowCodeCopy`, `4 showPublicBadge`, `8 proofBindingEnabled`, `16 hasCopyrightYear`. Missing V3 rights tail is invalid.
- `AuthUpdatePublicHandleRequest` payload: `StringMutationRequestPod` followed by blob payload for the new public handle; an empty string clears the handle.
- Retired legacy username/password auth slots (`43`/`44`/`45`/`46`) have no payload contract. Decoders, AEDS catalogs, OpenAPI, frontend frame mirrors, and production endpoints must not expose them.
- `AuthDeleteAccountRequest` payload: `AuthDeleteAccountRequestPod` followed by blob payload for confirm text only. Account deletion step-up proof is carried by `X-Fsus-Mfa-Proof`, not by password, TOTP code, or recovery-code fields.
- `MfaSetupVerifyRequest` payload: `StringMutationRequestPod` followed by blob payload for the TOTP code.
- `MfaPasswordProofRequest` payload: `MfaPasswordProofRequestPod` followed by blob payload for password/TOTP/recovery code.
- `MfaChallengeStartRequest` payload: `StringMutationRequestPod` followed by blob payload for action.
- `MfaChallengeVerifyRequest` payload: `MfaChallengeVerifyRequestPod` followed by blob payload for challenge token/action/TOTP/recovery code.
- `RecoveryKeyCreateResponse` payload: `RecoveryKeyCreateResponsePod` followed by blob payload for the one-time plaintext account Recovery Key. The plaintext is returned only by create/rotate responses and is never persisted server-side.
- `RecoveryKeyVerifyRequest` payload: `RecoveryKeyVerifyRequestPod` followed by blob payload for the account Recovery Key. It carries only `RevokeSessions` and `RevokePasskeys` flags plus the Recovery Key blob; it does not carry account id. New keys use `frk_<lookupId>_<secret>` with a 128-bit hex lookup id, and the anonymous recovery verification endpoint uses a peppered lookup hash to find the candidate before checking the full key hash.
- `RecoveryKeyVerifyResponse` payload: `RecoveryKeyVerifyResponsePod` with a short-lived recovery session token used only to bind a new Passkey after successful Recovery Key verification.
- `RecoveryKeySessionRequest` payload: `StringMutationRequestPod` followed by blob payload for that recovery session token. Passkey recovery completion reuses `PasskeyRegisterCompleteRequest` and carries the recovery session token in `MfaProofToken`; this is a Recovery Key step-up, not a TOTP MFA recovery-code path.
- `SecurityChallengeAssignment` payload: `SecurityChallengeAssignmentPod`; fields include challenge id, traceparent, tenant id, kind, escalation level, action, route key, subject/client IP/device fingerprint hashes, issued time and expiry time. Challenge ids are UUID v7.
- `SecurityChallengeEnvelope` payload: `SecurityChallengeEnvelopePod` followed by `SecurityChallengeAssignmentPod[count]`; count is capped by the shared contract.
- `PerceptionSealedChallengeV2` payload: `PerceptionSealedChallengeV2Pod` followed by blob payload for render recipe base64, sealed token base64, family and variant. `Algorithm` is fixed to `fsu.challenge/perception-sealed@v2`; `TaskKind` maps only to Localization or MicroInteraction V2.
- `PerceptionSealedResultV2` payload: `PerceptionSealedResultV2Pod` followed by blob payload for response payload base64 and sealed token base64. `PayloadKind` supports coordinates and steps response payloads and must match `TaskKind`.
- `ConversationCreateRequest` payload: `ConversationCreateRequestPod` followed by blob payload for subject/body.
- `ConversationReplyRequest` payload: `StringMutationRequestPod` followed by blob payload for body.
- `ConversationReadRequest` payload: `ConversationReadRequestPod` with the exact visible `ReadThroughMessageId` returned by detail.
- `AccountConversationReplyRequest` payload: `AccountConversationReplyRequestPod` followed by blob payload for body; the account reply cursor is explicit and does not advance to the newly inserted self message.
- `ConversationStatusRequest` payload: 12-byte `ConversationStatusRequestPod` (`0=open`, `1=pending`, `2=closed`) followed by a required audit-reason blob.
- `ConversationStatusMutationResult` payload: 12-byte `ConversationStatusMutationResultPod` with previous/current status and outcome (`0=changed`, `1=no_change`).
- `SystemMessageRequest` payload: `SystemMessageRequestPod` followed by blob payload for subject/body.
- `PasskeyRegisterCompleteRequest` payload: `PasskeyRegisterCompleteRequestPod`, `int32 transports[count]`, followed by blob payload for credential id/raw id/clientDataBytes/attestation object/friendly name/MFA proof token.
- `PasskeyLoginCompleteRequest` payload: `PasskeyLoginCompleteRequestPod` followed by blob payload for credential id/raw id/clientDataBytes/authenticator data/signature/user handle.
- `PasskeyCredentialFriendlyNameUpdateRequest` payload: `PasskeyCredentialFriendlyNameUpdateRequestPod` followed by blob payload for credential friendly name.
- `AuthLoginFlow` payload: `AuthLoginFlowPod`; field semantics are `accountId`, `identityKind`, `authPhase`, `mfaMode`, and `challengeToken`. The old fixed-length text slots carry only `identityKind` and reserved bytes; they no longer carry legacy username or role.
- `CurrentUserSnapshot` payload: `CurrentUserSnapshotPod`; retained only for admin-only accountId queries, migration, and the refresh-token compatibility path. It is no longer the user-facing output of `/api/binary/auth/me` and does not support username lookup. Field semantics are `accountId`, `identityKind`, `status`, `banReason`, and `deletedAt`; username/role are not exposed.
- `IdentityAccountSnapshot` payload: `IdentityAccountSnapshotPod` followed by blob payload for public handle, anonymous credential status/level, identity kind, and ban reason. It is the `/api/binary/auth/me` output and must not expose internal username or role.
- `AuthSessionList` payload: `int32 count` followed by 500-byte `UserSessionSummaryPod[count]`. Each POD carries created/last-seen timestamps, current/optional flags, session id, coarse device label, authentication method/strength, duration policy, and an optional Passkey friendly name. It never carries an internal credential row id, device fingerprint, raw user agent/IP, token, long-lived MFA flag, or user id.
- `AdminSessionList` payload: `int32 count` followed by `AdminSessionSummaryPod[count]`; records expose admin session id, device fingerprint, user agent, timestamps and status flags, but not raw IP.
- `MfaSetupStart` payload: `MfaSetupStartPod` followed by blob payload for secret/OTP auth URL/issuer/account.
- `MfaSetupVerify` payload: `MfaSetupVerifyPod` followed by `MfaRecoveryCodePod[count]`.
- `MfaProfile` payload: `MfaProfilePod`.
- `MfaChallengeResult` payload: `MfaChallengeResultPod`; when a login challenge completes with `user`, it returns only `accountId` and `identityKind`, never legacy username/role.
- `ConversationList` payload: when `hasMore=true`, a 17-byte cursor envelope (`int32 0x4D534743`, `int32 version=1`, `byte hasMore`, `Utf8SliceRef nextCursor`) precedes `int32 total`, `int32 count`, `ConversationListItemPod[count]`, followed by the shared blob used by the cursor and subject/preview slices. A terminal/legacy payload may omit the envelope and starts at `total`; decoders normalize it to `nextCursor=null, hasMore=false` and reject unknown envelope versions or a missing cursor when `hasMore=true`.
- `ConversationDetail` payload: `ConversationDetailPod`, `int32 count`, `ConversationMessagePod[count]`, followed by shared blob payload for subject/body slices.
- `ConversationDetailV2` payload: `ConversationDetailV2Pod` (including `ReadSnapshotMessageId`), `int32 count`, `ConversationMessagePod[count]`, followed by shared blob payload for subject/body slices.
- `ConversationDetailV3` payload: 52-byte `ConversationDetailV3Pod` (including `ReadSnapshotMessageId`, `PreviousCursorMessageId`, and `HasOlder`), `int32 count`, `ConversationMessagePod[count]`, followed by the shared subject/body blob. `HasOlder=1` requires a positive previous cursor; terminal pages encode cursor `0`.
- `AdminConversationList` payload uses the same optional cursor envelope as `ConversationList`, followed by `total`, `count`, 92-byte `AdminConversationListItemPod[count]`, and the shared blob. Each item nests the unchanged 76-byte account list pod plus only `CounterpartyAccountId` and `CounterpartyAccountStatus`.
- `AdminConversationDetail` payload starts with a 68-byte `AdminConversationDetailPod` (the unchanged 52-byte v3 detail header plus the same minimal counterparty projection), followed by `int32 count`, `ConversationMessagePod[count]`, and the shared blob. These two frames are admin-only; account endpoints never emit them.
- `ConversationMessage` payload: `ConversationMessagePod` followed by blob payload for sender/body slices.
- `PasskeyRegisterBegin` payload: `PasskeyRegisterBeginPod`, `PasskeyPublicKeyCredentialParamPod[count]`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP, accountName, accountDisplayName, accountHandle, challenge, and credential-id slices. The account fields are Passkey-safe labels/handle and are mapped to WebAuthn `user.name`, `user.displayName`, and `user.id` only at the browser adapter boundary.
- `PasskeyLoginBegin` payload: `PasskeyLoginBeginPod`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP/challenge/credential-id slices.
- `PasskeyCredentialList` payload: `int32 count`, `PasskeyCredentialSummaryPod[count]`, followed by blob payload for optional device names.
- `PasskeySignalState` payload: 48-byte `PasskeySignalStatePod` (`Revision`, credential count and RP/user/name/display-name slice refs), `PasskeySignalCredentialPod[count]`, followed by the shared UTF-8 blob. The complete credential-id list is server authoritative and revision ordered; callers must not derive it from a locally filtered credential summary list.
- `ArticleRevisionRollbackRequest` payload: AEDS JSON payload containing required `baseRevisionId`, explicit `targetStatus` (`Draft`, `Published`, or `Archived`) and a bounded audit `reason`. The server creates a new immutable revision/release package and never reactivates the source row.
- `NotificationEvent` payload: `int64 EventId`, `int64 TimestampUnixMs`, `int32 NotificationStreamEventType`, `int32 Reserved`, followed by one binary value payload.
- `NotificationHeartbeat` payload: `int64 TimestampUnixMs`.
- `PublicAotBootstrap` payload: one binary value payload encoded with the same tagged value layout used by notifications; HTML embeds the full AEDS frame as base64url text in `application/octet-stream` script nodes.
- `RumMetricBatchRequest` payload: `RumMetricBatchRequestPod`, `RumMetricItemPod[count]`, `RumMetricValuePod[valueCount]`, `RumMetricDimensionPod[dimensionCount]`, followed by one UTF-8 blob for slices. The request frame is capped at 8192 bytes and carries only whitelisted names, numeric values and low-cardinality dimensions.
- `RumMetricIngestResponse` payload: `RumMetricIngestResponsePod` (`Accepted`, `AcceptedCount`, `RejectedCount`).
- `AnonymousCommentTicketRequest` payload: `AnonymousCommentTicketRequestPod` followed by blob payload for circuit id, nullifier hash, proof and public inputs. It is accepted only by `POST /api/binary/comment/anonymous-ticket`, capped at 32768 bytes, and must be submitted without Cookie, Authorization or session credentials. Scope is canonical `comment:v1:article:{articleId}:top` (one use per credential lifecycle) or `comment:v1:article:{articleId}:thread:{rootId}` (three uses per credential lifecycle); server validation rejects legacy or client-expanded scopes without changing the POD layout.
- `AnonymousCommentTicketResponse` payload: `AnonymousCommentTicketResponsePod` followed by blob payload for the opaque one-time ticket, moderation subject hash and anonymous nullifier hash. The server stores only `SHA256(ticket)` with a short TTL compact binary payload for consume-once anonymous submit.
- `BlindCredentialIssuerMetadata` payload: `BlindCredentialIssuerMetadataPod` followed by blob slices for circuit/profile/key metadata and a DER SubjectPublicKeyInfo. The profile is fixed to RFC 9474 randomized RSABSSA-SHA384-PSS with a 3072-bit modulus.
- `BlindCredentialIssueRequest` payload: `BlindCredentialIssueRequestPod` followed by metadata slices and one exact 384-byte blinded representative. It never carries the client opening, credential secret, finalized signature, commitment, revocation handle or nullifier.
- `BlindCredentialIssueResponse` payload: `BlindCredentialIssueResponsePod` followed by matching metadata slices and one exact 384-byte blind signature. The browser must unblind and verify it before storing credential material.
- `AuthorDraftSaveRequest`, `ArticlePreviewRequest`, `PrepublishCheckRequest`, `AiAssistRequest`, `AdminCacheActionRequest`, `IntegrityFixRequest`, `Moderation*Request`, `CommentModeration*Request`, `ContentImportRequest` and `ArticleResponsibilityRequest` payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. Draft save/response persists nullable `baseRevisionId` so delayed autosave and restore retain the original edit coordinate. These frames are accepted only by `/api/binary/author/**`, capped by the authoring request limit, and do not use the legacy `JsonApiResponse<T>` envelope. `ArticleResponsibilityRequest` carries `expectedVersion` for append-only CAS; `ArticleResponsibilityResponse` returns snapshot/version/previous/publication coordinates and the complete blocking/warning list without a score. `ArticleResponsibilityHistory(228)` returns one revision's versions newest first.
- Authoring response frames (`AuthorDraftResponse`, `ArticlePreviewResponse`, `AuthorAnalytics`, `AuditLog*`, `OpsHealth`, `Moderation*`, `Content*`, `Integrity*` and related list/result frames) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. Failures are always `ApiError`.
- `AntiCrawlerOptionsUpdateRequest`, `SecurityRiskResetRequest`, `AntiCrawlerRuleRequest`, `AntiCrawlerListEntryRequest`, `AntiCrawlerSimulationRequest`, `PowOptionsUpdateRequest` and admin security dry-run `SecurityOverview` requests payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. These frames are accepted only by `/api/binary/admin/security/**`, capped at 1 MiB, and do not use the legacy `JsonApiResponse<T>` envelope.
- Security response frames (`SecurityOverview`, `AntiCrawlerOverview`, `AntiCrawlerPolicySnapshot`, `CrawlerRangesAdminStatus`, `SecurityRisk*`, `AntiCrawlerRule*`, `AntiCrawlerListEntry*`, `AntiCrawlerSimulationResult`, `PowOverview` and `PowPolicySnapshot`) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. `SecurityOverview` also carries RiskControl dry-run responses for `/api/binary/admin/security/risk-control/simulate`. Failures are always `ApiError`.
- `AdminUserList` payload: `int32 total`, `int32 count`, followed by `UserListItemPod[count]` carrying anonymous account id, identity kind, public handle, Passkey/Recovery initialization state, anonymous credential status/level, risk flags and account status.
- `ArticleList` writers emit cursor envelope v2 before the records: `int32 magic=0x41535046` (`FSPA`), `int32 version=2`, `byte hasMore`, `int32 total`, length-prefixed UTF-8 `nextCursor` bytes (canonical base64url, at most 512 bytes), then `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, current `100B articleRecord[count]`, and `12B tagRecord[tagRecordCount]`. `hasMore=true` requires a non-empty cursor and `hasMore=false` requires an empty cursor. Decoders accept envelope v2 only and reject missing or unknown envelopes, invalid UTF-8/base64url cursor data, inconsistent cursor state, truncation, or trailing bytes. The current record extends the 76-byte lifecycle layout with `int64 currentRevisionId`, `int32 revisionNo`, `int64 currentPublicationId`, `int32 publicationNo`.
- `ArticleDetail` writers emit V5: the existing 44-byte offset header with `magic = 0x41524435` / `ARD5`, `version = 5`, `flags = 0`, the 116-byte `ArticleDetailV5RecordPod` (including `updatedAtUnixMs` and the same four publication coordinates), `ArticleDetailTagV3RecordPod[tagCount]`, required `ArticleRightsV3RecordPod`, and one shared UTF-8 blob. Decoders retain read-only compatibility with V4 (`ARD4`, 92-byte record) and V3 (`ARD3`, 84-byte record), mapping absent publication coordinates to zero/null and absent V3 `updatedAtUnixMs` to null/zero. Header offsets and lengths must exactly describe the selected record/blob ranges; all decoders reject the retired 424-byte `ArticleDetailPod`, mismatched magic/version pairs, missing rights records, truncated or out-of-range slices, and trailing bytes.
- `ArticleWriteRequest` writers emit V5 and append `baseRevisionId:int64` after the rights blob. Create writes zero; update must echo the positive `currentRevisionId` read from author detail. Article create/update/rollback `MutationId(241)` responses use the 48-byte `ArticleMutationResultPod` (`articleId`, `revisionId/revisionNo`, `releaseId/releaseNo`, `status`, `rightsSnapshotId/rightsRevisionNo`, `idempotencyReplay`, `errorCode`). A stale base returns HTTP 409 `ApiError` with stable `article_revision_conflict` semantics; PostgreSQL `xmin` is never serialized.
- `ArticleSearch` writers and readers use the single packed FSR4 layout (`magic = 0x34525346`, `version = 4`): exact 24-byte header, 76-byte item records, 12-byte tag records and UTF-8 blob. The protocol authority generates all layout projections, including the Wasm search writer. Unversioned fixed-POD, FAS4 fixed-POD and v3 result payloads are rejected; coordinates must contain positive revision identity/number and consistent publication presence. Offline search shard/package/manifest retain their own current v4 storage contracts.
- `ArticleHot` payload: `int32 count`, shared UTF-8 blob, `16B popularArticleRecord[count]`.
- `CategoryList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`. The list contract stays byte-compatible and does not carry description.
- `TagList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`. The list contract stays byte-compatible and does not carry description.
- `TaxonomyExactMetadata` payload: `int32 id`, shared UTF-8 blob, `Utf8SliceRef name`, `Utf8SliceRef description`. Description length 0 means null. This dedicated frame is independent of `CategoryList`/`TagList` and is used by `GET /api/binary/category/{id}.aeds`, `GET /api/binary/tag/{id}.aeds`, and `GET /api/binary/tag/by-name.aeds?name=`.
- `RecentCommentStats` payload: `int32 count`, shared UTF-8 blob, `56B recentCommentRecord[count]`. Each record stores `createTimeUnixMs` plus blob slices for `authorDisplayName`, `authorMode`, optional `authorBadge`, optional `authorScopeLabel`, optional `credentialLevel`, and `content`; it does not carry account identifiers or legacy display-name fields.
- `RegionStats` payload: `int32 count`, shared UTF-8 blob, `12B regionRecord[count]`.
- `SeoConfig` payload: `SeoConfigPod` (5000 bytes) followed by blob payload for variable description. Fixed fields are `title:Utf8Fixed256`, `description:Utf8SliceRef`, `keywords:Utf8Fixed256`, `author:Utf8Fixed64`, `ogImage:Utf8Fixed256`, `baseUrl:Utf8Fixed256`, then `faviconSvgUrl/faviconIcoUrl/faviconPngUrl/appleTouchIconUrl:Utf8Fixed256`, `manifestName/manifestShortName:Utf8Fixed128`, `pwaIcon192Url/pwaIcon512Url/pwaMaskableIconUrl:Utf8Fixed256`, `themeColor/backgroundColor:Utf8Fixed32`, `siteLogoUrl/siteLogoDarkUrl/siteWordmarkUrl/adminLogoUrl/adminCollapsedIconUrl/loginLogoUrl/loginIconUrl:Utf8Fixed256`.
- `PageContent` payload: `PageContentPod` followed by blob payload for markdown content.
- `ArticleFeatured` payload: `int32 count` followed by `FeaturedArticlePod + blob` items; the blob contains the cover image URL slice.
- `TrashClearResponse` payload: `TrashClearResponsePod` (`int32 Count`).

## Payload Dictionary Compatibility

The current compatible dictionary mechanism is the shared UTF-8 blob plus `Utf8SliceRef` records. Article list/search/category/tag/conversation payloads reuse one blob per payload and keep records fixed-width for cache-friendly decode. Frontend ArticlePage decode materializes final items directly from typed arrays and copies tag ranges with a tight loop instead of `records.map(...)` plus `tagRecords.slice(...)`.

A future `ArticleListV4` category/tag dictionary may add explicit category/tag dictionaries, but it must be introduced as a registered payload version with golden fixtures and downgrade/negative matrix coverage. It must not silently reinterpret the existing unflagged `ArticleList` record layout.

### Notification Binary Value

Notification payload values use a small tagged binary representation so the WebSocket stream is fully AEDS-native:

| Kind | Type | Layout |
| ---: | --- | --- |
| 0 | Null | no bytes |
| 1 | String | `int32 utf8Length`, `byte[utf8Length]` |
| 2 | Int32 | `int32 value` |
| 3 | Int64 | `int64 value` |
| 4 | Double | `float64 value` |
| 5 | Boolean | `byte 0/1` |
| 6 | Object | `int32 propertyCount`, repeated `string key`, `value` |
| 7 | Array | `int32 itemCount`, repeated `value` |

## Decode Checklist (C++/Wasm)

1. Read 16-byte header.
2. Check `Magic`, `Version == 2`, `HeaderLength == 16`, and `PayloadLength`.
3. Read payload block of `PayloadLength`.
4. Recompute and compare `PayloadCrc16`.
5. Decode payload using corresponding compact POD schema by `FrameType`.
