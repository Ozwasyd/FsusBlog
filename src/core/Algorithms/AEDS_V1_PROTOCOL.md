# AEDS v2 Protocol (Little Endian)

This file keeps the historical path for existing links, but the current wire protocol is AEDS v2 only. v1 frames are rejected by server, TypeScript, Worker, and Wasm decoders.

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
- `37`: CommentCreateRequest
- `38`: FileDeleteRequest
- `39`: AdminChangeUserStatusRequest
- `40`: AdminResetUserPasswordRequest
- `41`: ArticleWriteRequest
- `42`: ArticleAotBundleRequest (reserved legacy value; client AOT bundle uploads are no longer accepted)
- `43`: AuthLoginRequest
- `44`: AuthRegisterRequest
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
- `240`: EmptySuccess
- `241`: MutationId
- `251`: ApiError

## Common Response PODs

- `EmptySuccess` payload: `EmptySuccessPod` (`Ok = 1`, remaining bytes reserved).
- `MutationId` payload: `MutationIdPod` (`int64 Id`).
- `ApiError` payload: `ApiErrorPod` (`byte Code`, `byte Category`, `int32 HttpStatus`, fixed UTF-8 `Message`, `Details`, `TraceId`).
- `CategoryWriteRequest` / `TagWriteRequest` payload: `NameMutationRequestPod` (`Utf8Fixed128 Name`).
- `SeoConfigUpdateRequest` payload: same layout as `SeoConfig`.
- `PageContentUpdateRequest` payload: same layout as `PageContent`.
- `CommentCreateRequest` payload: `CommentCreateRequestPod` followed by blob payload for comment content.
- `FileDeleteRequest` payload: `StringMutationRequestPod` followed by blob payload for image URL.
- `AdminChangeUserStatusRequest` payload: `AdminChangeUserStatusRequestPod` followed by blob payload for reason.
- `AdminResetUserPasswordRequest` payload: `AdminResetUserPasswordRequestPod` followed by blob payload for password.
- `ArticleWriteRequest` payload: `ArticleWriteRequestPod`, `int32 tagIds[count]`, blob payload for title/content/summary/cover URL slices, then optional lifecycle tail `int32 status`, `int64 scheduledPublishAtUnixMs`. Missing lifecycle tail is decoded as `Published` with no schedule.
- `ArticleAotBundleRequest` payload: reserved legacy `PublicAotBundlePod`, `PublicAotEntryPod[count]`, followed by blob payload for entry strings. No server route accepts this frame.
- `AuthLoginRequest` payload: `AuthLoginRequestPod` followed by blob payload for username/password.
- `AuthRegisterRequest` payload: `AuthRegisterRequestPod` followed by blob payload for username/password/confirm password.
- `AuthUpdateUsernameRequest` payload: `StringMutationRequestPod` followed by blob payload for the new username.
- `AuthUpdatePasswordRequest` payload: `AuthUpdatePasswordRequestPod` followed by blob payload for old/new/confirm password.
- `AuthDeleteAccountRequest` payload: `AuthDeleteAccountRequestPod` followed by blob payload for password/confirm text/MFA code/recovery code.
- `MfaSetupVerifyRequest` payload: `StringMutationRequestPod` followed by blob payload for the TOTP code.
- `MfaPasswordProofRequest` payload: `MfaPasswordProofRequestPod` followed by blob payload for password/TOTP/recovery code.
- `MfaChallengeStartRequest` payload: `StringMutationRequestPod` followed by blob payload for action.
- `MfaChallengeVerifyRequest` payload: `MfaChallengeVerifyRequestPod` followed by blob payload for challenge token/action/TOTP/recovery code.
- `ConversationCreateRequest` payload: `ConversationCreateRequestPod` followed by blob payload for subject/body.
- `ConversationReplyRequest` payload: `StringMutationRequestPod` followed by blob payload for body.
- `ConversationStatusRequest` payload: `ConversationStatusRequestPod` (`0=open`, `1=pending`, `2=closed`).
- `SystemMessageRequest` payload: `SystemMessageRequestPod` followed by blob payload for subject/body.
- `PasskeyRegisterCompleteRequest` payload: `PasskeyRegisterCompleteRequestPod`, `int32 transports[count]`, followed by blob payload for credential id/raw id/clientDataBytes/attestation object/friendly name/MFA proof token.
- `PasskeyLoginCompleteRequest` payload: `PasskeyLoginCompleteRequestPod` followed by blob payload for credential id/raw id/clientDataBytes/authenticator data/signature/user handle.
- `PasskeyRenameRequest` payload: `StringMutationRequestPod` followed by blob payload for device friendly name.
- `AuthLoginFlow` payload: `AuthLoginFlowPod`.
- `CurrentUserSnapshot` payload: `CurrentUserSnapshotPod`.
- `AuthSessionList` payload: `int32 count` followed by `UserSessionSummaryPod[count]`.
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
- `NotificationEvent` payload: `int64 EventId`, `int64 TimestampUnixMs`, `int32 SseEventType`, `int32 Reserved`, followed by one binary value payload.
- `NotificationHeartbeat` payload: `int64 TimestampUnixMs`.
- `PublicAotBootstrap` payload: one binary value payload encoded with the same tagged value layout used by notifications; HTML embeds the full AEDS frame as base64url text in `application/octet-stream` script nodes.
- `AdminUserList` payload: `int32 total`, `int32 count`, followed by `UserListItemPod[count]`.
- `ArticleList` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `76B articleRecord[count]`, `12B tagRecord[tagRecordCount]`. The final 20 bytes of each article record are `int32 status`, `int64 scheduledPublishAtUnixMs`, `int64 publishedAtUnixMs`.
- `ArticleDetail` payload: `ArticleDetailPod`, `int32 tagCount`, `TagPod[tagCount]`, text blob, cover blob, `byte isDeleted`, then optional lifecycle tail `int32 status`, `int64 scheduledPublishAtUnixMs`, `int64 publishedAtUnixMs`.
- `ArticleSearch` payload: `int32 total`, `int32 count`, `int32 tagRecordCount`, shared UTF-8 blob, `52B searchRecord[count]`, `12B tagRecord[tagRecordCount]`.
- `ArticleHot` payload: `int32 count`, shared UTF-8 blob, `16B popularArticleRecord[count]`.
- `CategoryList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
- `TagList` payload: `int32 count`, shared UTF-8 blob, `16B taxonomyRecord[count]`.
- `RecentCommentStats` payload: `int32 count`, shared UTF-8 blob, `32B recentCommentRecord[count]`.
- `RegionStats` payload: `int32 count`, shared UTF-8 blob, `12B regionRecord[count]`.
- `SeoConfig` payload: `SeoConfigPod` followed by blob payload for variable description.
- `PageContent` payload: `PageContentPod` followed by blob payload for markdown content.
- `ArticleFeatured` payload: `int32 count` followed by `FeaturedArticlePod + blob` items; the blob contains the cover image URL slice.
- `TrashClearResponse` payload: `TrashClearResponsePod` (`int32 Count`).

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
