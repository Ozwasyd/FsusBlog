# Embed source adapter capability handoff

A complete `ArticleEmbedTargetFacts` adapter is blocked by real producer capabilities. The canonical authorized reader already supplies a usable partial: numeric article reads in the admin/primary-site scope, immutable bounded Markdown bytes, real revision ID/no, SHA digest, revision metadata and current-head rechecks. No new unavailable-only adapter was added.

Reviewed source: FsusBlog `54f1c0ab4d3adfd6caf0b92a6d7d2b5309732a38`; FsusUI `f2b3bb89ffe5f749da26c388f058efdbb6aee864`; supplied Embed consumer `1194ee45037862aa30803650ec2a622700631224` on `codex/chain-2458-embed`. Consumer objects were read only; its whole branch was not consumed. All recorded source hashes and both local HEADs remained unchanged.

## Existing usable APIs

- `IArticleCoreService.GetByIdAsync` and `ArticleService.cs:319,383–446` return actual revision/publication coordinates and canonical Markdown. **`includePrivate=true` does not itself authorize actor/site**; this must stay behind a genuine authorized caller.
- `AuthoringRevisionComparePackageReader.cs:366–407,425,529–581` checks primary site, active admin and ArticleWrite before reading. Its immutable revision package has actual bounded UTF8 bytes/digest and current-head rechecks. The lower draft/revision lifecycle readers do not independently replace that authorization.
- `AuthoringCanvasReferenceFactSource.cs:405–489,515–537` supplies actual principal/content xmin generations, permission fingerprints, per-article read checks and before/after authority checks. This is a numeric-ID admin/primary-site Canvas scope, not a general portable target authority.
- `ArticleService.ArticleVaultObservation.cs:32–63` consumes a portable/server pair already supplied by a sealed vault plan. It is not a global portable identity resolver.

## Missing real producers

Portable article/site resolution and a coherent actor/site/lifecycle/permission/generation envelope remain necessary. No Server integer-to-UUID mapping, invented generation or vault input pair may substitute for them.

Body/heading/block projection references, stable selected-range identities and typed nested dependency facts need an actual same-runtime FsMarkdown/FsUI production bridge over the immutable source. The existing ATX/setext structure helper and narrow Canvas coordinate reader do not supply those facts. FsUI defines `IFsusMarkdownProjectionProducer.ProduceAsync` and validates source/document/revision bindings, but no production implementation was found in FsusBlog; its .NET native binding packaging is documented as not shipped. The consumer sample constructs smoke spans and cannot qualify the producer. Missing parser output must not be converted to an empty dependency list.

The supplied consumer already owns `ArticleEmbedDependencyReceipt` at `ArticleEmbedRelationContracts.cs:99`; that type path is **not** a blocker. Its exact planner guard is `target.Kind != ArticleEmbedTargetKind.Article && facts.NestedDirectives.Count != 0`, returning `projection_dependencies_unbound`. It rejects heading/block projection use of nonempty whole-article dependencies, not Article-kind targets. Selected ranges require real scoped facts or authoritative none; no consumer Graph changes were made.

## Executed evidence

Actual Node `v24.19.0` execution of exported FsUI implementation functions from exact f2 source passed five controls, exit 0: UTF16 grammar ranges, invalid-mode refusal, opaque target preservation, raw lexical collector behavior, and stale revision/epoch result refusal. The lexical collector includes a directive inside fenced source; this observation is **not** a full-parser bug claim or proof of context-scoped dependencies. The probe is not packed public-entry, native bridge or canonical Server runtime qualification.

Files: `review.json` contains the field-by-field API mapping and owner requests; `source-binding.json` contains 19 Blog, 10 FsUI and five supplied consumer source hashes; `fsusui-runtime-api-probe.json` contains the real executed observations. No source edits/builds/PG/HTTP/UI acceptance were performed.

## Smallest handoffs

1. Root #2246 / #1807/#2440 identity owners: exact callable portable/site and stable anchor resolver source, full SHA/branch and current acceptance evidence.
2. FsUI #289/#290 producer owner: actual source-bound production bridge with selected heading/block ranges and typed nested dependencies or authoritative none.
3. Canonical ArticleService/author-read owner: genuine coherent actor/site/revision/lifecycle/permission/generation snapshot and revalidation scope over that mapping. Existing authorized raw source and Canvas checks are reusable partials.
4. Exact Embed consumer owner: confirm the selected-range dependency producer handoff. The full source SHA and sole DependencyReceipt declaration are supplied and no longer blockers.
