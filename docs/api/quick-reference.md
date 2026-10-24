# Route Quick Reference

This is the compact route index for FsusBlog APIs. Payload and failure details belong to the [API contracts](contracts.md); design rationale belongs to [API design](design.md).

## Legend

| Symbol | Meaning |
| ------ | ------ |
| 🔓 | Anonymous access |
| 🔑 | Authentication required (HttpOnly cookie session / AEDS auth frame) |
| 👑 | Admin role required |
| 🚦 | IP rate limit (`fixed_ip` fixed window) |
| 📦 | Binary endpoint (`application/octet-stream`, AEDS v2 frame) |
| 🗄️ | Output cache (L1 memory + OutputCache) |

---

## Authentication — `/api/binary/auth`

### PoW and account entry

### Current user

### Session management

### MFA / TOTP

---

### Recovery Key

PoW/account entry, current-user, session, MFA/TOTP, and Recovery Key routes use the canonical [authentication contracts](contracts.md).

<!-- Detailed authentication payloads are centralized in contracts.md. -->

---

## Passkey / WebAuthn — `/api/binary/auth/passkey`

See the [Passkey contracts](contracts.md) for registration, login, credential management, and signal-state payloads.

## Admin principal / Passkey — `/api/binary/auth/admin`

See the [admin-principal contracts](contracts.md) for the independent admin session flow.

---

## Public HTML status

| Request | First response | Meaning |
| ------ | -------- | ------ |
| `GET/HEAD /article/{positive-int}` | 200 / 404 / 503 | Only public articles return 200; missing, hidden, or not-yet-published articles return 404; temporary dependency failures return 503. |
| `GET/HEAD /category/{positive-int}` | 200 / 404 / 503 | A missing category never produces an empty 200 SEO page. |
| `GET/HEAD /tag/{positive-int}` | 200 / 404 / 503 | A unique tag returns a success page with self-canonical; a missing tag never produces an empty 200 SEO page. |
| `GET/HEAD /tag/{valid-name}` | 301 / 404 / 503 | The current name or persistent old alias makes one hop to `/tag/{id}`; no second 200 canonical is emitted. |
| `GET/HEAD /search[?q&sort&page]` | 200 / 301 / 400 | The first response is always noindex; NFC/whitespace, `relevance` / `latest` / `hot`, and `page=1..100` normalize to one URL; dangerous over-limit input returns 400. |
| `GET/HEAD /unknown` or an extra path segment | 404 | The server's first response is noindex; the SPA catch-all does not rewrite the meaning. |
| `.../` other than `/` | 301 | One hop to the no-trailing-slash canonical, preserving the query. |

HTML 400/404/410/503 responses always include `Cache-Control: no-store`, `X-Robots-Tag: noindex, follow`, and `X-Fsus-Public-Aot-Backfill: none`; 503 also includes `Retry-After: 5`. Negative responses contain no success-page canonical, Open Graph URL, `BlogPosting`, or hydration script. SPA-only `/search`, authentication entry points, and `/user/**` are outside this SEO success-page set; a successful search shell also emits no canonical, JSON-LD, or AOT entry.

Successful Public AOT HTML negotiates `fsusblog.locale` cookie > `Accept-Language` > `zh-CN` and uses only canonical codes from the shared catalog. `Content-Language`, HTML lang/dir, OG, visible copy, payload `renderLocale`, and cache identity must agree, with `Vary: Accept-Language, Cookie`. Any other cookie still sends PublicHotRead L0 through the normal pipeline.

## Articles

Article routes use the `/api/binary/article/**` AEDS v2 frames below; legacy `/api/Article/**` JSON routes are not registered.

## Comments — `/api/binary/comment`

Comment payload and policy details are in the [comment contracts](contracts.md); routes are listed with the binary endpoints below.

---

## Categories / tags

Category and tag routes use the `/api/binary/category.aeds` and `/api/binary/tag.aeds` AEDS v2 frames below; legacy `/api/Category/**` and `/api/Tag/**` JSON routes are not registered.

`POST/PUT /api/binary/category` and `/api/binary/tag` write `Name` plus nullable `Description`. Trimmed descriptions are at most 500 Unicode characters; whitespace persists as `NULL`. During migration, the exact 128-byte name-only legacy create writes a null description, while legacy update preserves the existing description.

If PublicHot delivery is `cancelled`, `closed`, or `failed`, the mutation returns HTTP `500` plus AEDS `ApiError(Code=InfraFailure)`, even if the taxonomy database mutation committed. The client must reread admin taxonomy state before deciding whether to retry. For no-restart recovery, repair Redis and invoke the `public-hot-rebuild` action at `/api/binary/author/cache/actions`; retain the pending generation and never downgrade to in-process success or blindly replay create.

## System configuration — `/api/binary/system`

System configuration payloads are defined in the [system contracts](contracts.md).

---

## Integrity verification sidecars — `/integrity`

These public JSON manifests are outside the `/api/binary/**` AEDS main path.

| Method | Path | Access | Cache | Meaning |
| ------ | ------ | ------ | ------ | ------ |
| GET | `/integrity/keys.json` | 🔓 | 🗄️ | Public signing-key registry; no private key. |
| GET | `/integrity/article/{articleId}` | 🔓 | 🗄️ | Current public-article publish proof; ready/superseded is immutable, other states are no-store. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}` | 🔓 | 🗄️ | Publish proof for the specified public-article revision number. |
| GET | `/integrity/article/{articleId}/rights` | 🔓 | 🗄️ | Current public-article Rights V3 proof; ready/superseded is immutable, other states are no-store. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/rights` | 🔓 | 🗄️ | Rights V3 proof for the specified public-article revision number. |
| GET | `/integrity/article/{articleId}/responsibility` | 🔓 | 🗄️ | Current responsibility manifest; a public legacy article with no historical revision receives a deterministic legacy fallback. |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/responsibility` | 🔓 | 🗄️ | Responsibility manifest for the specified revision; an absent revision returns 404. |
| GET | `/integrity/revisions/{articleRevisionId}` | 🔓 | 🗄️ | Publish proof selected by `ArticleRevision.Id`. |
| GET | `/integrity/checkpoints/latest` | 🔓 | 🗄️ | Latest Merkle checkpoint manifest. |
| GET | `/integrity/checkpoints/{date}` | 🔓 | 🗄️ | UTC daily checkpoint manifest for `yyyy-MM-dd`. |
| GET | `/integrity/log/head` | 🔓 | 🗄️ | Current transparency-log head. |
| GET | `/api/admin/integrity/console` | 👑🚦 | no-store | Admin Integrity Proof status view; requires `system.config`. |
| POST | `/api/admin/integrity/console/proofs/{proofId}/retry` | 👑🚦 step-up | no-store | Retry a failed/retrying/pending proof; requires `system.config` and admin step-up. |

---

## Binary endpoints — `/api/binary`

All runtime API output uses `Content-Type: application/octet-stream` (AEDS v2 frames). Clients must prefer `/api/binary/**`; legacy text APIs are not registered.

### Read proof

The read-proof challenge and submission routes are listed in the [binary routes](#binary-routes).

### RUM telemetry

The RUM ingestion route is listed in the [binary routes](#binary-routes).

### Binary routes

| Binary path | Access | FrameType | Meaning |
| ------------ | ------ | ----------- | ------ |
| GET `/api/binary/article/search/query.aeds?q={keyword}` | 🔓 📦 | `ArticleSearch`(4) | Product Search HTTP API over the canonical search index; empty keyword fails validation; response may carry `X-Fsus-Search-Index-Generation`. |
| GET `/api/binary/article/list/home/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | Home article list; omit cursor on the first page and return the opaque cursor unchanged thereafter; page URL remains supported. |
| GET `/api/binary/article/list/archive/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | Archive article list; cursor/page semantics match home. |
| GET `/api/binary/article/list/category/{categoryId}/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | Category article list; cursor is bound to the category filter and cannot be reused across filters. |
| GET `/api/binary/article/list/tag/{tagId}/{page}/{size}.aeds?cursor={nextCursor}` | 🔓 📦 | `ArticleList`(1) | Tag article list; cursor is bound to the tag filter and cannot be reused across filters. |
| GET `/api/binary/article/{id}.aeds` | 🔓 📦 | `ArticleDetail`(2) | Article-detail L0 artifact. |
| GET `/api/binary/article/hot/{size}.aeds` | 🔓 📦 | `ArticleHot`(3) | Hot-article L0 artifact. |
| GET `/api/binary/category.aeds` | 🔓 📦 | `CategoryList`(9) | Category metadata L0 artifact. |
| GET `/api/binary/category/{id}.aeds` | 🔓 | `TaxonomyExactMetadata`(243) | Anonymous exact category metadata: id/name/nullable description; not an L0 list artifact. |
| GET `/api/binary/tag.aeds` | 🔓 📦 | `TagList`(10) | Tag metadata L0 artifact. |
| GET `/api/binary/tag/{id}.aeds` | 🔓 | `TaxonomyExactMetadata`(243) | Anonymous exact tag metadata: id/name/nullable description; not an L0 list artifact. |
| GET `/api/binary/tag/by-name.aeds?name=` | 🔓 | `TaxonomyExactMetadata`(243) | Resolve the display name or `TagUrlAlias` to the current canonical tag and return the same exact metadata. |
| GET `/api/binary/article/html/{pathKey}.html` | 🔓 | `text/html` | AOT HTML diagnostic/preview artifact; it does not replace the real public URL. |
| GET `/api/public/navigation-snapshot.aeds?path={publicPath}` | 🔓 📦 | `PublicAotBootstrap`(71) | Public route-transition snapshot with versioned/digested `seoHead`; the client validates origin/path/entity before atomic takeover; `Content-Type: application/vnd.fsus.aeds`; ETag plus `Cache-Control: no-cache` forces revalidation. |
| GET `/api/binary/comment/{articleId}` | 🔓 📦 | `CommentArticleCursor`(5) | Article comments. |
| GET `/api/binary/comment/{articleId}/thread/{rootId}` | 🔓 📦 | `CommentThreadReplyCursor`(8) | Comment thread. |
| GET `/api/binary/comment/me` | 🔑 📦 | `CommentUserCursor`(6) | Current user's attributable comments; optional `articleId` forms a private ownership overlay; strong-anonymous comments are not account-side records. |
| GET `/api/binary/comment/policy` | 🔓 📦 | `CommentPolicySnapshot`(164) | Public comment-composer policy and ZK-Prod readiness. |
| POST `/api/binary/comment` | 🔑 🚦 📦 | `CommentCreateV2Request`(166) → `CommentCreateResult`(205) | Explicit opt-in public comment only; requires canonical lowercase UUID `X-Fsus-Client-Mutation-Id`; returns IDs, tree coordinates, creation time, final visibility, and replay flag. |
| POST `/api/binary/comment/anonymous-ticket` | 🔓 🚦 📦 | `AnonymousCommentTicketRequest`(198) → `AnonymousCommentTicketResponse`(199) | v5/layout 6 minimum qualification predicate; requires `credentials: omit`; scope v1 binds article top (1 comment/credential period) or article+thread (3/period); short-TTL one-time ticket. |
| POST `/api/binary/comment/anonymous` | 🔓 🚦 📦 | `AnonymousCommentCreateRequest`(182) → `AnonymousCommentCreateResult`(214) | Strong-anonymous submission; first success returns a one-time management secret, while the server stores only its SHA-256 commitment; idempotent replay does not restore the secret and rejects login-state contamination. |
| POST `/api/binary/comment/{id}/author/challenge` | 🔑 🚦 📦 | `CommentManagementChallengeRequest`(215) → `CommentManagementChallengeResponse`(216) | Account-owned public author receives a one-time edit/delete challenge and current version. |
| POST `/api/binary/comment/{id}/author/edit` | 🔑 🚦 📦 | `CommentAuthorEditRequest`(217) → `CommentAuthorMutationResult`(218) | Public author edits by `expectedVersion` CAS and triggers re-moderation. |
| POST `/api/binary/comment/{id}/author/delete` | 🔑 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorMutationResult`(218) | Public author soft-deletes with a one-time challenge. |
| POST `/api/binary/comment/{id}/management/challenge` | 🔓 🚦 📦 | `CommentManagementChallengeRequest`(215) → `CommentManagementChallengeResponse`(216) | Strong-anonymous author submits capability in the body; URL or account recovery is not accepted. |
| POST `/api/binary/comment/{id}/management/edit` | 🔓 🚦 📦 | `CommentAuthorEditRequest`(217) → `CommentAuthorMutationResult`(218) | Strong-anonymous author edits with capability, challenge, and `expectedVersion`. |
| POST `/api/binary/comment/{id}/management/delete` | 🔓 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorMutationResult`(218) | Strong-anonymous author deletes with a one-time challenge. |
| POST `/api/binary/comment/{id}/management/status` | 🔓 🚦 📦 | `CommentAuthorStatusRequest`(219) → `CommentAuthorStatusResult`(220) | Capability-scoped single-comment moderation-status read; enumeration is unsupported. |
| POST `/api/binary/comment/{id}/management/appeal` | 🔓 🚦 📦 | `CommentAuthorAppealRequest`(221) → `CommentAuthorMutationResult`(218) | Capability-scoped appeal; secret/challenge travel only in a no-store body. |
| POST `/api/binary/comment/{id}/author/appeal` | 🔒 🚦 📦 | `CommentAuthorAppealRequest`(221) → `CommentAuthorMutationResult`(218) | Public-author account ownership plus one-time challenge. |
| POST `/api/binary/comment/{id}/report` | 🔒 🚦 📦 | `CommentReportRequest`(223) → `CommentReportResult`(224) | Account deduplication by comment; does not auto-hide. |
| POST `/api/binary/comment/{id}/anonymous-report` | 🔓 🚦 📦 | `CommentReportRequest`(223) → `CommentReportResult`(224) | No identity contamination; comment-scoped credential HMAC. |
| GET `/api/binary/author/comments/{id}/moderation-timeline` | 🛡️ 🚦 📦 | → `CommentModerationTimeline`(225) | Admin rebuilds the projection and checks consistency. |
| POST `/api/binary/author/moderation/appeals/{id}/decision` | 🛡️ 🚦 📦 | `CommentAppealDecisionRequest`(226) → `CommentAppealDecisionResult`(227) | Independent review plus step-up. |
| GET `/api/binary/author/comments/{id}/revisions` | 🛡️ 🚦 📦 | `CommentRevisionList`(222) | Admin views the full revision sequence; public reads never return historical body text. |

Comment-creation idempotency defaults to a 24-hour window (`Comments:MutationIdempotencyTtlHours` is constrained to 1..168). During the window, the same public account/mutation ID or anonymous ticket commitment writes at most once; the complete result is fixed as `commentId/rootId/parentId/createdAtUtc/moderationStatus/visibilityState/isPubliclyVisible/idempotencyReplay`. Hot-reloaded `Comments:MutationIdempotencyEnabled=false` fails closed for both creates with `503 comment_mutation_idempotency_disabled`; reads and the notification stream remain available.
| GET `/api/binary/system/seo` | 🔓 📦 | `SeoConfig`(13) | Public SEO, brand, and PWA configuration. |
| GET `/api/binary/system/compliance` | 🔓 📦 | `SiteComplianceConfig`(26) | Public compliance-footer configuration. |
| GET `/api/binary/system/page/{slug}` | 🔓 📦 | `PageContent`(14) | Public static-page content; slug allowlist as above. |
| POST `/api/binary/read-proof/challenge.aeds` | 🔓 🚦 📦 | `HumanReadChallengeRequest`(73) → `HumanReadChallengeResponse`(28) | Human-read challenge; limited by `read_proof`. |
| POST `/api/binary/read-proof/submit.aeds` | 🔓 🚦 📦 | `HumanReadSubmitRequest`(74) → `HumanReadSubmitResponse`(29) | Human-read proof submission; raw IP is synchronously reduced to a short-lived HMAC, and statistics are discarded when deduplication is unavailable. |
| POST `/api/binary/security/challenge` | 🔓 🚦 📦 | `SecurityChallengeIssueRequest`(173) → `SecurityChallengeIssueResponse`(175) | Issues a UUIDv7 envelope and returns only the first actionable member of the server-ordered plan; later members remain planned; no JSON fallback. |
| POST `/api/binary/security/challenge/verify` | 🔓 🚦 📦 | `SecurityChallengeVerifyRequest`(174) → `SecurityChallengeVerifyResponse`(176) | Atomically completes the current member and issues the unique next assignment/payload; returns aggregate `proofToken` and authoritative `expiresAtUnixMs` only after all members complete. |
| POST `/api/binary/security/challenge/cancel` | 🔓 🚦 📦 | `SecurityChallengeCancelRequest`(200) → `EmptySuccess`(240) | Revokes the whole envelope on refresh/cancel, identity or route change, or unload; complete binding mismatch still returns opaque idempotent success; no JSON fallback. |
| `PerceptionCharacterV3` union | 🔓 🚦 📦 | issue: final PNG/Ogg Opus + opaque state; verify: answer + opaque state | `kind=14` typed member; 32/48 KiB hard limits; two atomic attempts; no retired V3/JSON/V1/V2 fallback. |
| GET `/api/binary/anonymous-credential/root` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | Public credential root/epoch/expiry/circuit metadata; `public_read` limited. |
| GET `/api/binary/anonymous-credential/circuit` | 🔓 🚦 📦 | `AnonymousCredentialRootSnapshot`(179) | Same root snapshot, used by the prover to warm circuit/verifying-key metadata. |
| POST `/api/binary/anonymous-credential/revocation-witness` | 🔓 🚦 📦 | Fixed `ApiError` / 410 | Credential-specific witness is permanently retired; body and parameters are not read. |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/full.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationSnapshot`(196) | Same content-addressed immutable public full snapshot for every client; coordinate conflict 409, not generated 404, provider unavailable 503. |
| GET `/api/binary/anonymous-credential/revocation/{epoch}/{version}/{root}/delta/{baseVersion}.aeds` | 🔓 🚦 📦 | `AnonymousCredentialRevocationDelta`(197) | Public append-only delta; clients may update only from the exact previous version; coordinate conflict 409, not generated 404, provider unavailable 503. |
| GET `/api/binary/anonymous-credential/blind-issuer` | 🔓 🚦 📦 | `BlindCredentialIssuerMetadata`(193) | RFC 9474 profile, root binding, issuer SPKI/hash; `public_read`, `no-store`, and 503 when runtime-disabled. |
| POST `/api/binary/anonymous-credential/blind-issue` | 🔑 🚦 📦 | `BlindCredentialIssueRequest`(194) → `BlindCredentialIssueResponse`(195) | RFC 9474 blind issuance; accepts only a 384B blinded representative, with uniform rejection and delay buckets, `no-store`. |
| POST `/api/binary/telemetry/rum` | 🔓 🚦 📦 | `RumMetricBatchRequest`(75) → `RumMetricIngestResponse`(76) | Anonymous RUM batch ingestion; `credentials: omit`. |

Public article list/detail/search payloads carry `currentRevisionId/revisionNo/currentPublicationId/publicationNo`. When a published article has a future revision, these routes continue returning the old publication until the scheduled worker atomically switches projections to the new coordinates; no public “read-latest-revision” fallback exists.

### Administration binary

Administrative routes are included in the authoring and security table below.

---

## Messaging — `/api/binary/messages`

The entire route group requires authentication (🔑).

---

## Administrative messaging — `/api/binary/admin/messages`

The entire route group requires the admin role (👑).

Hot-reloading `Messages:ReplyWritesEnabled=false` pauses both reply endpoints with `503 message_reply_writes_disabled`; reads and explicit status changes remain available. `Messages:MutationIdempotencyEnabled=false` fails closed for creates, both reply types, and system-send with `503 message_mutation_idempotency_disabled`; never fall back to writes without mutation/source identity. `Messages:AdminAccountProjectionEnabled=false` pauses both admin reads with `503 message_admin_account_projection_disabled`; account message endpoints and their existing frames remain available. `Messages:StatusMutationsEnabled=false` pauses admin status writes with `503 message_status_mutations_disabled`; reads and the notification stream are unaffected. `Messages:SystemMessageTargetValidationEnabled=false` fails closed for new system messages with `503 system_message_target_validation_disabled`; a replay with the same digest for an already submitted source event still returns the original result.

## Open distribution and authoring workbench

### 开放分发与作者工作台

The production authoring frontend calls native `/api/binary/author/**` AEDS v2 endpoints; external `/api/author/**` JSON entry points and the internal bridge compatibility layer are removed. The production admin-security frontend likewise calls native `/api/binary/admin/security/**` AEDS v2 endpoints; external `/api/admin/security/**` JSON entry points and the bridge are removed.

| POST | `/api/binary/author/drafts` | 👑 | Save with `expectedServerRevision` CAS; return incremented `serverRevision` and original `baseRevisionId`. |
| GET | `/api/binary/author/drafts/{draftKey}` | 👑 | Read server draft, `serverRevision`, and original `baseRevisionId`. |
| DELETE | `/api/binary/author/drafts/{draftKey}?expectedServerRevision={revision}` | 👑 | Discard when the version precondition matches; stale returns `draft_conflict`. |
| POST | `/api/binary/author/preview` | 👑 | Admin-only structured private preview (normalized fields, source identity, issues; no HTML). |
| POST | `/api/binary/author/prepublish-check` | 👑 | Pre-publication SEO/content-quality check. |
| GET | `/api/binary/author/articles/{articleId}/revisions` | 👑 | Article revision list. |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}` | 👑 | Complete historical package: body, rights, responsibility, and release coordinates; missing parts are explicit through `packageComplete`. |
| GET | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/responsibility` | 👑 | `ArticleResponsibilityHistory(228)`; append-only responsibility history in reverse version order. |
| PUT | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/responsibility` | 👑 | Append a responsibility version with `expectedVersion` CAS; conflict returns HTTP 409. |
| POST | `/api/binary/author/articles/{articleId}/revisions/{revisionId}/rollback` | 👑 | `ArticleRevisionRollbackRequest(213)` → 48B typed `MutationId(241)` result; submit base revision, Draft/Published/Archived target, and audit reason; copy the complete package to a new revision/release; conflicts or incomplete packages write nothing. |
| POST | `/api/binary/author/articles/{articleId}/assets/reindex` | 👑 | Rebuild asset references. |
| GET | `/api/binary/author/assets` | 👑 | Asset-library list. |
| DELETE | `/api/binary/author/assets/orphans` | 👑 | Delete orphaned asset-library records. |
| GET | `/api/binary/author/taxonomy/categories` | 👑 | Admin category real-reference counts. |
| GET | `/api/binary/author/taxonomy/tags` | 👑 | Admin tag real-reference counts. |
| GET | `/api/binary/author/analytics` | 👑 | Single-author analytics. |
| GET | `/api/binary/author/comments/moderation?status&limit&cursor` | 👑 `comment.moderate` | Stable keyset moderation queue; returns `nextCursor`, comment/claim row versions, and lease state. |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim` | 👑 `comment.moderate` | Claim a moderation lease; an active-lease conflict returns 409. |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/renew` | 👑 `comment.moderate` | Renew with token + generation + claim row version. |
| POST | `/api/binary/author/comments/{commentId}/moderation/claim/release` | 👑 `comment.moderate` | Release with token + generation + claim row version. |
| POST | `/api/binary/author/comments/moderation/bulk` | 👑 `comment.moderate` 🚦 MFA | Bulk comment moderation. |
| POST | `/api/binary/author/comments/{commentId}/moderation` | 👑 `comment.moderate` 🚦 MFA | Moderate a comment. |
| GET | `/api/binary/author/moderation/overview` | 👑 | Moderation-system overview. |
| GET | `/api/binary/author/moderation/anonymous-comment-policy` | 👑 | Read anonymous-comment policy. |
| PUT | `/api/binary/author/moderation/anonymous-comment-policy` | 👑🚦 MFA | Update anonymous-comment policy. |
| POST | `/api/binary/author/comments/moderation/nullifiers/block` | 👑🚦 MFA | Block an anonymous-comment nullifier. |
| POST | `/api/binary/author/comments/moderation/anonymous-credentials/{credentialId}/revoke` | 👑🚦 MFA | Revoke an anonymous credential. |
| GET | `/api/binary/admin/anonymous-governance/status` | 👑🚦 MFA | Anonymous-governance admin status and root/revocation aggregate. |
| GET | `/api/binary/admin/anonymous-governance/nullifiers` | 👑🚦 MFA | Anonymous-nullifier governance list; shows masked hashes only. |
| POST | `/api/binary/admin/anonymous-governance/nullifiers/block` | 👑🚦 MFA | Block an anonymous-governance nullifier. |
| POST | `/api/binary/admin/anonymous-governance/credentials/revoke` | 👑🚦 MFA | Revoke an anonymous credential by revocation handle. |
| GET | `/api/binary/author/moderation/dictionaries` | 👑 | Read-only moderation dictionaries and regional-policy snapshot metadata. |
| POST | `/api/binary/author/moderation/dictionaries/reload` | 👑🚦 MFA | Manually reload moderation dictionaries and regional-policy snapshot. |
| POST | `/api/binary/author/moderation/dictionaries/rollback` | 👑🚦 MFA | Roll back to the last successfully loaded dictionary/regional-policy snapshot. |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/enable` | 👑🚦 MFA | Enable a runtime dictionary override. |
| POST | `/api/binary/author/moderation/dictionaries/{dictionaryId}/disable` | 👑🚦 MFA | Disable a runtime dictionary override; the CN-MAINLAND mandatory dictionary requires a confirmation phrase. |
| GET | `/api/binary/author/moderation/policies` | 👑 | Regional-policy summary and CN-MAINLAND mandatory checks. |
| GET | `/api/binary/author/moderation/regions` | 👑 | Region catalog with built-in/custom regions and template bindings. |
| GET | `/api/binary/author/moderation/region-groups` | 👑 | Region-group catalog with member regions and group templates. |
| GET | `/api/binary/author/moderation/policy-templates` | 👑 | Default/custom policy presets, review markers, and checksums. |
| GET | `/api/binary/author/moderation/effective-policy/{regionCode}` | 👑🚦 | Preview the effective policy for a region. |
| POST | `/api/binary/author/moderation/effective-policy/preview` | 👑🚦 | Preview an effective policy with an operator override. |
| POST | `/api/binary/author/moderation/replay/preview` | 👑🚦 | Preview a policy-replay diff without applying changes. |
| GET | `/api/binary/author/moderation/runtime/status` | 👑 | Global, regional, dictionary, and model moderation-runtime status. |
| POST | `/api/binary/author/moderation/runtime/global-state` | 👑🚦 MFA | Adjust global moderation-runtime state. |
| POST | `/api/binary/author/moderation/runtime/region-state` | 👑🚦 MFA | Adjust regional moderation-runtime state and clear comment-frame cache. |
| GET | `/api/binary/author/moderation/model/status` | 👑 | Moderation-model configuration and latency/error telemetry. |
| POST | `/api/binary/author/moderation/model/runtime` | 👑🚦 MFA | Hot-switch model provider/profile and enabled state. |
| POST | `/api/binary/author/moderation/model/reload` | 👑🚦 MFA | Hot-reload the model runtime snapshot from configuration. |
| POST | `/api/binary/author/moderation/model/rollback` | 👑🚦 MFA | Roll back the previous model runtime snapshot. |
| GET | `/api/binary/admin/security/overview` | 👑 | Security-system overview: AntiCrawler, PoW, and SecurityRisk. |
| GET | `/api/binary/admin/security/risk-control/overview` | 👑 | RiskControl active policy, risk-event aggregate, and challenge success/failure rates. |
| GET | `/api/binary/admin/security/risk-control/options` | 👑 | RiskControl active runtime policy snapshot |
| PUT | `/api/binary/admin/security/risk-control/options` | 👑🚦 MFA | Update RiskControl mode, PoSpace/PublicRead/Comment/Auth switches, and strict multiplier. |
| POST | `/api/binary/admin/security/risk-control/options/rollback` | 👑🚦 MFA | Roll back the previous RiskControl last-known-good policy. |
| POST | `/api/binary/admin/security/risk-control/simulate` | 👑🚦 | RiskControl dry run through the production decision chain; returns riskScore, decision, reasons, requiredChallenges, and policyVersion without issuing a challenge or changing risk score. |
| GET | `/api/binary/admin/security/challenges/overview?kind={kind}` | 👑 | Challenge issuance, attempts, and success/failure rates; `kind` accepts only the current provider wire kind. |
| GET | `/api/binary/admin/security/policies/overview` | 👑 | Active RiskControl, AntiCrawler, PoW, and persisted policy versions. |
| GET | `/api/binary/admin/security/anti-crawler/overview` | 👑 | Anti-crawler overview, CIDRs, risk events, rules, and lists. |
| GET | `/api/binary/admin/security/anti-crawler/options` | 👑 | Anti-crawler runtime-policy snapshot. |
| PUT | `/api/binary/admin/security/anti-crawler/options` | 👑🚦 MFA | Update AntiCrawler mode, local switches, thresholds, rate-limit quota, and CIDR update configuration. |
| POST | `/api/binary/admin/security/anti-crawler/options/rollback` | 👑🚦 MFA | Roll back the previous anti-crawler policy snapshot. |
| GET | `/api/binary/admin/security/anti-crawler/crawler-ranges/status` | 👑 | CIDR worker status, update time, next sync, and range count. |
| POST | `/api/binary/admin/security/anti-crawler/crawler-ranges/sync` | 👑🚦 MFA | Manually sync Google/Bing crawler CIDRs. |
| GET | `/api/binary/admin/security/anti-crawler/risk-events` | 👑 | Anti-crawler risk events; `limit` is clamped to 1..1000. |
| GET | `/api/binary/admin/security/anti-crawler/rules` | 👑 | Anti-crawler rules. |
| POST | `/api/binary/admin/security/anti-crawler/rules` | 👑🚦 MFA | Add an anti-crawler rule. |
| PUT | `/api/binary/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | Update an anti-crawler rule. |
| DELETE | `/api/binary/admin/security/anti-crawler/rules/{id}` | 👑🚦 MFA | Delete an anti-crawler rule. |
| GET | `/api/binary/admin/security/anti-crawler/allowlist` | 👑 | Anti-crawler allowlist. |
| POST | `/api/binary/admin/security/anti-crawler/allowlist` | 👑🚦 MFA | Add an allowlist entry. |
| DELETE | `/api/binary/admin/security/anti-crawler/allowlist/{id}` | 👑🚦 MFA | Delete an allowlist entry. |
| GET | `/api/binary/admin/security/anti-crawler/blocklist` | 👑 | Anti-crawler blocklist. |
| POST | `/api/binary/admin/security/anti-crawler/blocklist` | 👑🚦 MFA | Add a blocklist entry. |
| DELETE | `/api/binary/admin/security/anti-crawler/blocklist/{id}` | 👑🚦 MFA | Delete a blocklist entry. |
| POST | `/api/binary/admin/security/anti-crawler/simulate` | 👑🚦 | Anti-crawler policy simulator; applies no changes. |
| GET | `/api/binary/admin/security/pow/overview` | 👑 | PoW-system overview. |
| GET | `/api/binary/admin/security/pow/options` | 👑 | Independent PoW policy snapshot. |
| PUT | `/api/binary/admin/security/pow/options` | 👑🚦 MFA | Update PoW mode, difficulty, TTL, replay, and risk linkage. |
| POST | `/api/binary/admin/security/pow/options/rollback` | 👑🚦 MFA | Roll back the previous PoW policy snapshot. |
| GET | `/api/binary/admin/security/pow/events` | 👑 | PoW risk events; `limit` is clamped to 1..1000. |
| GET | `/api/binary/admin/security/risk/events` | 👑 | Unified security-risk events; `limit` is clamped to 1..1000. |
| GET | `/api/binary/admin/security/risk/snapshots` | 👑 | Unified security-risk subject snapshots; `limit` is clamped to 1..1000. |
| POST | `/api/binary/admin/security/risk/ip/reset` | 👑🚦 MFA | Reset an IP risk score. |
| GET | `/api/binary/author/content/export` | 👑 | Full-site content backup package. |
| GET | `/api/binary/author/articles/{articleId}/export` | 👑 | Export Markdown plus frontmatter. |
| POST | `/api/binary/author/articles/import` | 👑 | Create-new import of Markdown plus frontmatter; never overwrite by source article ID; bind the default policy snapshot when rights are absent. |
| GET | `/api/binary/author/audit` | 👑🚦 | Audit-log cursor list with actor/action/target/outcome/time filters. |
| GET | `/api/binary/author/audit/summary` | 👑🚦 | Audit facets and write runtime. |
| GET | `/api/binary/author/audit/{id}` | 👑🚦 | Audit detail and context. |
| GET | `/api/binary/author/audit/{id}/verify` | 👑🚦 | Verify one tamper-evident audit proof. |
| GET | `/api/binary/author/ops/health` | 👑🚦 | Operational health: DB/Redis/audit/worker/search/backup/queue and structured recent errors. |
| GET | `/api/binary/author/ops/backup` | 👑🚦 | Recent site-backup and restore-drill status. |
| GET | `/api/binary/author/ops/dangerous-operations/policy` | 👑🚦 | Admin dangerous-operation confirmation, MFA, and diff policy. |
| GET | `/api/binary/author/cache/diagnostics` | 👑🚦 | Combined AOT/PublicHotRead/search/sitemap/feed/comment cache and HotArticles/Stats invalidation status. |
| POST | `/api/binary/author/cache/actions` | 👑🚦 | Manually rebuild search/AOT or clear output cache. |
| GET | `/api/binary/author/integrity` | 👑🚦 | Data-consistency inspection report. |
| GET | `/api/binary/author/integrity/fix-preview` | 👑🚦 | Preview a security-fix diff. |
| POST | `/api/binary/author/integrity/fix` | 👑🚦 step-up | Apply a security fix; requires a confirmation phrase and admin step-up proof. |
| POST | `/api/binary/author/ai-assist` | 👑 | Author AI assistance, disabled by default. |

---

## Notifications and health checks

The notification channel is an AEDS WebSocket stream, not Server-Sent Events; it does not use `EventSource` or `text/event-stream`. v2 `ArticleChanged(8)` payloads carry nullable `revisionId/releaseId` coordinates; the frontend receives int64 values as decimal strings. If the coordinates are superseded before dispatch, the event is not published and the remaining outbox edge is marked skipped. A Passkey-counter rollback publishes `NotificationStreamEventType.SessionRevoked=16` after persisting revocation of all ordinary sessions; browsers clear ordinary account state and force re-authentication across tabs, while an independent admin session remains active.

---

## Rate-limit policy

Endpoints marked 🚦 use the `fixed_ip` policy and count by client IP.

- Over-limit response: `429 Too Many Requests`.
- Response includes `Retry-After` in seconds.
- IP source: `X-Forwarded-For` (Nginx must set `proxy_set_header X-Forwarded-For`).

---

## See also

- [design.md](design.md) — API design principles and conventions
- [contracts.md](contracts.md) — Complete request/response DTO definitions
- [schemas-and-errors.md](schemas-and-errors.md) — Error codes and binary frame format
- [../api.md](../api.md) — API overview (including the AEDS frame appendix)

## Article/thread comment policy

| Endpoint | Auth | Response | Purpose |
| --- | --- | --- | --- |
| GET `/api/binary/comment/policy?articleId=&rootId=` | 🔓 📦 | `CommentPolicySnapshot`(164) | Site → article → thread effective composer policy |
| GET/PUT `/api/authoring/moderation/articles/{articleId}/comment-policy` | 🔐 📦 | `CommentPolicySnapshot`(164) envelope | Admin article override, moderation/slow mode, and optimistic version |
| PUT `/api/authoring/moderation/articles/{articleId}/comment-threads/{rootId}` | 🔐 📦 | `CommentPolicySnapshot`(164) envelope | Admin single-thread lock/unlock and audit |

## Cluster operations

| Method and path | Permission | Response | Meaning |
| --- | --- | --- | --- |
| GET `/api/ops/cluster/nodes` | independent admin principal + `system.config` + `fixed_ip` | JSON cluster runtime snapshot, `no-store` | Nodes, role state, lease/checkpoint summary, events, health, and metrics; single returns the local healthy node. |
| POST `/api/ops/cluster/nodes/{nodeId}/state` | Same + trusted origin + `X-Fsus-Mfa-Proof` | JSON node state, `no-store` | Only `alive\|draining\|maintenance`. |
| POST `/api/ops/cluster/scheduler` | Same + trusted origin + `X-Fsus-Mfa-Proof` | JSON scheduling latch, `no-store` | Stop/resume new-role scheduling without restart. |
| POST `/api/ops/cluster/leases/{leaseId}/release-expired` | Same + trusted origin + `X-Fsus-Mfa-Proof` | JSON release result, `no-store` | Clean up expired leases only; never force-release an active lease. |

## Plugin administration

## Current operation identities

<!-- fsus-doc-claim
claimId: binary-api-aeds-contract.operation-keys
behaviorId: binary-api-aeds-contract
claimType: generated-section
generatedSectionId: api.operation-keys
render: enum-set
-->

<!-- FSUSBLOG-GENERATED:BEGIN api.operation-keys -->
- `DELETE /api/binary/admin/article/permanent/{id:int}`
- `DELETE /api/binary/admin/article/trash`
- `DELETE /api/binary/admin/article/{id:int}`
- `DELETE /api/binary/admin/security/anti-crawler/allowlist/{id}`
- `DELETE /api/binary/admin/security/anti-crawler/blocklist/{id}`
- `DELETE /api/binary/admin/security/anti-crawler/rules/{id}`
- `DELETE /api/binary/auth/passkey/credentials/{id:int}`
- `DELETE /api/binary/author/assets/orphans`
- `DELETE /api/binary/author/drafts/{draftKey}`
- `DELETE /api/binary/category/{id:int}`
- `DELETE /api/binary/comment/{id:long}`
- `DELETE /api/binary/file/delete`
- `DELETE /api/binary/subscriptions`
- `DELETE /api/binary/tag/{id:int}`
- `DELETE /api/binary/upload/{uploadId}`
- `GET /api/binary/admin/anonymous-governance/nullifiers`
- `GET /api/binary/admin/anonymous-governance/status`
- `GET /api/binary/admin/article`
- `GET /api/binary/admin/article/featured`
- `GET /api/binary/admin/article/hot`
- `GET /api/binary/admin/article/{id:int}`
- `GET /api/binary/admin/messages/conversations`
- `GET /api/binary/admin/messages/conversations/{id:long}`
- `GET /api/binary/admin/security/anti-crawler/allowlist`
- `GET /api/binary/admin/security/anti-crawler/blocklist`
- `GET /api/binary/admin/security/anti-crawler/crawler-ranges/status`
- `GET /api/binary/admin/security/anti-crawler/events`
- `GET /api/binary/admin/security/anti-crawler/options`
- `GET /api/binary/admin/security/anti-crawler/overview`
- `GET /api/binary/admin/security/anti-crawler/risk-events`
- `GET /api/binary/admin/security/anti-crawler/rules`
- `GET /api/binary/admin/security/challenges/overview`
- `GET /api/binary/admin/security/overview`
- `GET /api/binary/admin/security/perception-v2/options`
- `GET /api/binary/admin/security/perception-v2/overview`
- `GET /api/binary/admin/security/policies/overview`
- `GET /api/binary/admin/security/pow/events`
- `GET /api/binary/admin/security/pow/options`
- `GET /api/binary/admin/security/pow/overview`
- `GET /api/binary/admin/security/risk-control/options`
- `GET /api/binary/admin/security/risk-control/overview`
- `GET /api/binary/admin/security/risk/events`
- `GET /api/binary/admin/security/risk/snapshots`
- `GET /api/binary/admin/users`
- `GET /api/binary/anonymous-credential/blind-issuer`
- `GET /api/binary/anonymous-credential/circuit`
- `GET /api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/delta/{baseVersion:long}.aeds`
- `GET /api/binary/anonymous-credential/revocation/{epoch:long}/{version:long}/{revocationRoot}/full.aeds`
- `GET /api/binary/anonymous-credential/root`
- `GET /api/binary/article/featured/{size}.aeds`
- `GET /api/binary/article/hot/{size}.aeds`
- `GET /api/binary/article/list/archive/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/category/{categoryId:int}/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/home/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/list/tag/{tagId:int}/{page:int}/{size:int}.aeds`
- `GET /api/binary/article/search/query.aeds`
- `GET /api/binary/article/{articleId:int}/related.aeds`
- `GET /api/binary/article/{id}.aeds`
- `GET /api/binary/auth/admin/me`
- `GET /api/binary/auth/admin/sessions`
- `GET /api/binary/auth/enrollment/status`
- `GET /api/binary/auth/me`
- `GET /api/binary/auth/mfa/profile`
- `GET /api/binary/auth/passkey/credentials`
- `GET /api/binary/auth/passkey/signal-state`
- `GET /api/binary/auth/pow-challenge`
- `GET /api/binary/auth/sessions`
- `GET /api/binary/auth/{id:int}`
- `GET /api/binary/author/analytics`
- `GET /api/binary/author/articles/{articleId:int}/export`
- `GET /api/binary/author/articles/{articleId:int}/revisions`
- `GET /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}`
- `GET /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility`
- `GET /api/binary/author/assets`
- `GET /api/binary/author/audit`
- `GET /api/binary/author/audit/summary`
- `GET /api/binary/author/audit/{id:long}`
- `GET /api/binary/author/audit/{id:long}/verify`
- `GET /api/binary/author/cache/diagnostics`
- `GET /api/binary/author/comments/moderation`
- `GET /api/binary/author/comments/{commentId:long}/moderation-timeline`
- `GET /api/binary/author/comments/{commentId:long}/revisions`
- `GET /api/binary/author/content/export`
- `GET /api/binary/author/drafts/{draftKey}`
- `GET /api/binary/author/integrity`
- `GET /api/binary/author/integrity/fix-preview`
- `GET /api/binary/author/moderation/anonymous-comment-policy`
- `GET /api/binary/author/moderation/articles/{articleId:int}/comment-policy`
- `GET /api/binary/author/moderation/dictionaries`
- `GET /api/binary/author/moderation/effective-policy/{regionCode}`
- `GET /api/binary/author/moderation/model/status`
- `GET /api/binary/author/moderation/overview`
- `GET /api/binary/author/moderation/policies`
- `GET /api/binary/author/moderation/policy-templates`
- `GET /api/binary/author/moderation/region-groups`
- `GET /api/binary/author/moderation/regions`
- `GET /api/binary/author/moderation/runtime/status`
- `GET /api/binary/author/ops/backup`
- `GET /api/binary/author/ops/dangerous-operations/policy`
- `GET /api/binary/author/ops/fonts/activations`
- `GET /api/binary/author/ops/fonts/registry`
- `GET /api/binary/author/ops/fonts/registry/{fontId}`
- `GET /api/binary/author/ops/health`
- `GET /api/binary/author/ops/themes/activations`
- `GET /api/binary/author/ops/themes/activations/{scope}`
- `GET /api/binary/author/ops/themes/activations/{scope}/history`
- `GET /api/binary/author/ops/themes/registry`
- `GET /api/binary/author/ops/themes/registry/{themeId}`
- `GET /api/binary/author/plugins`
- `GET /api/binary/author/plugins/{pluginId}`
- `GET /api/binary/author/taxonomy/categories`
- `GET /api/binary/author/taxonomy/tags`
- `GET /api/binary/category`
- `GET /api/binary/category.aeds`
- `GET /api/binary/category/{id:int}.aeds`
- `GET /api/binary/comment/me`
- `GET /api/binary/comment/policy`
- `GET /api/binary/comment/{articleId:int}`
- `GET /api/binary/comment/{articleId:int}/children/{parentId:long}`
- `GET /api/binary/comment/{articleId:int}/context/{commentId:long}`
- `GET /api/binary/comment/{articleId:int}/thread/{rootId:long}`
- `GET /api/binary/locale-preference`
- `GET /api/binary/messages/conversations`
- `GET /api/binary/messages/conversations/{id:long}`
- `GET /api/binary/stats`
- `GET /api/binary/stats/recent-comments`
- `GET /api/binary/stats/regions`
- `GET /api/binary/system/admin/compliance`
- `GET /api/binary/system/admin/page/{slug}`
- `GET /api/binary/system/admin/seo`
- `GET /api/binary/system/compliance`
- `GET /api/binary/system/page/{slug}`
- `GET /api/binary/system/seo`
- `GET /api/binary/tag`
- `GET /api/binary/tag.aeds`
- `GET /api/binary/tag/by-name.aeds`
- `GET /api/binary/tag/{id:int}.aeds`
- `GET /api/binary/upload/{uploadId}/status`
- `GET /api/binary/upload/{uploadId}/status/parts`
- `POST /api/binary/admin/anonymous-governance/credentials/revoke`
- `POST /api/binary/admin/anonymous-governance/nullifiers/block`
- `POST /api/binary/admin/article`
- `POST /api/binary/admin/messages/conversations/{id:long}/reply`
- `POST /api/binary/admin/messages/conversations/{id:long}/status`
- `POST /api/binary/admin/messages/system-send`
- `POST /api/binary/admin/security/anti-crawler/allowlist`
- `POST /api/binary/admin/security/anti-crawler/blocklist`
- `POST /api/binary/admin/security/anti-crawler/crawler-ranges/sync`
- `POST /api/binary/admin/security/anti-crawler/options/rollback`
- `POST /api/binary/admin/security/anti-crawler/rules`
- `POST /api/binary/admin/security/anti-crawler/simulate`
- `POST /api/binary/admin/security/perception-v2/options/rollback`
- `POST /api/binary/admin/security/pow/options/rollback`
- `POST /api/binary/admin/security/pow/simulate`
- `POST /api/binary/admin/security/risk-control/options/rollback`
- `POST /api/binary/admin/security/risk-control/simulate`
- `POST /api/binary/admin/security/risk/{dimension}/reset`
- `POST /api/binary/anonymous-credential/blind-issue`
- `POST /api/binary/anonymous-credential/revocation-witness`
- `POST /api/binary/auth/admin/bootstrap/passkey/begin`
- `POST /api/binary/auth/admin/bootstrap/passkey/complete`
- `POST /api/binary/auth/admin/login/passkey/begin`
- `POST /api/binary/auth/admin/login/passkey/complete`
- `POST /api/binary/auth/admin/logout`
- `POST /api/binary/auth/admin/sessions/revoke-others`
- `POST /api/binary/auth/admin/sessions/{sessionId}/revoke`
- `POST /api/binary/auth/admin/step-up/passkey/begin`
- `POST /api/binary/auth/admin/step-up/passkey/complete`
- `POST /api/binary/auth/anonymous/bootstrap`
- `POST /api/binary/auth/delete-account`
- `POST /api/binary/auth/enrollment/cancel`
- `POST /api/binary/auth/enrollment/passkey/register/begin`
- `POST /api/binary/auth/enrollment/passkey/register/complete`
- `POST /api/binary/auth/logout`
- `POST /api/binary/auth/mfa/challenge`
- `POST /api/binary/auth/mfa/challenge/start`
- `POST /api/binary/auth/mfa/disable`
- `POST /api/binary/auth/mfa/recovery/regenerate`
- `POST /api/binary/auth/mfa/setup/start`
- `POST /api/binary/auth/mfa/setup/verify`
- `POST /api/binary/auth/passkey/login/begin`
- `POST /api/binary/auth/passkey/login/complete`
- `POST /api/binary/auth/passkey/register/begin`
- `POST /api/binary/auth/passkey/register/complete`
- `POST /api/binary/auth/recovery-key/create`
- `POST /api/binary/auth/recovery-key/passkey/register/begin`
- `POST /api/binary/auth/recovery-key/passkey/register/complete`
- `POST /api/binary/auth/recovery-key/rotate`
- `POST /api/binary/auth/recovery-key/verify`
- `POST /api/binary/auth/refresh-token`
- `POST /api/binary/auth/sessions/revoke-others`
- `POST /api/binary/auth/sessions/{id}/revoke`
- `POST /api/binary/auth/step-up/passkey/begin`
- `POST /api/binary/auth/step-up/passkey/complete`
- `POST /api/binary/author/ai-assist`
- `POST /api/binary/author/articles/import`
- `POST /api/binary/author/articles/{articleId:int}/assets/reindex`
- `POST /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/rollback`
- `POST /api/binary/author/cache/actions`
- `POST /api/binary/author/comments/moderation/anonymous-credentials/{credentialId:long}/revoke`
- `POST /api/binary/author/comments/moderation/bulk`
- `POST /api/binary/author/comments/moderation/nullifiers/block`
- `POST /api/binary/author/comments/{commentId:long}/moderation`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim/release`
- `POST /api/binary/author/comments/{commentId:long}/moderation/claim/renew`
- `POST /api/binary/author/drafts`
- `POST /api/binary/author/integrity/fix`
- `POST /api/binary/author/moderation/appeals/{appealId:long}/decision`
- `POST /api/binary/author/moderation/dictionaries/reload`
- `POST /api/binary/author/moderation/dictionaries/rollback`
- `POST /api/binary/author/moderation/dictionaries/{dictionaryId}/disable`
- `POST /api/binary/author/moderation/dictionaries/{dictionaryId}/enable`
- `POST /api/binary/author/moderation/effective-policy/preview`
- `POST /api/binary/author/moderation/model/reload`
- `POST /api/binary/author/moderation/model/rollback`
- `POST /api/binary/author/moderation/model/runtime`
- `POST /api/binary/author/moderation/replay/preview`
- `POST /api/binary/author/moderation/runtime/global-state`
- `POST /api/binary/author/moderation/runtime/region-state`
- `POST /api/binary/author/plugins/install`
- `POST /api/binary/author/plugins/{pluginId}/actions`
- `POST /api/binary/author/prepublish-check`
- `POST /api/binary/author/preview`
- `POST /api/binary/category`
- `POST /api/binary/comment`
- `POST /api/binary/comment/anonymous`
- `POST /api/binary/comment/anonymous-ticket`
- `POST /api/binary/comment/{id:long}/anonymous-report`
- `POST /api/binary/comment/{id:long}/author/appeal`
- `POST /api/binary/comment/{id:long}/author/challenge`
- `POST /api/binary/comment/{id:long}/author/delete`
- `POST /api/binary/comment/{id:long}/author/edit`
- `POST /api/binary/comment/{id:long}/management/appeal`
- `POST /api/binary/comment/{id:long}/management/challenge`
- `POST /api/binary/comment/{id:long}/management/delete`
- `POST /api/binary/comment/{id:long}/management/edit`
- `POST /api/binary/comment/{id:long}/management/status`
- `POST /api/binary/comment/{id:long}/report`
- `POST /api/binary/messages/conversations`
- `POST /api/binary/messages/conversations/{id:long}/read`
- `POST /api/binary/messages/conversations/{id:long}/reply`
- `POST /api/binary/read-proof/challenge.aeds`
- `POST /api/binary/read-proof/submit.aeds`
- `POST /api/binary/security/challenge`
- `POST /api/binary/security/challenge/cancel`
- `POST /api/binary/security/challenge/verify`
- `POST /api/binary/subscriptions`
- `POST /api/binary/system/page/refresh/{slug}`
- `POST /api/binary/tag`
- `POST /api/binary/telemetry/rum`
- `POST /api/binary/upload/init`
- `POST /api/binary/upload/{uploadId}/complete`
- `PUT /api/binary/admin/article/restore/{id:int}`
- `PUT /api/binary/admin/article/{id:int}`
- `PUT /api/binary/admin/security/anti-crawler/options`
- `PUT /api/binary/admin/security/anti-crawler/rules/{id}`
- `PUT /api/binary/admin/security/perception-v2/options`
- `PUT /api/binary/admin/security/pow/options`
- `PUT /api/binary/admin/security/risk-control/options`
- `PUT /api/binary/admin/users/status`
- `PUT /api/binary/auth/passkey/credentials/{id:int}/name`
- `PUT /api/binary/auth/public-handle`
- `PUT /api/binary/author/articles/{articleId:int}/revisions/{revisionId:long}/responsibility`
- `PUT /api/binary/author/moderation/anonymous-comment-policy`
- `PUT /api/binary/author/moderation/articles/{articleId:int}/comment-policy`
- `PUT /api/binary/author/moderation/articles/{articleId:int}/comment-threads/{rootId:long}`
- `PUT /api/binary/category/{id:int}`
- `PUT /api/binary/locale-preference`
- `PUT /api/binary/system/compliance`
- `PUT /api/binary/system/page`
- `PUT /api/binary/system/seo`
- `PUT /api/binary/tag/{id:int}`
- `PUT /api/binary/upload/{uploadId}/part`
<!-- FSUSBLOG-GENERATED:END api.operation-keys -->
