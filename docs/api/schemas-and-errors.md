# Error Codes, Binary Frame Format, and POD Size Catalog

This document is the **complete reference** for FsusBlog error-code enums, the AEDS v2 binary frame format, and POD type sizes.

---

## Contents

- [Error-code enum](#error-code-enum)
- [Negative responses](#negative-responses)
- [Production-readiness details](#production-readiness-details)
- [AEDS v2 frame format](#aeds-v2-frame-format)
- [AedsFrameType enum](#aedsframetype-enum)
- [POD size catalog](#pod-size-catalog)
- [C++ POD alignment rules](#c-pod-alignment-rules)

---

<a id="生产就绪详情"></a>

## Production-readiness details

Public `GET /health/ready` always returns only `status` and `checkedAt`. Protected `GET /api/ops/health/ready-detail` requires admin `audit.read`; its `checks.release` is a JSON operations check, not an AEDS frame, with `status`, `releaseId`, `releaseSlot`, full `commitSha`, immutable `imageRef=repository@sha256:...`, `imageDigest`, and optional `error`. `checks.deployment` also returns release/slot/mode/state/generation, `canReceiveTraffic`, `canClaimBackgroundWork`, and a drain snapshot; Draining bypasses the readiness cache and immediately makes the overall result `not_ready`. Every application response also carries `X-Fsus-Release-Id` and `X-Fsus-Release-Slot` for gateway verification of the actual upstream only; they do not change the body or AEDS frame. If production lacks any release-identity field, uses a mutable release/image reference, or has a mismatched digest, `checks.release.status=failed`, `error=release_identity_invalid`, and overall readiness must be `not_ready`.

The deployment-control JSON schema is request `{releaseId:string,slot:string,generation:int64,timeoutSeconds?:int32}` and response `{accepted:boolean,idempotent:boolean,status:string,errorCode?:string,snapshot:DeploymentRuntimeSnapshot}`; `status` is returned directly from the snapshot. Access requires admin `system.config` plus a loopback source. Invalid identity/generation/state returns 409; `trusted_host_required` returns
403. A drain-timeout snapshot must retain `drained=false,timedOut=true` and list `blockers`; hard
termination must not be rewritten as success. A public-hot drain participant uses `public_hot_activity_unavailable` when its first activity observation is missing and `public_hot_not_quiescent` when quiescence is not met, listing each failing field's exact current value in `blockers` (for example `in-flight-batch-count=1`, `store-state=Building`, and `published-generation=5<requested-drain-generation=7`). Any unavailable/negative/unknown field or collector failure blocks the drain; never assume zero. The notification stream returns `deployment_not_active` / `deployment_draining` with retryable 503 semantics in Candidate/Draining.

Active-release fence ops JSON is used only at `/api/ops/deployment/fence/status|acquire|revoke`, with identity key `releaseId + slot + generation + imageDigest`. `generation` must be positive and monotonic; a CAS expected-identity mismatch returns 409, and a Redis disconnect is never treated as local success. Notification-restart requests bind the same release/slot/generation; a successful connection uses WebSocket close code `1012` for an identifiable service restart and recovers through cursor replay. The drill-release request `{releaseId,slot,generation,drillId,count,dryRun}` bounds `count` to 1..32. Production configuration is disabled by default and returns 404; enabling it does not bypass admin `system.config`, loopback, active-runtime, or fence checks.

Schema-migration qualification uses narrow JSON negative responses and does not enter the AEDS `ApiError` enum:

| Route | HTTP | JSON code | Meaning |
| --- | ---: | --- | --- |
| `POST /api/release-evidence/schema-bridge/write` | 400 | `schema_qualification_write_invalid` | operationId/sequence violates the bounded tooling contract. |
| `GET /api/release-evidence/schema-qualification/readiness` | 503 | `schema_incompatible` | The isolated qualification scenario is marked missing Expand; the candidate cannot continue. |

Both routes exist only when the environment is exactly `Test` and `SchemaMigration:QualificationEnabled=true`; once registered they still require admin `system.config` plus `fixed_ip`. Responses carry release ID/slot headers and `no-store`. They are not registered in production, so these codes must not be treated as public runtime compatibility fallbacks.

---

<a id="错误码枚举"></a>

## Error-code enum

### Public status mapping authority

`src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs` owns the enumerable HTTP-status/`ErrorCode` transport mappings. Binary results, middleware and endpoint adapters consume typed `ApiErrorTransportMappingId` values and reject mismatched error codes. Generic status mappings, default statuses for error codes and operation-specific status pairs are distinct; an unregistered generic status fails closed rather than acquiring an implicit public mapping.

The compiled config/error observer and OpenAPI observer consume that production authority. Neither a wildcard/default entry nor a handwritten documentation table establishes the complete public status set. This does not change the AEDS frame, existing error-code values, authentication or response payload layout.

### Public HTML negative responses

Public HTML does not use an AEDS `ApiError` body. A search query over 2048 characters, normalized `q` over 128 characters, or a non-whitespace control character returns 400; an invalid path or missing/non-public entity returns 404; 410 is reserved for an explicitly permanent deletion; a provider, DB gate, or other transient dependency failure returns 503 with `Retry-After: 5`. These responses are standalone `noindex,follow` HTML with `Cache-Control: no-store`, `X-Robots-Tag: noindex, follow`, and `X-Fsus-Public-Aot-Backfill: none`; they contain no canonical, `og:url`, `BlogPosting`, SPA boot, or hydration payload.

| HTTP | `X-Fsus-Public-Aot-State` | Retry semantics |
| ------ | --------------------------- | ---------- |
| 400 | `invalid-request` | Shorten/correct the search query; never cache as a successful search page. |
| 404 | `not-found` | Change the URL or wait until content is truly public; never cache as a successful page. |
| 410 | `gone` | Explicit permanent deletion only; the current article-deletion model does not use it. |
| 503 | `transient-failure` | Retry according to `Retry-After`. |

GET and HEAD return the same status and key headers; HEAD preserves GET's `Content-Length` but has an empty body. A trailing slash other than `/` is not a negative response: it redirects 301 to the no-trailing-slash canonical.

Tag-name URLs are not success responses either: `/tag/{name}` resolves the current name or `tag_url_alias` using Unicode NFC plus invariant-case lookup, then redirects 301 to the unique `/tag/{id}` while preserving the query unchanged. An unresolved or normalization-ambiguous name returns the 404 above; never return the home page, a name self-canonical, or a multi-hop redirect.

Search-query canonical order is `q`, `sort`, `page`. Empty, duplicate, or unknown items, default `sort=relevance`, default `page=1`, and invalid sort/page values are removed or normalized through 301; no query term normalizes to `/search`. Successful search HTML and the 400 above are both `noindex,follow`, but only 400 uses a standalone `no-store` status page.

Error codes are written as fixed-width UTF-8 fields in the AEDS `ApiError` frame, grouped by module.

Message-content validation errors use `ErrorCode.Validation`: `message_subject_empty`, `message_body_empty`、`message_subject_scalar_limit_exceeded`、 `message_subject_grapheme_limit_exceeded`, `message_subject_utf8_limit_exceeded`, and the corresponding `message_body_*` codes. The binary binder returns Validation when a frame exceeds the shared 20 KiB limit. Error responses must not echo the original subject or body, and an over-limit failure must not mutate conversations, messages, outbox, or unread state.

### General errors

| Error code | HTTP status | Meaning |
| -------- | ----------- | ------ |
| `InvalidRequest` | 400 | Request-parameter format is invalid. |
| `Conflict` | 409 | The request conflicts with committed state. `draft_conflict` means stale `expectedServerRevision`; details contain only the current version, update time, and truncated title summary, so the client stops autosave and rereads for comparison. `article_responsibility_version_conflict` means stale `expectedVersion`; reread `ArticleResponsibilityHistory(228)` and merge manually. During the short refresh race window it means another tab completed rotation; do not revoke the session family. |
| `NotFound` | 404 | Resource does not exist. |
| `Unauthorized` | 401 | Not authenticated or token is invalid. |
| `Forbidden` | 403 | Insufficient permission. |
| `RateLimited` | 429 | Request rate exceeded. |
| `InfraFailure` | 500 | Infrastructure cannot complete the contract. A PublicHot delivery failure after a taxonomy write may follow a committed database mutation; reread admin taxonomy state before deciding whether to retry. |
| `InternalError` | 500 | Internal server error. |

### Authentication, PoW, MFA, Recovery, and Passkey errors

The active/retired/migration-only sets, operation/condition metadata, and transport mappings for these domain errors are carried only by the generated domain-error sections at the end of this document; no second hand-written error table is maintained.

### Content errors

| Error code | HTTP status | Meaning |
| -------- | ----------- | ------ |
| `ArticleNotFound` | 404 | Article does not exist. |
| `CommentNotFound` | 404 | Comment does not exist. |
| `CommentContentEmpty` | 400 | Comment content is empty. |
| `CommentContentTooLong` | 400 | Comment content exceeds the length limit. |
| `CategoryNotFound` | 404 | Category does not exist. |
| `TagNotFound` | 404 | Tag does not exist. |

Fixed comment-create idempotency failures: a public request missing or carrying an invalid `X-Fsus-Client-Mutation-Id` returns `400 comment_client_mutation_id_required` / `comment_client_mutation_id_invalid`; a public account with the same mutation ID, or an anonymous ticket commitment with a different normalized request, returns `409 comment_mutation_content_conflict`. Dynamic fail-closed mode returns `503 comment_mutation_idempotency_disabled`.

### Messaging-system errors

| Error code | HTTP status | Meaning |
| -------- | ----------- | ------ |
| `ConversationNotFound` | 404 | Conversation does not exist. |
| `ConversationClosed` | 400 | Conversation is closed; replies are not allowed. |
| `MessageNotFound` | 404 | Message does not exist. |
| `MessageRevoked` | 400 | Message has been revoked. |

Fixed message-write idempotency failures: missing/invalid `X-Fsus-Client-Mutation-Id` returns `400` `client_mutation_id_required` / `client_mutation_id_invalid`; the same mutation ID with different normalized content returns `409 client_mutation_content_conflict`. System messages with a missing/invalid `X-Fsus-Source-Event-Id` return `400 source_event_id_required` / `source_event_id_invalid`; content changes under the same source coordinates return `409 source_event_content_conflict`. Dynamic fail-closed mode returns `503 message_mutation_idempotency_disabled`.

### Binary / file-upload errors

| Error code | HTTP status | Meaning |
| -------- | ----------- | ------ |
| `UploadNotFound` | 404 | Upload task does not exist. |
| `UploadExpired` | 400 | Upload task has expired. |
| `UploadPartMissing` | 400 | Upload parts are incomplete. |
| `FileTooLarge` | 400 | File exceeds the size limit. |
| `FileTypeNotAllowed` | 400 | File type is not allowed. |

<a id="notification-stream-握手失败码"></a>

### Notification Stream handshake-failure codes

Notification-stream preflight and WebSocket handshake failures carry the following transport-level codes in the `X-Fsus-Notification-Stream-Error-Code` header, JSON preflight body, or AEDS `ApiError` frame:

| Failure code | HTTP status | Meaning |
| -------- | ----------- | ------ |
| `websocket_required` | 426 | The formal notification channel is not a WebSocket upgrade. |
| `protocol_mismatch` | 409 | `fsus-aeds.v2` subprotocol is missing or not accepted. |
| `auth_failed` | 401 | Authentication failed despite an auth header. |
| `pow_failed` | 401/400 | Anonymous connection supplied invalid legacy PoW. |
| `risk_challenge_required` | 428 | Anonymous `notification.subscribe` requires a completed aggregate RiskControl proof and supplied no legacy `pow` compatibility proof. |
| `risk_challenge_rejected` | 428 | Aggregate proof is missing, the envelope is incomplete/failed/expired/revoked/replayed, or action/route/identity/envelope/ordered-requiredKinds binding mismatches. |
| `risk_challenge_kind_mismatch` | 428 | The final member header kind or aggregate claim's ordered requiredKinds disagrees with the current decision. |
| `risk_control_blocked` | 429 | The current risk decision blocks anonymous subscription. |
| `risk_control_throttled` | 429 | The current risk decision requires throttling; the subscription does not enter the business channel. |
| `account_blocked` | 423 | A signed-in user is banned during the notification-stream handshake. |
| `ACCOUNT_BANNED_WRITE_LOCKED` | 423 | A restricted session attempts an ordinary business write; returned in Binary `ApiError.Details`. |
| `account_deleted` | 401 | Signed-in user is missing, deleted, or disabled. |
| `notification_handshake_failed` | 500 | Unclassified handshake failure. |

---

The public failure surface for RiskControl aggregate verification is bounded. Legacy verify wire without `envelopeId`, a non-UUIDv7 envelopeId, or malformed structure returns `security_challenge_verify_request_invalid` during decode/validation. For a valid envelope/member with mismatched envelopeId, ordinal, action, route, identity, policy, or member binding, the server may record `challenge_envelope_binding_mismatch` internally but returns HTTP 428 + `challenge_failed` to binary callers, avoiding a binding oracle. Member failure, expiry, revocation, replay, ordering errors, Redis CAS/TTL miss, incomplete aggregate proof, and requiredKinds mismatch also fail closed; no public JSON fallback is added. `capability_unavailable` / `executor_unavailable` and similar capability-catalog values remain controlled internal issue/readiness reasons; no new public client version error code is promised.

---

Ban errors do not depend on Redis. The server of record is `sys_user.Status/BanReason/ban_state_generation`; admission reads the bounded process-local subject-hash projection. A known Banned fact returns `AccountBanned`, `account_blocked`, or the write lock `ACCOUNT_BANNED_WRITE_LOCKED`; an unknown fact fails closed and is never interpreted as Normal. A banned account may retain a restricted session for logout, session revocation, account deletion, and other security cleanup; ordinary business writes always return `423 Locked` from the server and must not rely only on disabled frontend controls.

<a id="负响应"></a>

## Negative responses

Negative responses from the L0 artifact fast path write no AEDS frame body and always use `Cache-Control: no-store`, preventing caching of not-ready, method-mismatch, or content-negotiation failures. Semantics for `400` / `404` / `405` / `406` / `416` / `503` follow [design.md#l0-artifact-http-semantics](design.md#l0-artifact-http-semantics) and `PublicHotReadFastPath`. List/category/tag (and diagnostic HTML) Serving misses use `503` + `Retry-After: 1` for not-resident/rebuild-pending, `404` without `Retry-After` for authoritative not-found, and `200` when last-good or fresh L0 still has the artifact; see [PublicHotRead serving miss outcomes](../operations/public-hot-read-serving-outcomes.md). An active revocation tombstone uses `410 Gone`, `Cache-Control: no-store, no-cache, must-revalidate`, `X-Fsus-Generation: <decimal>`, and `X-Fsus-Revoked: g<generation>`, with no body, ETag, or Content-Encoding. `503` defaults to `Retry-After: 1`; a `Range` request returns `416` with `Accept-Ranges: none`. These negative responses carry the same static browser-security headers as public HTML artifacts, including `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, COEP, COOP, and CORP.

Business failures on ordinary AEDS binary endpoints use `AedsFrameType.ApiError = 251`; notification-stream preflight/WebSocket handshake failures also write `X-Fsus-Notification-Stream-Error-Code` and `X-Fsus-Notification-Stream-Status-Code`.

Login-state contamination on strong-anonymous ticket/submit endpoints uses AEDS `ApiError` with HTTP 403, `Code=Forbidden`, and `Details=anonymous_identity_contaminated`; the user-facing message is fixed as: “An anonymous submission request cannot carry login state; refresh and try again.”

<a id="aeds-v2-帧格式"></a>

## AEDS v2 frame format

Authoritative specification: `src/core/Algorithms/AEDS_V2_PROTOCOL.md` (the current runtime accepts v2 frames only).

### Frame header layout (16 bytes, little-endian)

```text
Offset  Size  Field          Type     Meaning
 0       4    Magic          uint32   Fixed value 0x53444541 ("AEDS" little-endian)
 4       1    Version        uint8    Protocol version, currently 2
 5       1    HeaderLength   uint8    Header length, fixed at 16
 6       2    Flags          uint16   Reserved flags, currently 0
 8       2    FrameType      uint16   Frame type (see the AedsFrameType enum)
10       4    PayloadLength  uint32   Payload bytes, excluding the header
14       2    PayloadCrc16   uint16   Payload CRC16
```

**Total frame size** = 16 (header) + PayloadLength (payload)

### CRC16 calculation

```text
PayloadCrc16 = CRC16(payload_bytes)
```

CRC16 uses the Modbus polynomial `0xA001` with initial value `0xffff`. v2 removes the header CRC; the header is validated only for field boundaries and version.

<a id="flags-登记"></a>

### Flags registry

The current production protocol enables neither `NoPayloadCrc` nor in-protocol `PayloadCompressed`. Request frames must write `Flags = 0`; the server request binder rejects non-zero flags with protocol validation failure, and response frames also default to `0`. If a response-only flag is introduced, update `aeds-protocol.json`, the negative contract matrix, TypeScript/Worker/Wasm decoders, and this document together.

HTTP `Content-Encoding: br|gzip` is artifact-level transport compression and does not consume AEDS flags; after browser fetch decompression, clients still calculate payload CRC16 over the original AEDS frame.

### Decoder validation flow

1. Read the 16-byte frame header.
2. Verify Magic == `0x53444541`.
3. Verify Version == 2 and HeaderLength == 16.
4. Verify PayloadLength does not exceed the safe limit (see the POD size catalog).
5. Read payload bytes according to PayloadLength.
6. Compute payload CRC16 and compare it with PayloadCrc16.
7. Parse the payload layout by FrameType.

AEDS v1 frames, unknown versions, and invalid header lengths are rejected directly; server and frontend do not provide an old-frame fallback.

Any validation failure → discard the frame. The binary call chain must not re-wrap errors as text responses; recoverable server errors use an `ApiError` frame.

### Payload structure

Frequent public and statistics frames use a compact layout composed of counts, fixed numeric records, a shared UTF-8 blob, and `Utf8SliceRef` values:

```text
[count/meta] [blobLength:int32 + blob] [fixed numeric records] [slice refs into blob]
```

- `ArticleList`: the writer first emits cursor envelope v2: `magic:int32=0x41535046`, `version:int32=2`, `hasMore:byte`, `total:int32`, and `nextCursor:bytes`; then `count:int32`, `tagRecordCount:int32`, the shared blob, one current 100B article record per article, and one 12B record per tag. The cursor is a canonical base64url opaque token of at most 64B and must be non-empty when `hasMore=true`; the decoder retains read compatibility with envelope v1 and 56B/76B article records. The 100B record appends `currentRevisionId:int64`, `revisionNo:int32`, `currentPublicationId:int64`, and `publicationNo:int32` after the old 76B lifecycle fields.
- `ArticleSearch`: current FAS4 payload writes magic/version before counts and the same 24B publication coordinates for every article; payloads without magic/version remain read-compatible only. Offline search shard/package/manifest and Wasm results use version 4, with 76B doc metadata/result items.
- `ArticleHot`: `count:int32`, shared blob, and one 16B record per article.
- `Category` / `Tag`: `count:int32`, shared blob, and one 16B record per item.
- `AdminStats`: 80B `SiteStatsPod`, shared blob, 16B popular records, 56B recent-comment author-snapshot records, and 12B region records. Reading-summary fields are `totalReads`, `humanVerifiedReads`, `uniqueViewerKeyEstimate`, `articleReads`, and `siteReads`; no account-identity breakdown is included.
- Write, authentication, upload, and a few complex-detail frames still use POD + blob wrapped in the v2 header; the wire format accepts v2 only.

The current compatible payload-dictionary boundary is a shared UTF-8 blob plus `Utf8SliceRef`: ArticleList/ArticleSearch/Conversation records do not duplicate embedded text; category/tag/title/ summary/body all reference the shared blob through slices. Any future ArticleList category/tag dictionary layout must be registered with a new payload version and golden fixture, never reused as an unmarked old record layout.

---

<a id="aedsframetype-枚举"></a>

## AedsFrameType enum

Generation input: `src/shared/Contracts/Validation/aeds-protocol.json`

Generated outputs: `src/core/Algorithms/AedsFrameType.cs`, `src/shared/AedsFrameHeader.cs`, and `src/frontend/wasm/web/protocol/frame.ts`.

Retired, non-reusable AEDS values are recorded in `retiredFrameValues`: `40` is the legacy admin password-reset slot and `43`/`44`/`45`/`46` are legacy username/password-auth slots. These values generate no frame name, POD, codec, or OpenAPI contract; a decoder rejects the corresponding raw frame type as retired.

| Value | Name | POD type | Binary endpoint / purpose |
| ---- | ------ | --------- | ---------------- |
| 0 | `Unknown` | — | — |
| 1 | `ArticleList` | `ArticleListPod` | `GET /api/binary/article/list/home/{page}/{size}.aeds`; see `quick-reference.md` for category/tag lists. |
| 2 | `ArticleDetail` | Current V5 detail/tag/rights records; read compatibility with V4/V3 | `GET /api/binary/article/{id}.aeds` |
| 3 | `ArticleHot` | `ArticleListPod` | `GET /api/binary/article/hot/{size}.aeds` |
| 4 | `ArticleSearch` | `ArticleListPod` | Search index/author-cache diagnostics; does not expose an old text business path. |
| 5 | `CommentArticleCursor` | `CommentThreadItemPod` + item blob | `GET /api/binary/comment/{articleId}`; each item blob appends the required `CommentAuthorView` payload and optional `replyToAuthor` payload after content. |
| 6 | `CommentUserCursor` | `CommentPod` | `GET /api/binary/comment/me` attributable records for the current user; optional `articleId` is only an authenticated private ownership overlay. |
| 7 | `AdminStats` | `AdminStatsPod` | — |
| 8 | `CommentThreadReplyCursor` | `CommentReplyItemPod` + item blob | `GET /api/binary/comment/{articleId}/thread/{rootId}`; each reply item blob appends the required `CommentAuthorView` payload and optional `replyToAuthor` payload after content. |
| 9 | `CategoryList` | compact taxonomy records | `GET /api/binary/category.aeds` |
| 10 | `TagList` | compact taxonomy records | `GET /api/binary/tag.aeds` |
| 11 | `RecentCommentStats` | compact stats records | `GET /api/binary/stats/recent-comments` |
| 12 | `RegionStats` | compact stats records | `GET /api/binary/stats/regions` |
| 13 | `SeoConfig` | `SeoConfigPod` | `GET /api/binary/system/seo` |
| 14 | `PageContent` | `PageContentPod` | `GET /api/binary/system/page/{slug}` |
| 15 | `ArticleFeatured` | compact article records | `GET /api/binary/article/featured/{size}.aeds` |
| 16 | `TrashClearResponse` | `TrashClearResponsePod` | `DELETE /api/binary/admin/article/trash` |
| 17 | `AdminUserList` | compact anonymous account records | `GET /api/binary/admin/users` |
| 18 | `AuthLoginFlow` | Auth flow; `AuthPhase=1 authenticated / 2 mfa_required / 3 enrollment_required` | Anonymous bootstrap, enrollment status/complete, and Passkey login complete. |
| 19 | `CurrentUserSnapshot` | admin-only account status snapshot without username/role | admin-only accountId query / refresh-token compatibility |
| 20 | `UploadInit` | `UploadInitPod` | `POST /api/binary/upload/init` |
| 21 | `UploadStatus` | `UploadStatusPod` | `GET /api/binary/upload/{id}` |
| 22 | `UploadPartAck` | `UploadPartAckPod` | `PUT /api/binary/upload/{id}/part/{n}` |
| 23 | `UploadComplete` | `UploadCompletePod` | `POST /api/binary/upload/{id}/complete` |
| 24 | `UploadPartMap` | `UploadPartMapPod` | `GET /api/binary/upload/{id}/parts` |
| 25 | `AuthSessionList` | privacy-safe `UserSessionSummaryPod[count]` without credential id, fingerprint, token, raw user agent/IP, or user id | `GET /api/binary/auth/sessions` |
| 26 | `SiteComplianceConfig` | `SiteComplianceConfigPod` | `GET /api/binary/system/compliance` |
| 170 | `AdminSessionList` | `AdminSessionSummaryPod[count]` | `GET /api/binary/auth/admin/sessions` |
| 171 | `SecurityChallengeAssignment` | `SecurityChallengeAssignmentPod` | One RiskControl member assignment in an ordered envelope. |
| 172 | `SecurityChallengeEnvelope` | `SecurityChallengeEnvelopePod` + `SecurityChallengeAssignmentPod[]` | UUIDv7 envelope with 1..8 ordered required members; also used for a single challenge. |
| 30 | `PowChallenge` | `PowChallengePod` | `GET /api/binary/auth/pow-challenge` |
| 31 | `UploadInitRequest` | `UploadInitRequestPod` | Request body for `POST /api/binary/upload/init`. |
| 32 | `UploadCompleteRequest` | `UploadCompleteRequestPod` | Request body for `POST /api/binary/upload/{id}/complete`. |
| 33 | `CategoryWriteRequest` | Current `TaxonomyMetadataMutationRequestPod` + description blob; legacy 128-byte `NameMutationRequestPod` accepted during migration | Request body for `POST /api/binary/category` and `PUT /api/binary/category/{id:int}`. |
| 34 | `TagWriteRequest` | Current `TaxonomyMetadataMutationRequestPod` + description blob; legacy 128-byte `NameMutationRequestPod` accepted during migration | Request body for `POST /api/binary/tag` and `PUT /api/binary/tag/{id:int}`. |
| 35 | `SeoConfigUpdateRequest` | `SeoConfigPod` | Request body for `PUT /api/binary/system/seo`. |
| 36 | `PageContentUpdateRequest` | `PageContentPod` | Request body for `PUT /api/binary/system/page`. |
| 63 | `PasskeyRegisterBegin` | `PasskeyRegisterBeginPod` | Reused by ordinary registration and first enrollment/admin-bootstrap begin; POD fields use `accountHandle`/`accountName`/`accountDisplayName`. |
| 64 | `PasskeyLoginBegin` | `PasskeyLoginBeginPod` | `POST /api/binary/auth/passkey/login/begin`; reused by admin login begin. |
| 65 | `PasskeyCredentialList` | `PasskeyCredentialSummaryPod[]` | `GET /api/binary/auth/passkey/credentials` |
| 66 | `PasskeyRegisterCompleteRequest` | `PasskeyRegisterCompleteRequestPod` | Request body for ordinary registration, first enrollment, and admin-bootstrap complete. |
| 67 | `PasskeyLoginCompleteRequest` | `PasskeyLoginCompleteRequestPod` | `POST /api/binary/auth/passkey/login/complete`; request body for admin login complete. |
| 68 | `PasskeyCredentialFriendlyNameUpdateRequest` | `PasskeyCredentialFriendlyNameUpdateRequestPod` | Request body for `PUT /api/binary/auth/passkey/credentials/{id}/name`. |
| 212 | `PasskeySignalState` | `PasskeySignalStatePod` + `PasskeySignalCredentialPod[]` | Passkey register/delete responses and `GET /api/binary/auth/passkey/signal-state`; includes monotonic revision and the server-authoritative complete credential set. |
| 214 | `AnonymousCommentCreateResult` | JSON-in-AEDS | Strong-anonymous create result; first success includes `managementSecret`, idempotent replay is empty, and the response is `no-store`. |
| 215 | `CommentManagementChallengeRequest` | JSON-in-AEDS | Challenge purpose and optional anonymous capability; sensitive values are allowed only in the request body. |
| 216 | `CommentManagementChallengeResponse` | JSON-in-AEDS | Five-minute one-time challenge, expiry, and current comment version. |
| 217 | `CommentAuthorEditRequest` | JSON-in-AEDS | `expectedVersion`, body, and challenge; anonymous requests also carry capability. |
| 218 | `CommentAuthorMutationResult` | JSON-in-AEDS | Stable edit/delete/appeal result code, current version, and re-moderation state. |
| 219 | `CommentAuthorStatusRequest` | JSON-in-AEDS | Delete/status challenge; anonymous requests also carry capability. |
| 220 | `CommentAuthorStatusResult` | JSON-in-AEDS | Capability-scoped current moderation/deletion/edit status; no historical body. |
| 221 | `CommentAuthorAppealRequest` | JSON-in-AEDS | Anonymous appeal reason, challenge, and capability. |
| 222 | `CommentRevisionList` | JSON-in-AEDS | Admin-only revision body, SHA-256, operation, time, and actor mode. |
| 223 | `CommentReportRequest` | JSON-in-AEDS | Fixed reason code and optional note; anonymous entry also carries a comment-scoped credential. |
| 224 | `CommentReportResult` | JSON-in-AEDS | Report ID and duplicate flag; does not indicate a visibility change. |
| 225 | `CommentModerationTimeline` | JSON-in-AEDS | Admin-only append-only events, rebuilt projection, and consistency marker. |
| 226 | `CommentAppealDecisionRequest` | JSON-in-AEDS | Granted/denied and review reason; admin step-up. |
| 227 | `CommentAppealDecisionResult` | JSON-in-AEDS | Appeal decision result and appeal ID. |
| 69 | `NotificationEvent` | Binary notification value | `/api/notifications/stream` WebSocket event; `CommentAdded` payload `comment` uses `author` / `replyToAuthor` snapshots and must not restore legacy identity fields. |
| 70 | `NotificationHeartbeat` | `int64 timestampUnixMs` | `/api/notifications/stream` WebSocket heartbeat. |
| 71 | `PublicAotBootstrap` | Binary tagged value | Public AOT HTML bootstrap/hydration (both must carry canonical `renderLocale` matching HTML/response); `GET /api/public/navigation-snapshot.aeds?path=...` public-navigation-snapshot envelope with schema/version/SHA-256 digest `PublicSeoHeadModel`. |
| 72 | `SiteComplianceConfigUpdateRequest` | `SiteComplianceConfigPod` | Request body for `PUT /api/binary/system/compliance`. |
| 159 | `RecoveryKeyCreateResponse` | `RecoveryKeyCreateResponsePod` | Responses for `POST /api/binary/auth/recovery-key/create` and `/rotate`. |
| 160 | `RecoveryKeyVerifyRequest` | `RecoveryKeyVerifyRequestPod` | Request body for `POST /api/binary/auth/recovery-key/verify`; carries no account ID, which the server locates from the Recovery Key lookup ID. |
| 161 | `RecoveryKeyVerifyResponse` | `RecoveryKeyVerifyResponsePod` | Successful Recovery Key verification; returns only the recovery-session token and expiry. |
| 162 | `RecoveryKeySessionRequest` | `StringMutationRequestPod` | Recovery-session token request body for Passkey recovery begin. |
| 163 | `IdentityAccountSnapshot` | `IdentityAccountSnapshotPod` | `GET /api/binary/auth/me`; anonymous account ID, identity kind, public handle, Passkey/Recovery/TOTP/anonymous-credential and status fields; does not expose internalUserId; access expiry is carried only in the `X-Fsus-Access-Expires-At-Utc` HTTP header and does not consume POD space. |
| 164 | `CommentPolicySnapshot` | `CommentPolicySnapshotPod` | Pre-render comment-composer policy: anonymous/public/ZK switches, complete raw ZK-Prod bit and controlled unavailable reason, default author mode, language list, and policy snapshot hash; frontend 41-byte layout maps to client contract v3, while old/corrupt layouts always return `contract_invalid`. |
| 165 | `CommentPolicyUpdateRequest` | `CommentPolicyUpdateRequestPod` | Admin anonymous-comment policy patch request body. |
| 166 | `CommentCreateV2Request` | `CommentCreateV2RequestPod` | Signed-in public comment; explicit opt-in required. Legacy `anonymous` returns `anonymous_author_mode_retired` with zero business writes; `zk_anonymous` returns `anonymous_ticket_required`; legacy scope/proof slots remain wire layout only. |
| 167 | `CommentAuthorView` | `CommentAuthorViewPod` | Comment-author display projection; comment cursors must carry it explicitly, and clients must not fabricate anonymous/public names from legacy identity strings. |
| 177 | reserved | none | Unassigned; no decoder or compatibility path. |
| 178 | reserved | none | Unassigned; no decoder or compatibility path. |
| 179 | `AnonymousCredentialRootSnapshot` | `AnonymousCredentialRootSnapshotPod` | Anonymous-credential root/verifying-key snapshot with issuer public-key hash and credential/revocation root; responses for `GET /api/binary/anonymous-credential/root` and `/circuit`. |
| 180 | retired | — | Legacy precise-attribute ticket request; fail closed as unknown/retired frame. |
| 181 | retired | — | Legacy precise-attribute ticket response; fail closed as unknown/retired frame. |
| 198 | `AnonymousCommentTicketRequest` | `AnonymousCommentTicketRequestPod` | v5/layout-6 minimum qualification predicate, root hashes, proof, and canonical public inputs; carries no precise attributes. |
| 199 | `AnonymousCommentTicketResponse` | `AnonymousCommentTicketResponsePod` | Expiry, `common` / `unknown` rate class, moderation predicate, opaque ticket, and moderation-subject hash. |
| 200 | `SecurityChallengeCancelRequest` | `SecurityChallengeCancelRequestPod` + shared blob | Revokes an aggregate challenge envelope bound to action/route/device/policy; response is `EmptySuccess`. |
| 205 | `CommentCreateResult` | `CommentCreateResultPod` | Complete 40-byte create result: comment/root/parent IDs, createdAt, moderation/visibility, public-visible, and idempotency-replay markers. |
| 201 | `ConversationReadRequest` | `ConversationReadRequestPod` | Account mark-read with explicit `readThroughMessageId`. |
| 202 | `AccountConversationReplyRequest` | `AccountConversationReplyRequestPod` + shared blob | Account reply body and explicit read position; admin replies continue to use frame 60. |
| 203 | `ConversationDetailV2` | `ConversationDetailV2Pod` + message records/blob | Conversation detail and visible `readSnapshotMessageId`. |
| 204 | `ConversationDetailV3` | `ConversationDetailV3Pod` + message records/blob | Fixed message page, `previousCursor`, `hasOlder`, and read snapshot. |
| 206 | `AdminConversationList` | `AdminConversationListItemPod` + shared blob | Admin-only list with the original list record plus minimal counterparty account ID/status. |
| 207 | `AdminConversationDetail` | `AdminConversationDetailPod` + message records/blob | Admin-only detail with V3 header plus minimal counterparty account ID/status. |
| 208 | `CommentTreeRootCursor` | cursor envelope + `CommentTreeNodePod` records | Root keyset page; each root inlines direct-child previews only. |
| 209 | `CommentChildCursor` | `CommentChildCursorPod` + `CommentTreeNodePod` records | Direct-child keyset page for a specified parent. |
| 210 | `CommentPermalinkContext` | `CommentPermalinkContextPod` + node records | Permalink ancestors, target, and sibling window; an invisible target is uniformly `unavailable`. |
| 211 | `ConversationStatusMutationResult` | `ConversationStatusMutationResultPod` | Status CAS result with previous/current status and `changed`/`no_change` outcome. |
| 213 | `ArticleRevisionRollbackRequest` | AEDS JSON `{baseRevisionId,targetStatus,reason}` | Admin revision rollback request; target is only Draft/Published/Archived, creates a new revision/release, and never reuses a historical row. |

The wire layouts of `ConversationList(56)` and `ConversationDetailV3(204)` gain no fields for admin queue state. The same `unreadCount` field uses a viewer-specific source of truth: account reads use participant state, while admin reads use `msg_admin_queue_state`; public/account frames expose neither admin queue version, admin session, nor management-principal identity. When the admin queue is dynamically disabled, use `ApiError(251)` details `message_admin_queue_projection_disabled`.

`AdminConversationList(206)` / `AdminConversationDetail(207)` may be sent only by admin routes. The added `counterpartyAccountId:int64` and `counterpartyAccountStatus:int32` must not enter account `ConversationList(56)` / `ConversationDetailV3(204)`. `status` accepts only `0..3`; when account ID is 0, status must be `3=missing`. When the admin account projection is dynamically disabled, return `ApiError(251)` details `message_admin_account_projection_disabled`; do not reuse an account frame as fallback.

Account and admin replies lock the conversation, validate status, insert the message, and update activity/unread within one transaction barrier, publishing a delivery event only after commit. Missing conversation returns `404`; closed or post-lock status conflict returns `409`; transaction infrastructure failure returns `503`. When `Messages:ReplyWritesEnabled` is dynamically disabled, both reply endpoints always return `503` + `message_reply_writes_disabled`; reads and explicit reopen remain available.

Status updates must carry a 1..256-character audit reason; missing or over-limit reasons return `400` + `conversation_status_reason_invalid`. A disallowed state-machine edge returns `409` + `conversation_status_transition_invalid`; discovering another target state after CAS returns `409`. The same target state returns frame 208's `no_change` and is not an error. When `Messages:StatusMutationsEnabled` is dynamically disabled, return `503` + `message_status_mutations_disabled`; do not degrade to an unaudited or direct live publish.

System-message target failures are distinct: missing target is `404 system_message_target_not_found`, deleted target is `404 system_message_target_deleted`, ordinary delivery to a restricted account is `403 system_message_target_restricted`, and unknown account state is `403 system_message_target_status_invalid`. When target locking/validation is hot-disabled, a new source event returns `503 system_message_target_validation_disabled`; a committed replay with the same digest is unaffected.

`msg_participant_state.unreadcount` and `msg_admin_queue_state.unreadcount` must be `>= 0`. When either table's non-null `lastreadmessageid` is set, it must reference a non-internal `msg_message` in the same conversation; ordinary transactions must not move it backward or clear it. A controlled unread-repair transaction may reset an invalid historical cursor to null and recompute; when the maintenance switch is off, no repair runs and these database constraints are not relaxed.
| 182 | `AnonymousCommentCreateRequest` | `AnonymousCommentCreateRequestPod` | Request body for `POST /api/binary/comment/anonymous`; contains no user ID, username, Authorization token, or public handle. |
| 183 | `AnonymousPrivacyStateSnapshot` | `AnonymousPrivacyStateSnapshotPod` | Frontend anonymous-privacy state snapshot. |
| 184 | `PerceptionSealedChallengeV2` | `PerceptionSealedChallengeV2Pod` | `fsu.challenge/perception-sealed@v2` issue payload; covers Localization and MicroInteraction only. |
| 185 | `PerceptionSealedResultV2` | `PerceptionSealedResultV2Pod` | `fsu.challenge/perception-sealed@v2` verify payload; supports coordinates and steps response payload only. |
| nested | `PerceptionCharacterV3Issue` | `PerceptionCharacterV3IssuePod` | Typed union in frame 175 selected by assignment `kind=14`; final 4-bit PNG/Ogg Opus bytes plus opaque state. |
| nested | `PerceptionCharacterV3Verify` | `PerceptionCharacterV3VerifyPod` | Typed union in frame 174 selected by `kind=14`; contains answer plus opaque state only. |
| 186 | `RetiredCredentialSpecificRevocationRequest` | none | Permanently retired; never reuse or parse the body. |
| 187 | `RetiredCredentialSpecificRevocationResponse` | none | Permanently retired; server never sends it. |
| 196 | `AnonymousCredentialRevocationSnapshot` | `AnonymousCredentialRevocationArtifactPod` | Public full revoked-set snapshot. |
| 197 | `AnonymousCredentialRevocationDelta` | `AnonymousCredentialRevocationArtifactPod` | Public append-only delta. |
| 193 | `BlindCredentialIssuerMetadata` | `BlindCredentialIssuerMetadataPod` | `GET /api/binary/anonymous-credential/blind-issuer`; RFC 9474 profile and 3072-bit RSA DER SPKI. |
| 194 | `BlindCredentialIssueRequest` | `BlindCredentialIssueRequestPod` | `POST /api/binary/anonymous-credential/blind-issue`; 384B blinded representative. |
| 195 | `BlindCredentialIssueResponse` | `BlindCredentialIssueResponsePod` | 384B blind signature; browser performs local unblind/verify. |
| 189 | `AuthAnonymousBootstrapRequest` | `AuthAnonymousBootstrapRequestPod` | Request body for `POST /api/binary/auth/anonymous/bootstrap`; only normative confirmation and optional public handle, no legacy registration-password fields. |
| 190 | `AuthUpdatePublicHandleRequest` | `StringMutationRequestPod` | Request body for `PUT /api/binary/auth/public-handle`; saves or clears the current account's public handle. |
| 240 | `EmptySuccess` | `EmptySuccessPod` | Generic empty-success response. |
| 241 | `MutationId` | `MutationIdPod` / `ArticleMutationResultPod` | Generic mutation-ID response; article create/update/rollback use the 48B typed result. |
| 243 | `TaxonomyExactMetadata` | compact id/name/nullable description | `GET /api/binary/category/{id}.aeds`, `GET /api/binary/tag/{id}.aeds`, `GET /api/binary/tag/by-name.aeds`. |
| 251 | `ApiError` | `ApiErrorPod` | Binary error response. |

---

<a id="pod-大小目录"></a>

## POD size catalog

Source: `src/shared/Contracts/Validation/PodSizeCatalog.cs`

The following sizes are **compile-time constants** and must stay identical in C# and C++. Any change must update all of the following together:

1. The corresponding field in `PodSizeCatalog.cs`.
2. The C++ header's `static_assert`.
3. This table.

### Primitive types

| Type | Bytes |
| ------ | -------- |
| `Utf8Fixed32` | 32 |
| `Utf8Fixed64` | 64 |
| `Utf8Fixed128` | 128 |
| `Utf8Fixed256` | 256 |
| `Utf8Fixed512` | 512 |
| `Utf8SliceRef` | 8 (`int32 Offset` + `int32 Length`) |

### Envelopes

| Type | Bytes |
| ------ | -------- |
| `PodEnvelopeHeader` | 16 |
| `PageEnvelope` | 8 |
| `CursorEnvelope` | 16 |
| `PagedPodEnvelope` | 24 |
| `CursorPodEnvelope` | 32 |

### Common response PODs

| Type | Bytes |
| ------ | -------- |
| `EmptySuccessPod` | 4 |
| `CommentCreateResultPod` | 40 |
| `MutationIdPod` | 8 |
| `ApiErrorPod` | 584 |

### Article PODs

| Type | Bytes |
| ------ | -------- |
| `ArticleListPod` | ~512 (including Title/Summary fields) |
| `ArticleDetailPod` | Legacy; no longer accepted by the public runtime. |
| `ArticleDetailV3HeaderPod` | 44 |
| `ArticleDetailV3RecordPod` | 84 |
| `ArticleDetailV4HeaderPod` | 44 |
| `ArticleDetailV4RecordPod` | 92 |
| `ArticleDetailV5RecordPod` | 116 |
| `ArticleDetailTagV3RecordPod` | 12 |
| `ArticleRightsV3RecordPod` | 112 |
| `ArticleMutationResultPod` | 48 |
| `ArticleWriteRequestPod` | 40 (fixed prefix, followed by tags/blob/lifecycle/rights segments) |
| `ArticleRightsWriteRequestPod` | 40 |

`ArticleWriteRequest` currently writes version V5. After the V4 rights segment and rights blob it appends `baseRevisionId:int64`; create writes `0`, while update must write a positive value. After the existing `status:int32` and `scheduledPublishAtUnixMs:int64`, it writes `version=5` and `rightsMutation:int32`: `0=preserve`, `1=replace`, `2=reset`. `replace` must carry a complete rights payload; `reset` must not carry a replacement payload. V3 rights payloads are read-compatible as `replace`; pre-rights payloads containing only the article body and lifecycle tail are read-compatible as `preserve`. Article create/update still use frame type `MutationId(241)`, but the article payload uses the 48B `ArticleMutationResultPod`: `articleId:int32`, `revisionId:int64`, `revisionNo:int32`, `releaseId:int64`, `releaseNo:int32`, `status:int32`, `rightsSnapshotId:int64`, `rightsRevisionNo:int32`, `idempotencyReplay:uint8`, `errorCode:uint8`, `outcome:uint8`, and `reserved:uint8`; `outcome=0` is `applied` and `outcome=1` is `no_change`. Other generic mutations continue using the 8B `MutationIdPod`. An identical update returns current revision/release/rights coordinates and `no_change`, without creating a revision, publication, outbox, notification, or cache invalidation. Missing/invalid create mutation IDs, same-key different content, and runtime disablement use `article_client_mutation_id_required`, `article_client_mutation_id_invalid`, `article_mutation_content_conflict`, and `article_mutation_idempotency_disabled`, respectively. `article_revision_conflict` uses HTTP 409 `ApiError` with current revision coordinates, status, and updatedAt in details; `xmin` is not exposed. Draft save/discard `draft_conflict` likewise uses HTTP 409 `ApiError` with fixed details `{currentServerRevision:int64|null,currentUpdatedAt:datetime|null, titleSummary:string|null}`; content, summary, rights, tagIds, and other unpublished content are forbidden.

The notification-stream `ArticleChangedPayload` schema is `{articleId:int32,action:string,eventTime:datetime,preview?:ArticleListItemResponse|null,revisionId?:decimal-string|null,releaseId?:decimal-string|null}`. v2 mutations must fill both coordinates; legacy v1 may leave them null. Decimal strings prevent AEDS notification values from exceeding JavaScript's safe-integer boundary after decoding. This does not change the AEDS frame type.

### Comment PODs

| Type | Bytes |
| ------ | -------- |
| `CommentPod` | ~256 |
| `CommentPolicySnapshotPod` | 41 |
| `CommentPolicyUpdateRequestPod` | 26 |
| `CommentCreateV2RequestPod` | 80 |
| `CommentAuthorViewPod` | 36 |
| `CommentTreeNodePod` | 60 |
| `CommentChildCursorPod` | 32 |
| `CommentPermalinkContextPod` | 32 |
| `BlindCredentialIssuerMetadataPod` | 72 |
| `BlindCredentialIssueRequestPod` | 56 |
| `BlindCredentialIssueResponsePod` | 64 |
| `AnonymousCredentialRootSnapshotPod` | 80 |
| `AnonymousCredentialRevocationArtifactPod` | 88 |
| `AnonymousCommentTicketRequestPod` | 120 |
| `AnonymousCommentTicketResponsePod` | 36 |
| `AnonymousCommentCreateRequestPod` | 72 |
| `AnonymousPrivacyStateSnapshotPod` | 66 |

### Comment cursor item blob

The recursive tree's `CommentTreeNodePod` always stores `id/parentId/rootId/replyToCommentId/depth/childCount/isDeleted/hasMoreChildren/createTime/content`; each node is followed by content and a `CommentAuthorView` blob. A root frame writes `uint8 previewCount + 3 reserved zero bytes` after each root, then that many direct children; a child frame writes direct siblings only; a permalink frame writes ancestors, optional target, and siblings in sequence. Every reserved field must be zero, and every ID must remain a complete 64-bit decimal value.

The fixed PODs for `CommentThreadItemPod`, `CommentReplyPreviewItemPod`, and `CommentReplyItemPod` still store only a content slice ref; the corresponding blob layout is:

```text
content bytes
authorLength:int32
authorPayload:CommentAuthorViewPod + blobLength:int32 + blob
replyToAuthorLength:int32
replyToAuthorPayload?:CommentAuthorViewPod + blobLength:int32 + blob
```

`authorLength` must be greater than 0. `replyToAuthorLength=0` means no reply-target author; a non-zero value must be a complete `CommentAuthorView` payload. The frontend adapter returns a protocol error for a missing author, out-of-range length, or trailing bytes; it must not fall back to the old identity display.

### Comment-author storage projection

`comment.user_id` may be `NULL`; anonymous default comments no longer display authors through a real user foreign key. Strong-anonymous replies likewise write `reply_to_user_id = NULL` and resolve the replied author's snapshot only through `reply_to_comment_id`. `comment.user_id` and `comment.reply_to_user_id` remain only as compatibility fields for explicit public/attributable comments and legacy replies; they must not drive default anonymous-comment queries. Admin moderation attribution uses `moderated_by_admin_principal_id`, never `moderated_by_user_id`. Account-side `CommentUserCursor` returns explicit public/attributable comments only and is not a recovery path for strong-anonymous comments. New author-projection columns include `author_mode`, `public_handle`, `anonymous_handle`, `anonymous_display_name`, `anonymous_display_language`, `anonymous_nullifier_hash`, `anonymous_scope`, `moderation_subject_hash`, `credential_level`, `reputation_bucket`, and `account_age_bucket`. Public reads prefer `anonymous_display_name` / `public_handle`, then support legacy `sys_user.username`. The old `idx_comment_user_id_desc` is not the final-state index; attributable account reads use only partial index `idx_comment_attributable_public_user_id_desc`, whose predicate is fixed at `author_mode = 'public' AND user_id IS NOT NULL`.

### Messaging PODs

| Type | Bytes |
| ------ | -------- |
| `MessagePod` | ~512 |
| `ConversationListItemPod` | 76 |
| `ConversationDetailV2Pod` | 44 |
| `ConversationDetailV3Pod` | 52 |
| `AdminConversationListItemPod` | 92 |
| `AdminConversationDetailPod` | 68 |
| `ConversationReadRequestPod` | 8 |
| `AccountConversationReplyRequestPod` | 16 |

When `ConversationList(56)` has another page, a 17B cursor envelope precedes legacy `total + count`: `magic:int32=0x4D534743`, `version:int32=1`, `hasMore:byte`, and `nextCursor:Utf8SliceRef`. A no-next-page response may still use the legacy layout; the decoder must normalize it to `nextCursor=null / hasMore=false` and reject paged frames with unknown versions or a missing cursor.

### User / authentication PODs

| Type | Bytes |
| ------ | -------- |
| `UserPod` | ~256 |
| `AuthLoginFlowPod` | 168 |
| `CurrentUserSnapshotPod` | 372 |
| `IdentityAccountSnapshotPod` | 72 |
| `UserSessionSummaryPod` | 500 |
| `AdminSessionSummaryPod` | 356 |
| `MfaChallengeResultPod` | 296 |

### System PODs

| Type | Bytes |
| ------ | -------- |
| `SystemPod` | ~128 |
| `SeoConfigPod` | 5000 |
| `SiteComplianceConfigPod` | 1709 |

### Statistics PODs

| Type | Bytes |
| ------ | -------- |
| `AdminStatsPod` | ~64 |

### File / PoW PODs

| Type | Bytes |
| ------ | -------- |
| `FileUploadOutputPod` | 640 |
| `UploadInitPod` | 568 |
| `UploadStatusPod` | 136 |
| `UploadPartMapPod` | 72 |
| `UploadPartRangePod` | 8 |
| `UploadPartAckPod` | 92 |
| `UploadCompletePod` | 648 |
| `UploadInitRequestPod` | 428 |
| `UploadCompleteRequestPod` | 64 |
| `PowChallengePod` | 204 |

### Security-challenge PODs

| Type | Bytes |
| ------ | -------- |
| `SecurityChallengeAssignmentPod` | 664 |
| `SecurityChallengeEnvelopePod` | 132 |
| `SecurityChallengeVerifyRequestPod` | 44 |
| `SecurityChallengeVerifyResponsePod` | 968 |
| `SecurityChallengeCancelRequestPod` | 40 |
| `PerceptionSealedChallengeV2Pod` | 916 |
| `PerceptionSealedResultV2Pod` | 892 |
| `PerceptionCharacterV3IssuePod` | 256 |
| `PerceptionCharacterV3VerifyPod` | 156 |

> Exact values come from `PodSizeCatalog.cs`; `PodContractValidation.AreAllPodModelsReferenceFree()`
> validates them in tests and at startup.

---

<a id="c-pod-对齐规则"></a>

## C++ POD alignment rules

Source: `src/shared/Contracts/CPP_ALIGNMENT_CHECKLIST.md`

### Type mapping

| C# type | C++ type | Bytes |
| --------- | --------- | ------ |
| `int` / `int32_t` value type | `std::int32_t` | 4 |
| `long` / `int64_t` value type | `std::int64_t` | 8 |
| `byte` / `uint8_t` | `std::uint8_t` | 1 |
| `bool` value semantics | `std::uint8_t` (0/1) | 1 |
| `Utf8Fixed32` | `uint8_t[32]` | 32 |
| `Utf8Fixed64` | `uint8_t[64]` | 64 |
| `Utf8Fixed128` | `uint8_t[128]` | 128 |
| `Utf8Fixed256` | `uint8_t[256]` | 256 |
| `Utf8Fixed512` | `uint8_t[512]` | 512 |
| `Utf8SliceRef` | `struct { int32_t Offset; int32_t Length; }` | 8 |
| `DateTime` / `DateTimeOffset` | `std::int64_t` (Unix milliseconds) | 8 |
| Nullable `T?` | `T Value; uint8_t HasValue;` (+alignment padding) | Depends on T |

### String-length budgets

| Use | Fixed-width type |
| ------ | ------------ |
| Anonymous-account public handle | `Utf8Fixed64` |
| identity kind / anonymous credential status / level | `Utf8Fixed32` |
| Category name / tag name / region | `Utf8Fixed128` |
| Article title / short ID | `Utf8Fixed256` |
| URL / Base URL | `Utf8Fixed256` |
| Token / long string | `Utf8Fixed512` |
| Long text (body / summary) | `Utf8SliceRef` (points into blob area) |

### Key constraints

1. All POD types **must not contain reference types** (string, class, or array references).
2. Assert `PodContractValidation.AreAllPodModelsReferenceFree()` in unit tests and at startup.
3. Declare struct fields in **largest-to-smallest** order to avoid implicit padding.
4. The C++ side must verify each POD size with `static_assert(sizeof(T) == expected)`.
5. Values in `PodSizeCatalog` are the **authoritative source** for cross-language alignment.

---

## See also

- [design.md](design.md) — API design principles
- [contracts.md](contracts.md) — Complete response DTO definitions
- [quick-reference.md](quick-reference.md) — Route quick reference
- `src/core/Algorithms/AEDS_V2_PROTOCOL.md` — Complete protocol specification
- `src/shared/Contracts/Validation/aeds-protocol.json` — Generation input for frame types and AEDS headers
- `tools/frontend/generate-aeds-protocol.mjs` — Generate and validate protocol constants in all three stacks
- `src/shared/Contracts/Validation/PodSizeCatalog.cs` — Authoritative POD-size source

## Current generated domain errors and transport mappings

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.domain-errors-active
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.domain-errors-active
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.domain-errors-active -->
| Key | Value |
| --- | --- |
| auth.login.authentication-failed | {"condition":"credential verification fails","domain":"auth","failMode":"fail-closed","operation":"login","proofTests":["UserBootstrapLoginMfaBoundaryTests.Login_InvalidCredential_FailsClosed"],"retryability":"retry-after-new-credential","sourceOwner":"UserLoginWorkflowService","sourceRange":"UserLoginWorkflowService.LoginAsync","stableCode":"auth.login.authentication-failed","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.login.request-invalid | {"condition":"request contract is invalid","domain":"auth","failMode":"fail-closed","operation":"login","proofTests":["BinaryAuthEndpointTests.Login_InvalidRequest_ReturnsValidation"],"retryability":"not-retryable","sourceOwner":"BinaryEndpoints.Auth","sourceRange":"BinaryEndpoints.HandleLoginAsync","stableCode":"auth.login.request-invalid","status":"active","transport":{"aedsErrorCode":"Validation","aedsFrame":"Error","httpStatus":400}} |
| auth.mfa.code-invalid | {"condition":"TOTP or recovery code verification fails","domain":"mfa","failMode":"fail-closed","operation":"totp-verify","proofTests":["MfaChallengeServiceTests.InvalidCode_IsRejected"],"retryability":"retry-within-attempt-policy","sourceOwner":"UserService","sourceRange":"UserService.VerifyMfaOrRecoveryCodeAsync","stableCode":"auth.mfa.code-invalid","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.passkey.assertion-invalid | {"condition":"WebAuthn assertion validation fails","domain":"passkey","failMode":"fail-closed","operation":"authenticate","proofTests":["PasskeyServiceTests.InvalidAssertion_IsRejected"],"retryability":"retry-after-new-challenge","sourceOwner":"PasskeyService","sourceRange":"PasskeyService.CompleteAuthenticationAsync","stableCode":"auth.passkey.assertion-invalid","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.passkey.challenge-expired | {"condition":"Passkey challenge is absent, consumed, or expired","domain":"passkey","failMode":"fail-closed","operation":"authenticate","proofTests":["PasskeyServiceTests.ExpiredChallenge_IsRejected"],"retryability":"retry-after-new-challenge","sourceOwner":"PasskeyService","sourceRange":"PasskeyService.CompleteAuthenticationAsync","stableCode":"auth.passkey.challenge-expired","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.recovery.proof-invalid | {"condition":"Recovery Key proof verification fails","domain":"recovery","failMode":"fail-closed","operation":"verify","proofTests":["RecoveryKeyServiceTests.InvalidProof_IsRejected"],"retryability":"retry-after-new-session","sourceOwner":"RecoveryKeyService","sourceRange":"RecoveryKeyService.VerifyAsync","stableCode":"auth.recovery.proof-invalid","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.refresh.context-invalid | {"condition":"persisted authentication context is missing or inconsistent","domain":"session","failMode":"fail-closed","operation":"refresh","proofTests":["UserSessionAuthenticationContextTests.Refresh_InvalidContext_FailsClosed"],"retryability":"reauthenticate","sourceOwner":"UserSessionCommandService","sourceRange":"UserSessionCommandService.RefreshSessionAsync","stableCode":"auth.refresh.context-invalid","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.refresh.token-replay | {"condition":"refresh token generation has already been consumed","domain":"session","failMode":"fail-closed","operation":"refresh","proofTests":["RefreshTokenLineageTests.Replay_RevokesFamily"],"retryability":"reauthenticate","sourceOwner":"UserSessionCommandService","sourceRange":"UserSessionCommandService.RefreshSessionAsync","stableCode":"auth.refresh.token-replay","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.session.not-found | {"condition":"bound session does not exist","domain":"session","failMode":"fail-closed","operation":"lookup","proofTests":["UserSessionAuthenticationContextTests.MissingSession_IsRejected"],"retryability":"not-retryable","sourceOwner":"UserSessionValidationService","sourceRange":"UserSessionValidationService.ValidateAsync","stableCode":"auth.session.not-found","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.session.revoked | {"condition":"bound session is revoked","domain":"session","failMode":"fail-closed","operation":"validation","proofTests":["UserSessionAuthenticationContextTests.RevokedSession_IsRejected"],"retryability":"not-retryable","sourceOwner":"UserSessionValidationService","sourceRange":"UserSessionValidationService.ValidateAsync","stableCode":"auth.session.revoked","status":"active","transport":{"aedsErrorCode":"Unauthorized","aedsFrame":"Error","httpStatus":401}} |
| auth.step-up.proof-invalid-or-consumed | {"condition":"proof binding mismatches or proof was consumed or expired","domain":"step-up","failMode":"fail-closed","operation":"authorize","proofTests":["UserSecurityStepUpServiceTests.MfaProof_IsBoundToSessionActionAndConsumedOnce"],"retryability":"retry-after-step-up","sourceOwner":"MfaChallengeService","sourceRange":"MfaChallengeService.ValidateAndConsumeProofTokenAsync","stableCode":"auth.step-up.proof-invalid-or-consumed","status":"active","transport":{"aedsErrorCode":"Forbidden","aedsFrame":"Error","httpStatus":403}} |
| auth.step-up.proof-required | {"condition":"sensitive action has no matching proof","domain":"step-up","failMode":"fail-closed","operation":"authorize","proofTests":["UserSecurityStepUpServiceTests.MissingProof_IsRejected"],"retryability":"retry-after-step-up","sourceOwner":"UserSecurityStepUpService","sourceRange":"UserSecurityStepUpService.VerifyAsync","stableCode":"auth.step-up.proof-required","status":"active","transport":{"aedsErrorCode":"Forbidden","aedsFrame":"Error","httpStatus":403}} |
| security.challenge.capability-conflict | {"condition":"client capability manifest cannot satisfy the selected challenge","domain":"security-challenge","failMode":"fail-closed","operation":"issue","proofTests":["SecurityChallengeBinaryEndpointTests.CapabilityMismatch_ReturnsConflict"],"retryability":"retry-after-capability-refresh","sourceOwner":"BinaryEndpoints.SecurityChallenge","sourceRange":"BinaryEndpoints.HandleSecurityChallengeIssueAsync","stableCode":"security.challenge.capability-conflict","status":"active","transport":{"aedsErrorCode":"Conflict","aedsFrame":"Error","httpStatus":409}} |
| security.challenge.kind-unsupported | {"condition":"challenge kind or capability version is unsupported","domain":"security-challenge","failMode":"fail-closed","operation":"verify","proofTests":["SecurityChallengeContractTests.UnsupportedKind_IsRejected"],"retryability":"retry-after-capability-refresh","sourceOwner":"SecurityChallengeContracts","sourceRange":"SecurityChallengeContracts.SupportedKinds","stableCode":"security.challenge.kind-unsupported","status":"active","transport":{"aedsErrorCode":"Validation","aedsFrame":"Error","httpStatus":400}} |
| security.challenge.request-invalid | {"condition":"AEDS request contract or required binding is invalid","domain":"security-challenge","failMode":"fail-closed","operation":"issue-or-verify","proofTests":["SecurityChallengeBinaryEndpointTests.Verify_InvalidRequest_ReturnsValidation"],"retryability":"retry-after-correction","sourceOwner":"BinaryEndpoints.SecurityChallenge","sourceRange":"BinaryEndpoints.HandleSecurityChallengeVerifyAsync","stableCode":"security.challenge.request-invalid","status":"active","transport":{"aedsErrorCode":"Validation","aedsFrame":"Error","httpStatus":400}} |
| security.challenge.state-unavailable | {"condition":"required challenge state is unavailable","domain":"security-challenge","failMode":"fail-closed","operation":"verify","proofTests":["SecurityChallengeBinaryEndpointTests.StateUnavailable_FailsClosed"],"retryability":"retry-after-new-challenge","sourceOwner":"SecurityChallengeOrchestrator","sourceRange":"SecurityChallengeOrchestrator.VerifyAsync","stableCode":"security.challenge.state-unavailable","status":"active","transport":{"aedsErrorCode":"InfraFailure","aedsFrame":"Error","httpStatus":500}} |
| security.challenge.verification-failed | {"condition":"provider verification or attempt admission fails","domain":"security-challenge","failMode":"fail-closed","operation":"verify","proofTests":["SecurityChallengeBinaryEndpointTests.VerifyFailure_IsGeneric"],"retryability":"retry-after-new-challenge","sourceOwner":"BinaryEndpoints.SecurityChallenge","sourceRange":"BinaryEndpoints.HandleSecurityChallengeVerifyAsync","stableCode":"security.challenge.verification-failed","status":"active","transport":{"aedsErrorCode":"Forbidden","aedsFrame":"Error","httpStatus":403}} |
| security.pow.challenge-expired | {"condition":"PoW challenge lifetime has elapsed","domain":"pow","failMode":"fail-closed","operation":"verify","proofTests":["PowSecurityTests.ExpiredChallenge_IsRejected"],"retryability":"retry-after-new-challenge","sourceOwner":"RedisPowService","sourceRange":"RedisPowService.ValidateAsync","stableCode":"security.pow.challenge-expired","status":"active","transport":{"aedsErrorCode":"Forbidden","aedsFrame":"Error","httpStatus":403}} |
| security.pow.challenge-invalid | {"condition":"PoW challenge, signature, binding, or nonce is invalid","domain":"pow","failMode":"fail-closed","operation":"verify","proofTests":["PowSecurityTests.InvalidChallenge_IsRejected"],"retryability":"retry-after-new-challenge","sourceOwner":"RedisPowService","sourceRange":"RedisPowService.ValidateAsync","stableCode":"security.pow.challenge-invalid","status":"active","transport":{"aedsErrorCode":"Forbidden","aedsFrame":"Error","httpStatus":403}} |
<!-- FSUSBLOG-GENERATED:END api.domain-errors-active -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.domain-errors-retired
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.domain-errors-retired
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.domain-errors-retired -->
| Key | Value |
| --- | --- |
| state | empty-map |
<!-- FSUSBLOG-GENERATED:END api.domain-errors-retired -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.domain-errors-migration-only
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.domain-errors-migration-only
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.domain-errors-migration-only -->
| Key | Value |
| --- | --- |
| state | empty-map |
<!-- FSUSBLOG-GENERATED:END api.domain-errors-migration-only -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.error-transport-mappings
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.error-transport-mappings
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.error-transport-mappings -->
| Key | Value |
| --- | --- |
| Default400Validation | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"Validation","httpStatus":400,"mappingId":"Default400Validation","mappingKind":"error-code-default-status"} |
| Default401Unauthorized | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"Unauthorized","httpStatus":401,"mappingId":"Default401Unauthorized","mappingKind":"error-code-default-status"} |
| Default403Forbidden | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"Forbidden","httpStatus":403,"mappingId":"Default403Forbidden","mappingKind":"error-code-default-status"} |
| Default404NotFound | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"NotFound","httpStatus":404,"mappingId":"Default404NotFound","mappingKind":"error-code-default-status"} |
| Default409Conflict | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"Conflict","httpStatus":409,"mappingId":"Default409Conflict","mappingKind":"error-code-default-status"} |
| Default500InfraFailure | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"InfraFailure","httpStatus":500,"mappingId":"Default500InfraFailure","mappingKind":"error-code-default-status"} |
| Default500Unknown | {"defaultMessage":"Request failed","direction":"error-code-to-status","errorCode":"Unknown","httpStatus":500,"mappingId":"Default500Unknown","mappingKind":"error-code-default-status"} |
| Generic400Validation | {"defaultMessage":"Bad Request","direction":"status-to-error-code","errorCode":"Validation","httpStatus":400,"mappingId":"Generic400Validation","mappingKind":"generic-status-default"} |
| Generic401Unauthorized | {"defaultMessage":"Unauthorized","direction":"status-to-error-code","errorCode":"Unauthorized","httpStatus":401,"mappingId":"Generic401Unauthorized","mappingKind":"generic-status-default"} |
| Generic403Forbidden | {"defaultMessage":"Forbidden","direction":"status-to-error-code","errorCode":"Forbidden","httpStatus":403,"mappingId":"Generic403Forbidden","mappingKind":"generic-status-default"} |
| Generic404NotFound | {"defaultMessage":"Not Found","direction":"status-to-error-code","errorCode":"NotFound","httpStatus":404,"mappingId":"Generic404NotFound","mappingKind":"generic-status-default"} |
| Generic405InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":405,"mappingId":"Generic405InfraFailure","mappingKind":"generic-status-default"} |
| Generic406InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":406,"mappingId":"Generic406InfraFailure","mappingKind":"generic-status-default"} |
| Generic409Conflict | {"defaultMessage":"Conflict","direction":"status-to-error-code","errorCode":"Conflict","httpStatus":409,"mappingId":"Generic409Conflict","mappingKind":"generic-status-default"} |
| Generic410InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":410,"mappingId":"Generic410InfraFailure","mappingKind":"generic-status-default"} |
| Generic411InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":411,"mappingId":"Generic411InfraFailure","mappingKind":"generic-status-default"} |
| Generic413InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":413,"mappingId":"Generic413InfraFailure","mappingKind":"generic-status-default"} |
| Generic415InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":415,"mappingId":"Generic415InfraFailure","mappingKind":"generic-status-default"} |
| Generic422InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":422,"mappingId":"Generic422InfraFailure","mappingKind":"generic-status-default"} |
| Generic423Forbidden | {"defaultMessage":"Locked","direction":"status-to-error-code","errorCode":"Forbidden","httpStatus":423,"mappingId":"Generic423Forbidden","mappingKind":"generic-status-default"} |
| Generic426InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":426,"mappingId":"Generic426InfraFailure","mappingKind":"generic-status-default"} |
| Generic428InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":428,"mappingId":"Generic428InfraFailure","mappingKind":"generic-status-default"} |
| Generic429InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":429,"mappingId":"Generic429InfraFailure","mappingKind":"generic-status-default"} |
| Generic500InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":500,"mappingId":"Generic500InfraFailure","mappingKind":"generic-status-default"} |
| Generic501InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":501,"mappingId":"Generic501InfraFailure","mappingKind":"generic-status-default"} |
| Generic503InfraFailure | {"defaultMessage":"Request failed","direction":"status-to-error-code","errorCode":"InfraFailure","httpStatus":503,"mappingId":"Generic503InfraFailure","mappingKind":"generic-status-default"} |
| Operation401Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":401,"mappingId":"Operation401Validation","mappingKind":"operation-status-pair"} |
| Operation403Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":403,"mappingId":"Operation403Validation","mappingKind":"operation-status-pair"} |
| Operation406Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":406,"mappingId":"Operation406Validation","mappingKind":"operation-status-pair"} |
| Operation409Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":409,"mappingId":"Operation409Validation","mappingKind":"operation-status-pair"} |
| Operation410Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":410,"mappingId":"Operation410Validation","mappingKind":"operation-status-pair"} |
| Operation411Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":411,"mappingId":"Operation411Validation","mappingKind":"operation-status-pair"} |
| Operation413Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":413,"mappingId":"Operation413Validation","mappingKind":"operation-status-pair"} |
| Operation422Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":422,"mappingId":"Operation422Validation","mappingKind":"operation-status-pair"} |
| Operation423Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":423,"mappingId":"Operation423Validation","mappingKind":"operation-status-pair"} |
| Operation426Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":426,"mappingId":"Operation426Validation","mappingKind":"operation-status-pair"} |
| Operation428Forbidden | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Forbidden","httpStatus":428,"mappingId":"Operation428Forbidden","mappingKind":"operation-status-pair"} |
| Operation428Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":428,"mappingId":"Operation428Validation","mappingKind":"operation-status-pair"} |
| Operation429Forbidden | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Forbidden","httpStatus":429,"mappingId":"Operation429Forbidden","mappingKind":"operation-status-pair"} |
| Operation429Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":429,"mappingId":"Operation429Validation","mappingKind":"operation-status-pair"} |
| Operation503Forbidden | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Forbidden","httpStatus":503,"mappingId":"Operation503Forbidden","mappingKind":"operation-status-pair"} |
| Operation503Validation | {"defaultMessage":"Request failed","direction":"operation-status-pair","errorCode":"Validation","httpStatus":503,"mappingId":"Operation503Validation","mappingKind":"operation-status-pair"} |
<!-- FSUSBLOG-GENERATED:END api.error-transport-mappings -->

## Article/thread comment-policy errors

Admin authoring JSON uses the existing AEDS frame envelope; no public text fallback is added. Concurrent updates require `expectedPolicyVersion`; a mismatch returns `409 comment_policy_version_conflict`. Comment writes may return `comment_policy_closed`, `comment_thread_locked`, or `comment_slow_mode_active`; these states do not change public reads.

## Comment-moderation queue errors

- `400 comment_moderation_cursor_invalid`: cursor is not a valid opaque keyset for the current version.
- `400 comment_moderation_precondition_required`: single or bulk moderation lacks comment/claim concurrency preconditions.
- `400 comment_moderation_claim_invalid`: lease/SLA/note/escalation or token shape is invalid.
- `409 comment_moderation_claim_conflict`: the claim is occupied or expired, or owner/token/generation/row version supplied for renewal/release is stale.
- `409 comment_moderation_conflict`: comment status, comment row version, or claim condition changed before the decision; the transaction writes no comment, outbox, audit, or completed-claim state.

## Plugin Admin frames and stable errors

`PluginAdminSnapshot` (233) uses an authoring JSON payload and always includes summary, manifest summary, permission plan, versioned config, bounded metrics/logs/errors, and node states. `PluginPackageInstallRequest` (232) carries raw `.fspkg` bytes; `PluginAdminMutationRequest` (234) is an authoring JSON payload with `action`, `capabilities`, `confirmed`, `expectedConfigVersion`, and optional `config`.

The plugin control plane returns only low-cardinality errors: `plugin_not_found`, `plugin_package_invalid`, `plugin_install_confirmation_required`, `plugin_dangerous_action_confirmation_required`, `plugin_action_invalid`, `plugin_action_validation_failed`, `plugin_config_version_conflict`, `plugin_lifecycle_conflict`, and `plugin_runtime_action_failed`. Package content, Schema paths, runtime exception messages, log bodies, and signature details must not enter `ApiError`.

## Current public error categories

### Current operation count

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.operation-count
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.operation-count
render: scalar
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.operation-count -->
274
<!-- FSUSBLOG-GENERATED:END api.operation-count -->

### Public error authority reference

The API/protocol domain does not own a second error catalog. Every observed operation links its `ApiError` transport response to the stable error behavior below; the active error IDs and their transport mappings remain generated by that single authority elsewhere in this document.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.public-error-reference-state
behaviorId: binary-api-aeds-contract
claimType: failure-mode
factPath: operations
projection: binary_post_security_challenge.publicErrorRefState
render: failure-mode-code
-->

The operation-level public error reference state is `operation-status-authority-bound`: each observed error status links to its matching transport mapping in the shared error authority.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.public-error-authority-owner
behaviorId: binary-api-aeds-contract
claimType: failure-mode
factPath: errorAuthority.behaviorId
render: failure-mode-code
-->

The referenced public error authority owner is `configuration-error-security-policy`.

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.error-authority-reference
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.error-authority-reference
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.error-authority-reference -->
| Key | Value |
| --- | --- |
| behaviorId | configuration-error-security-policy |
| catalogDigest | 05fc7505ff1df2050454549f5ac0eca67a22029a5247b5508d5f674c6350edff |
| documentPath | docs/api/schemas-and-errors.md |
| factIds | ["facts.error-codes.domain.active","facts.error-codes.transport-mapping"] |
<!-- FSUSBLOG-GENERATED:END api.error-authority-reference -->

<!-- fsus-doc-claim
claimId: configuration-error-security-policy.public-errors
behaviorId: configuration-error-security-policy
claimType: generated-section
generatedSectionId: api.public-error-codes
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.public-error-codes -->
- `Conflict`
- `Forbidden`
- `InfraFailure`
- `NotFound`
- `Unauthorized`
- `Unknown`
- `Validation`
<!-- FSUSBLOG-GENERATED:END api.public-error-codes -->
