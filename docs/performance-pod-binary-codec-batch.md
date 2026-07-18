# PodBinaryCodec batch allocation evidence

Issue #1154 audits temporary collections inside batch codecs. It does not change AEDS v2 framing, ArticlePage cursor compatibility, ARD3/ARD4 decoding, fixed-width POD layouts, or any C++/TypeScript alignment contract.

## Selected changes

`WriteArticlePage` now performs a strict UTF-8 sizing pass and writes the blob directly to the final `IBufferWriter<byte>`. Packed slice metadata uses a 4 KiB scratch policy:

- small pages use `stackalloc`;
- larger pages rent `ArticlePageItemSlicePlan[]` and `Utf8SliceRef[]` from `ArrayPool`;
- both rents are inside one `try/finally`, including the second-rent failure path;
- scratch contains public immutable offsets and lengths, not string or byte contents, so return does not request clearing;
- collection or UTF-8 length drift fails instead of emitting an internally inconsistent payload.

`WriteArticleDetail` uses a measured adaptive boundary. Content below 8,192 characters keeps the original List path; at and above that boundary it preplans article, tag, and rights slices, writes the fixed records, then emits UTF-8 bytes directly to the final destination. The selected medium/large path removes the intermediate blob and tag-record Lists while preserving the ARD4 byte sequence.

`PodUtf8Codec` exposes internal strict helpers for byte counting, validated slice creation, and direct destination writes. These helpers use exception fallback and reject invalid UTF-16 before ArticlePage mutates its destination.

## Candidate and audit coverage

The profiler compares five ArticlePage implementations over the full matrix:

```text
items:       0, 1, 10, 50, 100
tags/item:   0, 2, 8
text length: short, medium, long
UTF-8 class: ASCII, CJK, mixed
total:       135 scenarios
```

Candidates are the baseline Lists, exact-capacity Lists, direct encoding with recomputed offsets, forced pooled record buffers, and the selected adaptive stack/pool implementation. Every candidate must produce the baseline bytes before it is measured.

ArticleDetail covers short, 27,000-byte CJK, and 131,072-byte ASCII content. The baseline-only audit also measures CommentCursor short/long content, UserCommentCursor, root/reply cursors, ConversationDetail/List, SiteStats, CategoryList, and TagWithCountList. Those codecs remain unchanged because this issue does not have candidate-specific threshold evidence for them.

## Local before/after evidence

The focused local run used the same Release benchmark process, rotating candidate order, `GC.GetAllocatedBytesForCurrentThread`, and retained per-round latency samples. The raw file is intentionally run-bound and ignored at `.tmp/perf/pod-binary-codec-batch/summary.json`.

Representative results from that run:

| Scenario | Variant | Allocation/frame | Allocation/item | p95 | Extra blob copy |
|---|---:|---:|---:|---:|---:|
| ArticleList 100, 8 tags, mixed long | legacy Lists | 2,156,130 B | 21,561 B | 9.0867 ms | 427,920 B |
| ArticleList 100, 8 tags, mixed long | adaptive stack/pool | 455,262 B | 4,552 B | 2.2874 ms | 0 B |
| ArticleList 1, 2 tags, mixed short | legacy Lists | 1,416 B | 1,416 B | 0.0136 ms | blob length |
| ArticleList 1, 2 tags, mixed short | adaptive stack/pool | 408 B | 408 B | 0.0095 ms | 0 B |
| ArticleDetail, 27,000-byte CJK | legacy Lists | 118,224 B | 118,224 B | 0.2303 ms | content/blob |
| ArticleDetail, 27,000-byte CJK | adaptive direct | 27,912 B | 27,912 B | 0.1056 ms | 0 B |
| ArticleDetail, 131,072-byte ASCII | legacy Lists | 526,304 B | 526,304 B | 0.8593 ms | content/blob |
| ArticleDetail, 131,072-byte ASCII | adaptive direct | 132,488 B | 132,488 B | 0.4289 ms | 0 B |

The complete matrix recorded allocation wins in all 54 representative 50/100-item scenarios. In the final five-round run, 53 of 54 empty/single-item scenarios kept adaptive p95 within the policy band, exceeding the 70% small-page rule. The tiny-operation band accepts either at most 10% relative regression or at most 0.002 ms absolute movement, matching the scale where percentage-only comparisons become misleading. Both representative ArticleDetail scenarios exceeded the 20% allocation reduction threshold. A first unconditional five-round run exposed a tiny-detail regression, so the implementation retains the measured legacy path below 8,192 content characters and selects direct writing only for medium/large content. The adaptive tiny case finished with identical allocation (1,264 B) and 0.0037/0.0038 ms baseline/candidate p95.

These are local codec encode measurements, not production traffic measurements. The affected path is cache miss and background rebuild serialization. Runtime frequency should be correlated through `fsus.cache.owned_frame.build.count`; no cache-hit QPS improvement is claimed.

## Reproduction and gate

```bash
dotnet build benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release --no-restore
dotnet run --project benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release --no-build -- \
  --pod-binary-codec-batch-profile \
  --iterations 10 \
  --warmup-iterations 2 \
  --rounds 5 \
  --out .tmp/perf/pod-binary-codec-batch/summary.json
node tools/operations/check-pod-binary-codec-batch-evidence.mjs \
  .tmp/perf/pod-binary-codec-batch/summary.json
```

The checker rejects incomplete matrix cells, byte drift, missing raw rounds, inconsistent field-derived recommendations, intermediate-copy regression, missing audit families, and any cache-hit performance claim.

Focused correctness coverage includes byte-for-byte differential tests, deterministic randomized UTF-8 distributions, 0/1/100 item boundaries, 0/2/8 tag boundaries, strict UTF-8 failure before mutation, concurrent encoding, destination exceptions, and both first/second pool-rent cleanup paths.
