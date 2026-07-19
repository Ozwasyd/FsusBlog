# AEDS v2 Protocol (Little Endian)

This file is the current wire protocol specification. AEDS v2 is the only accepted runtime frame version; v1 frames are rejected by server, TypeScript, Worker, and Wasm decoders.

## Generated Contract Surfaces

`src/shared/Contracts/Validation/aeds-protocol.json` is the single machine-readable source for the v2 header and active frame types. Run `node tools/frontend/generate-aeds-protocol.mjs` after changing the manifest. The generator owns these files; do not edit them by hand:

- `src/core/Algorithms/AedsFrameType.cs`
- `src/shared/AedsFrameType.cs`
- `src/shared/AedsFrameHeader.cs`
- `src/frontend/src/wasm/web/protocol/frame.ts`
- `src/frontend/wasm/aeds/include/aeds_frame.hpp`

Core, backend, benchmarks, and backend tests import the generated Shared packed header instead of defining another `AedsFrameHeader`. `node tools/frontend/generate-aeds-protocol.mjs --check` fails when any generated surface is stale. The cross-stack frame-schema check also compiles the production C++ decoder, runs every active manifest value through it, and decodes a C# golden frame. C++ callers use generated `IsKnownFrameType`; values absent from the active manifest, including retired slots, must be rejected rather than silently accepted.

## Frame Layout

- Header: 16 bytes
- Payload: compact POD bytes (from `PodBinaryCodec`)

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

- `PayloadCrc16 = CRC16(payload bytes)`
- CRC16 uses polynomial `0xA001` with initial value `0xffff`.
- v2 does not include a header CRC. Header integrity is validated by magic, version, header length, frame type, payload length, and transport framing.

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
- `166`: CommentCreateV2Request
- `177`: AnonymousCredentialIssueRequest
- `178`: AnonymousCredentialIssueResponse
- `179`: AnonymousCredentialRootSnapshot
- `180`: AnonymousCommentTicketRequest
- `181`: AnonymousCommentTicketResponse
- `182`: AnonymousCommentCreateRequest
- `183`: AnonymousPrivacyStateSnapshot
- `184`: PerceptionSealedChallengeV2
- `185`: PerceptionSealedResultV2
- `186`: RetiredCredentialSpecificRevocationRequest (永久拒绝，不得重新承载 handle/body)
- `187`: RetiredCredentialSpecificRevocationResponse (永久保留编号，不再发送)
- `196`: AnonymousCredentialRevocationSnapshot
- `197`: AnonymousCredentialRevocationDelta
- `205`: CommentCreateResult
- `240`: EmptySuccess
- `241`: MutationId
- `251`: ApiError

`CommentArticleCursor`, `CommentThreadReplyCursor`, and `CommentUserCursor` records do not carry fixed legacy display-name slots. Each item blob stores the content slice first, then appends two length-prefixed `CommentAuthorView` payloads: required `author` and optional `replyToAuthor`. Decoders must reject missing author payloads instead of reconstructing display authors from legacy identity strings.

## Common Response PODs

- `EmptySuccess` payload: `EmptySuccessPod` (`Ok = 1`, remaining bytes reserved).
- `CommentCreateResult` payload: 16-byte `CommentCreateResultPod` (`int64 commentId`, `int32 moderationStatus`, `uint8 visibilityState`, `uint8 isPubliclyVisible`, two reserved zero bytes). Visibility values are `0 pending`, `1 public`, `2 hidden`, `3 rejected`.
- `MutationId` payload: `MutationIdPod` (`int64 Id`).
- `ApiError` payload: `ApiErrorPod` (`byte Code`, `byte Category`, `int32 HttpStatus`, fixed UTF-8 `Message`, `Details`, `TraceId`).
- `CategoryWriteRequest` / `TagWriteRequest` payload: `NameMutationRequestPod` (`Utf8Fixed128 Name`).
- `SeoConfigUpdateRequest` payload: same layout as `SeoConfig`.
- `PageContentUpdateRequest` payload: same layout as `PageContent`.
- `CommentCreateV2Request` payload: `CommentCreateV2RequestPod` followed by shared blob payload for anonymous scope, display language, proof token, ZK proof bytes, and comment content. The legacy `replyToUserId` compatibility slot at POD offset 4 and its presence flag at offset 11 are reserved and MUST be encoded as `0/0`; reply targets are identified by `replyToCommentId`.
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
- `SecurityChallengeAssignment` payload: `SecurityChallengeAssignmentPod`; fields include challenge id, traceparent, tenant id, kind, escalation level, action, route key, subject/client IP/device fingerprint hashes, issued time and expiry time. Non-captcha challenge ids are UUID v7; captcha assignment decoding accepts UUID v4 or v7.
- `SecurityChallengeEnvelope` payload: `SecurityChallengeEnvelopePod` followed by `SecurityChallengeAssignmentPod[count]`; count is capped by the shared contract.
- `PerceptionSealedChallengeV2` payload: `PerceptionSealedChallengeV2Pod` followed by blob payload for render recipe base64, sealed token base64, family and variant. `Algorithm` is fixed to `fsu.challenge/perception-sealed@v2`; `TaskKind` maps to `perceptionCharacterV2`, `perceptionLocalizationV2` or `perceptionMicroInteractionV2`.
- `PerceptionSealedResultV2` payload: `PerceptionSealedResultV2Pod` followed by blob payload for response payload base64 and sealed token base64. `PayloadKind` supports character, coordinates and steps response payloads and must match `TaskKind`.
- `ConversationCreateRequest` payload: `ConversationCreateRequestPod` followed by blob payload for subject/body.
- `ConversationReplyRequest` payload: `StringMutationRequestPod` followed by blob payload for body.
- `ConversationReadRequest` payload: `ConversationReadRequestPod` with the exact visible `ReadThroughMessageId` returned by detail.
- `AccountConversationReplyRequest` payload: `AccountConversationReplyRequestPod` followed by blob payload for body; the account reply cursor is explicit and does not advance to the newly inserted self message.
- `ConversationStatusRequest` payload: `ConversationStatusRequestPod` (`0=open`, `1=pending`, `2=closed`).
- `SystemMessageRequest` payload: `SystemMessageRequestPod` followed by blob payload for subject/body.
- `PasskeyRegisterCompleteRequest` payload: `PasskeyRegisterCompleteRequestPod`, `int32 transports[count]`, followed by blob payload for credential id/raw id/clientDataBytes/attestation object/friendly name/MFA proof token.
- `PasskeyLoginCompleteRequest` payload: `PasskeyLoginCompleteRequestPod` followed by blob payload for credential id/raw id/clientDataBytes/authenticator data/signature/user handle.
- `PasskeyCredentialFriendlyNameUpdateRequest` payload: `PasskeyCredentialFriendlyNameUpdateRequestPod` followed by blob payload for credential friendly name.
- `AuthLoginFlow` payload: `AuthLoginFlowPod`；字段语义为 `accountId`、`identityKind`、`authPhase`、`mfaMode`、`challengeToken`。原定长文本槽位只承载 `identityKind` 和 reserved bytes，不再承载 legacy username 或 role。
- `CurrentUserSnapshot` payload: `CurrentUserSnapshotPod`；仅保留给 admin-only accountId 查询、迁移和 refresh-token 兼容路径，不再作为 `/api/binary/auth/me` 的用户侧输出，也不再支持 username lookup。字段语义为 `accountId`、`identityKind`、`status`、`banReason`、`deletedAt`，不再暴露 username/role。
- `IdentityAccountSnapshot` payload: `IdentityAccountSnapshotPod` followed by blob payload for public handle、anonymous credential status/level、identity kind and ban reason. It is the `/api/binary/auth/me` output and must not expose internal username or role.
- `AuthSessionList` payload: `int32 count` followed by `UserSessionSummaryPod[count]`.
- `AdminSessionList` payload: `int32 count` followed by `AdminSessionSummaryPod[count]`; records expose admin session id, device fingerprint, user agent, timestamps and status flags, but not raw IP.
- `MfaSetupStart` payload: `MfaSetupStartPod` followed by blob payload for secret/OTP auth URL/issuer/account.
- `MfaSetupVerify` payload: `MfaSetupVerifyPod` followed by `MfaRecoveryCodePod[count]`.
- `MfaProfile` payload: `MfaProfilePod`.
- `MfaChallengeResult` payload: `MfaChallengeResultPod`；当登录 challenge 完成并包含 `user` 时，只返回 `accountId` 与 `identityKind`，不返回 legacy username/role。
- `ConversationList` payload: when `hasMore=true`, a 17-byte cursor envelope (`int32 0x4D534743`, `int32 version=1`, `byte hasMore`, `Utf8SliceRef nextCursor`) precedes `int32 total`, `int32 count`, `ConversationListItemPod[count]`, followed by the shared blob used by the cursor and subject/preview slices. A terminal/legacy payload may omit the envelope and starts at `total`; decoders normalize it to `nextCursor=null, hasMore=false` and reject unknown envelope versions or a missing cursor when `hasMore=true`.
- `ConversationDetail` payload: `ConversationDetailPod`, `int32 count`, `ConversationMessagePod[count]`, followed by shared blob payload for subject/body slices.
- `ConversationDetailV2` payload: `ConversationDetailV2Pod` (including `ReadSnapshotMessageId`), `int32 count`, `ConversationMessagePod[count]`, followed by shared blob payload for subject/body slices.
- `ConversationDetailV3` payload: 52-byte `ConversationDetailV3Pod` (including `ReadSnapshotMessageId`, `PreviousCursorMessageId`, and `HasOlder`), `int32 count`, `ConversationMessagePod[count]`, followed by the shared subject/body blob. `HasOlder=1` requires a positive previous cursor; terminal pages encode cursor `0`.
- `ConversationMessage` payload: `ConversationMessagePod` followed by blob payload for sender/body slices.
- `PasskeyRegisterBegin` payload: `PasskeyRegisterBeginPod`, `PasskeyPublicKeyCredentialParamPod[count]`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP, accountName, accountDisplayName, accountHandle, challenge, and credential-id slices. The account fields are Passkey-safe labels/handle and are mapped to WebAuthn `user.name`, `user.displayName`, and `user.id` only at the browser adapter boundary.
- `PasskeyLoginBegin` payload: `PasskeyLoginBeginPod`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP/challenge/credential-id slices.
- `PasskeyCredentialList` payload: `int32 count`, `PasskeyCredentialSummaryPod[count]`, followed by blob payload for optional device names.
- `NotificationEvent` payload: `int64 EventId`, `int64 TimestampUnixMs`, `int32 NotificationStreamEventType`, `int32 Reserved`, followed by one binary value payload.
- `NotificationHeartbeat` payload: `int64 TimestampUnixMs`.
- `PublicAotBootstrap` payload: one binary value payload encoded with the same tagged value layout used by notifications; HTML embeds the full AEDS frame as base64url text in `application/octet-stream` script nodes.
- `RumMetricBatchRequest` payload: `RumMetricBatchRequestPod`, `RumMetricItemPod[count]`, `RumMetricValuePod[valueCount]`, `RumMetricDimensionPod[dimensionCount]`, followed by one UTF-8 blob for slices. The request frame is capped at 8192 bytes and carries only whitelisted names, numeric values and low-cardinality dimensions.
- `RumMetricIngestResponse` payload: `RumMetricIngestResponsePod` (`Accepted`, `AcceptedCount`, `RejectedCount`).
- `AnonymousCommentTicketRequest` payload: `AnonymousCommentTicketRequestPod` followed by blob payload for circuit id, nullifier hash, proof and public inputs. It is accepted only by `POST /api/binary/comment/anonymous-ticket`, capped at 32768 bytes, and must be submitted without Cookie, Authorization or session credentials.
- `AnonymousCommentTicketResponse` payload: `AnonymousCommentTicketResponsePod` followed by blob payload for the opaque one-time ticket, moderation subject hash and anonymous nullifier hash. The server stores only `SHA256(ticket)` with a short TTL compact binary payload for consume-once anonymous submit.
- `BlindCredentialIssuerMetadata` payload: `BlindCredentialIssuerMetadataPod` followed by blob slices for circuit/profile/key metadata and a DER SubjectPublicKeyInfo. The profile is fixed to RFC 9474 randomized RSABSSA-SHA384-PSS with a 3072-bit modulus.
- `BlindCredentialIssueRequest` payload: `BlindCredentialIssueRequestPod` followed by metadata slices and one exact 384-byte blinded representative. It never carries the client opening, credential secret, finalized signature, commitment, revocation handle or nullifier.
- `BlindCredentialIssueResponse` payload: `BlindCredentialIssueResponsePod` followed by matching metadata slices and one exact 384-byte blind signature. The browser must unblind and verify it before storing credential material.
- `AuthorDraftSaveRequest`, `ArticlePreviewRequest`, `PrepublishCheckRequest`, `AiAssistRequest`, `AdminCacheActionRequest`, `IntegrityFixRequest`, `Moderation*Request`, `CommentModeration*Request`, `ContentImportRequest` and `ArticleResponsibilityRequest` payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. These frames are accepted only by `/api/binary/author/**`, capped by the authoring request limit, and do not use the legacy `JsonApiResponse<T>` envelope. `ArticleResponsibilityResponse` returns the saved revision identity and the complete blocking/warning list without a score.
- Authoring response frames (`AuthorDraftResponse`, `ArticlePreviewResponse`, `AuthorAnalytics`, `AuditLog*`, `OpsHealth`, `Moderation*`, `Content*`, `Integrity*` and related list/result frames) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. Failures are always `ApiError`.
- `AntiCrawlerOptionsUpdateRequest`, `SecurityRiskResetRequest`, `AntiCrawlerRuleRequest`, `AntiCrawlerListEntryRequest`, `AntiCrawlerSimulationRequest`, `PowOptionsUpdateRequest` and admin security dry-run `SecurityOverview` requests payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. These frames are accepted only by `/api/binary/admin/security/**`, capped at 1 MiB, and do not use the legacy `JsonApiResponse<T>` envelope.
- Security response frames (`SecurityOverview`, `AntiCrawlerOverview`, `AntiCrawlerPolicySnapshot`, `CrawlerRangesAdminStatus`, `SecurityRisk*`, `AntiCrawlerRule*`, `AntiCrawlerListEntry*`, `AntiCrawlerSimulationResult`, `PowOverview` and `PowPolicySnapshot`) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. `SecurityOverview` also carries RiskControl dry-run responses for `/api/binary/admin/security/risk-control/simulate`. Failures are always `ApiError`.
- `AdminUserList` payload: `int32 total`, `int32 count`, followed by `UserListItemPod[count]` carrying anonymous account id, identity kind, public handle, Passkey/Recovery initialization state, anonymous credential status/level, risk flags and account status.
- `ArticleList` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `76B articleRecord[count]`, `12B tagRecord[tagRecordCount]`. The final 20 bytes of each article record are `int32 status`, `int64 scheduledPublishAtUnixMs`, `int64 publishedAtUnixMs`.
- `ArticleDetail` writers emit V4: `ArticleDetailV4HeaderPod` (`magic = 0x41524434` / `ARD4`, `version = 4`, `flags = 0`), the 92-byte `ArticleDetailV4RecordPod` (including `updatedAtUnixMs`), `ArticleDetailTagV3RecordPod[tagCount]`, required `ArticleRightsV3RecordPod`, and one shared UTF-8 blob. Decoders retain read-only compatibility with V3 (`ARD3`, version 3, 84-byte `ArticleDetailV3RecordPod`), mapping its absent `updatedAtUnixMs` to null/zero. Header offsets and lengths must exactly describe the selected record/blob ranges; all decoders reject the retired 424-byte `ArticleDetailPod`, mismatched magic/version pairs, missing rights records, truncated or out-of-range slices, and trailing bytes.
- `ArticleSearch` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `52B searchRecord[count]`, `12B tagRecord[tagRecordCount]`.
- `ArticleHot` payload: `int32 count`, shared UTF-8 blob, `16B popularArticleRecord[count]`.
- `CategoryList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
- `TagList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
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
