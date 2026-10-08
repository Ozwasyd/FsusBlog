# Selected article revalidation handoff

Published DTO/reservation source: `bb109c208764cc00f96d3087d97bd911add70ff3`, branch `codex/chain-3735-20261008`, draft PR [#3839](https://github.com/Ozwasyd/FsusBlog/pull/3839). This is source progress; no route, codec or runtime admission is claimed.

The Shared request contains version, article ID, Int64 server revision, request UUID and permission token. It has no caller owner. The response carries the authenticated facade's nested owner and correlation fields. A stale observation has `Current=false` and a null permission token. Int64 values must remain decimal strings in the future frontend binding. Shared validation checks shape/correlation only; it is not authorization. Request `276` and response `277` are inert manifest reservations; active frames remain 267, maximum 275, and all five generated products are unchanged.

The supplied source `d36532bcda55d42ab90f35c88ae460237b2156b5` does not compile against the current branch alone. The following canonical production files are absent and need explicit parent supply with acceptance evidence:

| Exact final d365 path | Git blob | SHA-256 |
|---|---|---|
| `src/shared/Contracts/Articles/AuthorArticleQueryContracts.cs` | `8fa0c13c8b75c223ce8dfde8c0c274fb6141ebcc` | `1cdfb38d689e1f38211fcf53ef67eb90d155ac0fc7cfdc5189be6f5b15def693` |
| `src/backend/Services/Authoring/AuthorArticleQuerySourceInspection.cs` | `fb05d7725fddd0661ea60f0556eacc5af08891ea` | `6a7806c2ddfb4f18c2e423329c45cc78bd4c475b231a8c2f8b33c9784353d061` |
| `src/backend/Services/ArticleService.AuthorArticleQuerySource.cs` | `23e59a40f876137a6c545e55e3ca7c4d2ee12e1c` | `b9b4f4c2df86517ee19603a468e46ad7c12c348a85e6c7d1b0d66dd5110e5074` |
| `src/backend/Services/Authoring/AuthorArticleQuerySelectionRevalidator.cs` | `fb30409d4e75ee36d81d0e5abdd88a1dc84e932f` | `15eccbe579c02b293f802696a1ccaa2446a0fab90be0adc0c84e4cbf58c156ed` |

Also required: the additive `RevalidateSelectionAsync` facade interface/constructor/forwarding hunks and canonical `IAuthorArticleQuerySourceReader` → existing `ArticleService` scoped DI. The current facade matches the supplied parent preimage exactly; existing history contracts and permission authority match final d365 bytes. Do not replace the whole DI or integration fixture, consume guessed ancestors, create a second source/query owner, or import ranking/cursor/history identity dependencies for selected-ID revalidation.

The real producer brackets two identical source-coordinate reads with three permission observations and honors cancellation. Its result is `Current`, authenticated `Owner`, `ArticleId`, `ServerRevision`, `RequestId`, nullable `PermissionToken`. Scope is at most 128 characters; the token is 64 lowercase hex characters. Deleted/archived, changed revision/xmin, revoked or changed permission must refuse. Actual source-bound unit and isolated PostgreSQL evidence is requested from the canonical owner, with original fixture hunks and current/stale/revoked/deleted/archived/mid-read/cancel/repeat controls preserved. Cached ancestry is provenance only.

After the real closure is supplied and verified, continue the existing authenticated AEDS route and bounded managed/native/TypeScript codec binding. No ranked query, slug, document epoch, portable identity or navigation admission is inferred from this handoff. Complete chain acceptance remains open; withdrawn independent QA has not been recreated.

Local source review: `.tmp/chain-3735/navigation-revalidation-closure/review.json`. Exact build, tests, commands, exits and input/DLL binding are under `.tmp/chain-3735/navigation-contract-canonical/`, summarized in [source-frontier-20261008.json](source-frontier-20261008.json).
