# C++ POD Alignment Checklist (Milestone 2)

This checklist is the counterpart for the external C++/Wasm side.
All C# PODs are defined with `[StructLayout(LayoutKind.Sequential, Pack = 1)]`.

## 1. Primitive Mapping Rules

- `int` -> `std::int32_t`
- `long` (C# Int64) -> `std::int64_t`
- `byte` -> `std::uint8_t`
- `ushort` -> `std::uint16_t`
- `Utf8Fixed32/64/128/256/512` -> `std::uint8_t value[N]`
- `Utf8SliceRef { int Offset; int Length; }` ->

```cpp
struct Utf8SliceRef {
  std::int32_t Offset;
  std::int32_t Length;
};
```

## 2. Envelope Contract

- `PodEnvelopeHeader { Version, Count, PayloadLength, Reserved }`
- `PageEnvelope { Total, Count }`
- `CursorEnvelope { NextCursor, HasMore, Reserved0, Reserved1, Reserved2 }`
- list responses use: `Header + Item[] + PayloadBlob`

## 3. Size Source Of Truth

Use `FsusBlog.Shared.Contracts.Validation.PodSizeCatalog` values as authoritative byte sizes.

- primitives: `Utf8Fixed*`, `Utf8SliceRef`
- envelopes: `PodEnvelopeHeader`, `PageEnvelope`, `CursorEnvelope`, `PagedPodEnvelope`, `CursorPodEnvelope`
- article: `ArticleListItemPod`, legacy `ArticleDetailPod`, `ArticleDetailV3HeaderPod`, `ArticleDetailV3RecordPod`, `ArticleDetailTagV3RecordPod`, `ArticleRightsV3RecordPod`, `TagPod`, `TagWithCountPod`, `CategoryPod`, `ArticleNoticePod`, `ArticleMutationResponsePod`, `TrashClearResponsePod`
- comment: `CommentItemPod`, `UserCommentPod`
- message: `MessageInboxPod`, `CommentPushPod`, `CommentAddedNotifyPod`, `GlobalNoticePayloadPod`, `MessageRevokedPayloadPod`, `AccountStatusPayloadPod`, `NoticePayloadPod`, `CommentRemovedPayloadPod`
- user/auth: `TokenResponsePod`, `LoginResponsePod`, `UserListItemPod` (anonymous account list row)
- system: `SeoConfigPod`, `PageContentPod`
- stats: `PopularArticlePod`, `RecentCommentPod`, `RegionDistributionPod`, `SiteStatsPod`
- file/pow: `FileUploadOutputPod`, `PowChallengePod`

## 4. Balanced String Budget

- author display snapshot: `Utf8SliceRef` payload or explicit `AuthorDisplayName` slot only
- role: 32
- id/category/action/salt/signature short ids: 64 or 128
- title/article title: 256
- category/tag/region: 128
- URL/base URL/og image: 256
- token: 512
- long texts (`content`, `summary`, `snippet`, `reason`, markdown body): `Utf8SliceRef` in payload blob

## 5. Compatibility Notes

- `DateTime` is always encoded as Unix epoch milliseconds (`std::int64_t`).
- nullable values are encoded as `Value + HasValue(std::uint8_t)`.
- no reference types exist in POD structs; `PodContractValidation.AreAllPodModelsReferenceFree()` must remain `true`.
