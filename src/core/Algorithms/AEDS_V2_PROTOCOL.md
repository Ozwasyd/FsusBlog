# AEDS v2 Protocol (Little Endian)

This file is the current wire protocol specification. AEDS v2 is the only accepted runtime frame version; v1 frames are rejected by server, TypeScript, Worker, and Wasm decoders.

## Frame Layout

- Header: 16 bytes
- Payload: compact POD bytes (from `PodBinaryCodec`)

| Offset | Size | Field | Type |
|---|---:|---|---|
| 0 | 4 | Magic | `uint32` (`0x53444541`, bytes: `41 45 44 53`, text: `AEDS`) |
| 4 | 1 | Version | `uint8` (`2`) |
| 5 | 1 | HeaderLength | `uint8` (`16`) |
| 6 | 2 | Flags | `uint16` |
| 8 | 2 | FrameType | `uint16` |
| 10 | 4 | PayloadLength | `uint32` |
| 14 | 2 | PayloadCrc16 | `uint16` |

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
- `40`: AdminResetUserPasswordRequest (retired; codec compatibility only, no production endpoint)
- `41`: ArticleWriteRequest
- `42`: ArticleAotBundleRequest (reserved legacy value; client AOT bundle uploads are no longer accepted)
- `43`: AuthLoginRequest (reserved legacy password login request; no production server route)
- `44`: AuthRegisterRequest (reserved legacy password register request; no production server route)
- `45`: AuthUpdateUsernameRequest
- `46`: AuthUpdatePasswordRequest
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
- `68`: PasskeyRenameRequest
- `69`: NotificationEvent
- `70`: NotificationHeartbeat
- `71`: PublicAotBootstrap
- `72`: SiteComplianceConfigUpdateRequest
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
- `186`: AnonymousCredentialRevocationWitnessRequest
- `187`: AnonymousCredentialRevocationWitnessResponse
- `240`: EmptySuccess
- `241`: MutationId
- `251`: ApiError

`CommentArticleCursor` and `CommentThreadReplyCursor` item blobs keep the fixed POD content slice unchanged, then append two length-prefixed `CommentAuthorView` payloads: required `author` and optional `replyToAuthor`. Decoders must reject missing author payloads instead of reconstructing display authors from `userName`.

## Common Response PODs

- `EmptySuccess` payload: `EmptySuccessPod` (`Ok = 1`, remaining bytes reserved).
- `MutationId` payload: `MutationIdPod` (`int64 Id`).
- `ApiError` payload: `ApiErrorPod` (`byte Code`, `byte Category`, `int32 HttpStatus`, fixed UTF-8 `Message`, `Details`, `TraceId`).
- `CategoryWriteRequest` / `TagWriteRequest` payload: `NameMutationRequestPod` (`Utf8Fixed128 Name`).
- `SeoConfigUpdateRequest` payload: same layout as `SeoConfig`.
- `PageContentUpdateRequest` payload: same layout as `PageContent`.
- `CommentCreateV2Request` payload: `CommentCreateV2RequestPod` followed by shared blob payload for anonymous scope, display language, proof token, ZK proof bytes, and comment content.
- `FileDeleteRequest` payload: `StringMutationRequestPod` followed by blob payload for image URL.
- `AdminChangeUserStatusRequest` payload: `AdminChangeUserStatusRequestPod` followed by blob payload for reason.
- `AdminResetUserPasswordRequest` payload: retired compatibility frame. Production endpoints must not accept this frame or expose an admin password reset route.
- `ArticleWriteRequest` payload: `ArticleWriteRequestPod`, `int32 tagIds[count]`, blob payload for title/content/summary/cover URL slices, then optional lifecycle tail `int32 status`, `int64 scheduledPublishAtUnixMs`. Missing lifecycle tail is decoded as `Published` with no schedule.
- `ArticleAotBundleRequest` payload: reserved legacy `PublicAotBundlePod`, `PublicAotEntryPod[count]`, followed by blob payload for entry strings. No server route accepts this frame.
- `AuthLoginRequest` payload: reserved legacy `AuthLoginRequestPod` followed by blob payload for username/password. No production server route accepts this frame.
- `AuthRegisterRequest` payload: reserved legacy `AuthRegisterRequestPod` followed by blob payload for username/password/confirm password. No production server route accepts this frame.
- `AuthUpdateUsernameRequest` payload: `StringMutationRequestPod` followed by blob payload for the new username.
- `AuthUpdatePublicHandleRequest` payload: `StringMutationRequestPod` followed by blob payload for the new public handle; an empty string clears the handle.
- `AuthUpdatePasswordRequest` payload: `AuthUpdatePasswordRequestPod` followed by blob payload for old/new/confirm password.
- `AuthDeleteAccountRequest` payload: `AuthDeleteAccountRequestPod` followed by blob payload for confirm text only. Account deletion step-up proof is carried by `X-Fsus-Mfa-Proof`, not by password, TOTP code, or recovery-code fields.
- `MfaSetupVerifyRequest` payload: `StringMutationRequestPod` followed by blob payload for the TOTP code.
- `MfaPasswordProofRequest` payload: `MfaPasswordProofRequestPod` followed by blob payload for password/TOTP/recovery code.
- `MfaChallengeStartRequest` payload: `StringMutationRequestPod` followed by blob payload for action.
- `MfaChallengeVerifyRequest` payload: `MfaChallengeVerifyRequestPod` followed by blob payload for challenge token/action/TOTP/recovery code.
- `RecoveryKeyCreateResponse` payload: `RecoveryKeyCreateResponsePod` followed by blob payload for the one-time plaintext account Recovery Key. The plaintext is returned only by create/rotate responses and is never persisted server-side.
- `RecoveryKeyVerifyRequest` payload: `RecoveryKeyVerifyRequestPod` followed by blob payload for the account Recovery Key. It carries `UserId`, `RevokeSessions` and `RevokePasskeys` flags and is accepted only by the anonymous recovery verification endpoint.
- `RecoveryKeyVerifyResponse` payload: `RecoveryKeyVerifyResponsePod` with a short-lived recovery session token used only to bind a new Passkey after successful Recovery Key verification.
- `RecoveryKeySessionRequest` payload: `StringMutationRequestPod` followed by blob payload for that recovery session token. Passkey recovery completion reuses `PasskeyRegisterCompleteRequest` and carries the recovery session token in `MfaProofToken`; this is a Recovery Key step-up, not a TOTP MFA recovery-code path.
- `SecurityChallengeAssignment` payload: `SecurityChallengeAssignmentPod`; fields include challenge id, traceparent, tenant id, kind, escalation level, action, route key, subject/client IP/device fingerprint hashes, issued time and expiry time. Non-captcha challenge ids are UUID v7; captcha assignment decoding accepts UUID v4 or v7.
- `SecurityChallengeEnvelope` payload: `SecurityChallengeEnvelopePod` followed by `SecurityChallengeAssignmentPod[count]`; count is capped by the shared contract.
- `PerceptionSealedChallengeV2` payload: `PerceptionSealedChallengeV2Pod` followed by blob payload for render recipe base64, sealed token base64, family and variant. `Algorithm` is fixed to `fsu.challenge/perception-sealed@v2`; `TaskKind` maps to `perceptionCharacterV2`, `perceptionLocalizationV2` or `perceptionMicroInteractionV2`.
- `PerceptionSealedResultV2` payload: `PerceptionSealedResultV2Pod` followed by blob payload for response payload base64 and sealed token base64. `PayloadKind` supports character, coordinates and steps response payloads and must match `TaskKind`.
- `ConversationCreateRequest` payload: `ConversationCreateRequestPod` followed by blob payload for subject/body.
- `ConversationReplyRequest` payload: `StringMutationRequestPod` followed by blob payload for body.
- `ConversationStatusRequest` payload: `ConversationStatusRequestPod` (`0=open`, `1=pending`, `2=closed`).
- `SystemMessageRequest` payload: `SystemMessageRequestPod` followed by blob payload for subject/body.
- `PasskeyRegisterCompleteRequest` payload: `PasskeyRegisterCompleteRequestPod`, `int32 transports[count]`, followed by blob payload for credential id/raw id/clientDataBytes/attestation object/friendly name/MFA proof token.
- `PasskeyLoginCompleteRequest` payload: `PasskeyLoginCompleteRequestPod` followed by blob payload for credential id/raw id/clientDataBytes/authenticator data/signature/user handle.
- `PasskeyRenameRequest` payload: `StringMutationRequestPod` followed by blob payload for device friendly name.
- `AuthLoginFlow` payload: `AuthLoginFlowPod`.
- `CurrentUserSnapshot` payload: `CurrentUserSnapshotPod`；仅保留给 admin-only legacy lookup、迁移和 refresh-token 兼容路径，不再作为 `/api/binary/auth/me` 的用户侧输出。
- `IdentityAccountSnapshot` payload: `IdentityAccountSnapshotPod` followed by blob payload for public handle、anonymous credential status/level、identity kind and ban reason. It is the `/api/binary/auth/me` output and must not expose internal username or role.
- `AuthSessionList` payload: `int32 count` followed by `UserSessionSummaryPod[count]`.
- `AdminSessionList` payload: `int32 count` followed by `AdminSessionSummaryPod[count]`.
- `MfaSetupStart` payload: `MfaSetupStartPod` followed by blob payload for secret/OTP auth URL/issuer/account.
- `MfaSetupVerify` payload: `MfaSetupVerifyPod` followed by `MfaRecoveryCodePod[count]`.
- `MfaProfile` payload: `MfaProfilePod`.
- `MfaChallengeResult` payload: `MfaChallengeResultPod`.
- `ConversationList` payload: `int32 total`, `int32 count`, `ConversationListItemPod[count]`, followed by shared blob payload for subject/preview slices.
- `ConversationDetail` payload: `ConversationDetailPod`, `int32 count`, `ConversationMessagePod[count]`, followed by shared blob payload for subject/body slices.
- `ConversationMessage` payload: `ConversationMessagePod` followed by blob payload for sender/body slices.
- `PasskeyRegisterBegin` payload: `PasskeyRegisterBeginPod`, `PasskeyPublicKeyCredentialParamPod[count]`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP/user/challenge/credential-id slices.
- `PasskeyLoginBegin` payload: `PasskeyLoginBeginPod`, `PasskeyCredentialDescriptorPod[count]` with transport lists, followed by shared blob payload for RP/challenge/credential-id slices.
- `PasskeyCredentialList` payload: `int32 count`, `PasskeyCredentialSummaryPod[count]`, followed by blob payload for optional device names.
- `NotificationEvent` payload: `int64 EventId`, `int64 TimestampUnixMs`, `int32 NotificationStreamEventType`, `int32 Reserved`, followed by one binary value payload.
- `NotificationHeartbeat` payload: `int64 TimestampUnixMs`.
- `PublicAotBootstrap` payload: one binary value payload encoded with the same tagged value layout used by notifications; HTML embeds the full AEDS frame as base64url text in `application/octet-stream` script nodes.
- `RumMetricBatchRequest` payload: `RumMetricBatchRequestPod`, `RumMetricItemPod[count]`, `RumMetricValuePod[valueCount]`, `RumMetricDimensionPod[dimensionCount]`, followed by one UTF-8 blob for slices. The request frame is capped at 8192 bytes and carries only whitelisted names, numeric values and low-cardinality dimensions.
- `RumMetricIngestResponse` payload: `RumMetricIngestResponsePod` (`Accepted`, `AcceptedCount`, `RejectedCount`).
- `AnonymousCommentTicketRequest` payload: `AnonymousCommentTicketRequestPod` followed by blob payload for circuit id, nullifier hash, proof and public inputs. It is accepted only by `POST /api/binary/comment/anonymous-ticket`, capped at 32768 bytes, and must be submitted without Cookie, Authorization or session credentials.
- `AnonymousCommentTicketResponse` payload: `AnonymousCommentTicketResponsePod` followed by blob payload for the opaque one-time ticket, moderation subject hash and anonymous nullifier hash. The server stores only `SHA256(ticket)` with a short TTL compact binary payload for consume-once anonymous submit.
- `AuthorDraftSaveRequest`, `ArticlePreviewRequest`, `PrepublishCheckRequest`, `AiAssistRequest`, `AdminCacheActionRequest`, `IntegrityFixRequest`, `Moderation*Request`, `CommentModeration*Request` and `ContentImportRequest` payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. These frames are accepted only by `/api/binary/author/**`, capped at 8 MiB, and do not use the legacy `JsonApiResponse<T>` envelope.
- Authoring response frames (`AuthorDraftResponse`, `ArticlePreviewResponse`, `AuthorAnalytics`, `AuditLog*`, `OpsHealth`, `Moderation*`, `Content*`, `Integrity*` and related list/result frames) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. Failures are always `ApiError`.
- `AntiCrawlerOptionsUpdateRequest`, `SecurityRiskResetRequest`, `AntiCrawlerRuleRequest`, `AntiCrawlerListEntryRequest`, `AntiCrawlerSimulationRequest`, `PowOptionsUpdateRequest` and admin security dry-run `SecurityOverview` requests payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 request frame. These frames are accepted only by `/api/binary/admin/security/**`, capped at 1 MiB, and do not use the legacy `JsonApiResponse<T>` envelope.
- Security response frames (`SecurityOverview`, `AntiCrawlerOverview`, `AntiCrawlerPolicySnapshot`, `CrawlerRangesAdminStatus`, `SecurityRisk*`, `AntiCrawlerRule*`, `AntiCrawlerListEntry*`, `AntiCrawlerSimulationResult`, `PowOverview` and `PowPolicySnapshot`) payload: route-specific typed DTO encoded as UTF-8 JSON bytes inside an AEDS v2 response frame. `SecurityOverview` also carries RiskControl dry-run responses for `/api/binary/admin/security/risk-control/simulate`. Failures are always `ApiError`.
- `AdminUserList` payload: `int32 total`, `int32 count`, followed by `UserListItemPod[count]` carrying anonymous account id, identity kind, public handle, Passkey/Recovery initialization state, anonymous credential status/level, risk flags and account status.
- `ArticleList` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `76B articleRecord[count]`, `12B tagRecord[tagRecordCount]`. The final 20 bytes of each article record are `int32 status`, `int64 scheduledPublishAtUnixMs`, `int64 publishedAtUnixMs`.
- `ArticleDetail` payload: `ArticleDetailPod`, `int32 tagCount`, `TagPod[tagCount]`, text blob, cover blob, `byte isDeleted`, then optional lifecycle tail `int32 status`, `int64 scheduledPublishAtUnixMs`, `int64 publishedAtUnixMs`.
- `ArticleSearch` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `52B searchRecord[count]`, `12B tagRecord[tagRecordCount]`.
- `ArticleHot` payload: `int32 count`, shared UTF-8 blob, `16B popularArticleRecord[count]`.
- `CategoryList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
- `TagList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
- `RecentCommentStats` payload: `int32 count`, shared UTF-8 blob, `32B recentCommentRecord[count]`.
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
|---:|---|---|
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
