# C++ POD Alignment Checklist (Milestone 2)

This checklist covers the external C++/Wasm side. All C# PODs use `[StructLayout(LayoutKind.Sequential, Pack = 1)]`.

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

Use `FsusBlog.Shared.Contracts.Validation.PodSizeCatalog` as the authoritative byte-size source for primitives (`Utf8Fixed*`, `Utf8SliceRef`); envelopes (`PodEnvelopeHeader`, `PageEnvelope`, `CursorEnvelope`, `PagedPodEnvelope`, `CursorPodEnvelope`); article types (`ArticleListItemPod`, legacy `ArticleDetailPod`, `ArticleDetailV3HeaderPod`, 84-byte `ArticleDetailV3RecordPod`, `ArticleDetailV4HeaderPod`, 92-byte `ArticleDetailV4RecordPod`, 116-byte `ArticleDetailV5RecordPod`, `ArticleDetailTagV3RecordPod`, `ArticleRightsV3RecordPod`, `TagPod`, `TagWithCountPod`, `CategoryPod`, `ArticleNoticePod`, `ArticleMutationResultPod`, `TrashClearResponsePod`); comment types (`CommentItemPod`, `UserCommentPod`); message types (`MessageInboxPod`, `CommentPushPod`, `CommentAddedNotifyPod`, `GlobalNoticePayloadPod`, `MessageRevokedPayloadPod`, `AccountStatusPayloadPod`, `NoticePayloadPod`, `CommentRemovedPayloadPod`); user/auth types (`TokenResponsePod`, `LoginResponsePod`, `UserListItemPod` for the anonymous account list row); system types (`SeoConfigPod`, `PageContentPod`); stats types (`PopularArticlePod`, `RecentCommentPod`, `RegionDistributionPod`, `SiteStatsPod`); and file/PoW types (`FileUploadOutputPod`, `PowChallengePod`).

## 4. Balanced String Budget

Font/Theme administration uses the packed declarations and per-field offset assertions in
`src/frontend/wasm/aeds/include/font_theme_admin_pods.hpp`. Shared `PodSizeCatalog` sizes are
16 bytes for `FontThemePayloadHeaderPod`, 76/100 for Font registry item/detail, 56 for a
Font face, 64 for Font activation, 84/148 for Theme registry item/detail, 64 for Theme
activation, and 124 for a Theme activation history row. The C++ parser borrows the input
payload; it validates the complete closed layout before returning any view. Nullable
fields require a canonical 0/1 presence byte and zero absent storage, reserved bytes are
zero, and UTF-8 slices are contiguous in field order with no unused blob bytes.

Nonnegative byte sizes, configuration versions, and 64-bit Theme budgets keep their full
signed Int64 wire range. TypeScript exposes these values as decimal strings, not rounded
JavaScript numbers. Unix-millisecond timestamps use the DateTimeOffset calendar range;
activation GUID text is the writer's lowercase `D` representation in all three decoders.

Use only a `Utf8SliceRef` payload or explicit `AuthorDisplayName` slot for an author display snapshot; allocate 32 bytes for role, 64 or 128 for id/category/action/salt/signature short IDs, 256 for title/article title, 128 for category/tag/region, 256 for URL/base URL/OG image, 512 for token, and `Utf8SliceRef` in the payload blob for long texts (`content`, `summary`, `snippet`, `reason`, markdown body`).

## 5. Compatibility Notes

`DateTime` is always encoded as Unix epoch milliseconds (`std::int64_t`); nullable values use `Value + HasValue(std::uint8_t)`; and POD structs contain no reference types, so `PodContractValidation.AreAllPodModelsReferenceFree()` must remain `true`. `ArticleDetail` writers emit `ARD5`/version 5 with a 116-byte record containing `updatedAtUnixMs` and exact revision/publication coordinates. C++, TypeScript, and C# decoders must also accept `ARD4`/version 4 (92 bytes) and `ARD3`/version 3 (84 bytes) in read-only compatibility mode and expose absent fields as null/zero; mismatched magic/version pairs, truncation, out-of-range slices, and trailing bytes are rejected.
