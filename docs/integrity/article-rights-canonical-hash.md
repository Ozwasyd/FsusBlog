# Article Rights Canonical Hash

`ArticleRightsCanonicalHashV1` defines the deterministic Rights V3 policy digest used to bind an article revision, a frozen rights policy snapshot, and the article content canonical hash. It is a local canonicalization contract only; it is not legal advice, not a license grant by itself, and not proof that the database or artifacts can never be changed.

The Rights V3 canonical hash is the stable bridge between the frozen rights policy snapshot and the content canonical hash carried by ArticleDetail AEDS V3, PublicAOT hydration, and the article rights proof.

## Domain

- Domain separator: `fsusblog.rights.article-policy.v1`
- Version: `hashVersion:i:1`
- Digest format: `sha256:<64 lowercase hex>`
- Encoding: UTF-8
- Unicode: NFC
- Newlines: LF

`ArticleRightsCanonicalHashV1.ComputeHashHex` returns the full prefixed digest. Input content hashes may be supplied either as bare 64-character hex or as `sha256:<hex>`; the canonical payload always writes the lowercase prefixed form.

## Field Order

Fields are written in this exact order, one LF-terminated line each:

```text
fsusblog.rights.article-policy.v1
hashVersion:i:1
articleId:i:<invariant decimal>
articleRevisionId:i:<invariant decimal>
revisionNo:i:<invariant decimal>
licenseType:s:<base64-utf8-nfc-lf>
copyrightHolder:n|s:<base64-utf8-nfc-lf>
copyrightYear:n|i:<invariant decimal>
rightsStatement:n|s:<base64-utf8-nfc-lf>
attributionTemplate:n|s:<base64-utf8-nfc-lf>
copyPolicy:s:<base64-utf8-nfc-lf>
maxExcerptChars:i:<invariant decimal>
allowCodeCopy:b:0|1
showPublicBadge:b:0|1
canonicalUrl:n|s:<base64-utf8-nfc-lf>
contentCanonicalHash:h:sha256:<64 lowercase hex>
```

String null and empty string are intentionally distinct: null is `n`, while empty string is `s:`. This lets future policy distinguish an unset holder from an explicitly empty holder without changing the digest contract.

## Attribution Rendering

`ArticleRightsAttributionTemplateRenderer` renders the frozen template during write/publish work or artifact rebuild work. Public reads should consume the already-rendered artifact payload and must not query rights tables to render attribution.

Supported tokens:

- `{title}`
- `{url}`
- `{holder}`
- `{year}`
- `{license}`
- `{proof}`

Unknown tokens are preserved verbatim, and malformed trailing text such as `{title` is preserved rather than throwing. Empty holder, URL, year, or proof values render as empty text. Rendering is deliberately small and local; it does not parse Markdown, HTML, legal terms, or external license registries.

## Exclusions

The rights hash excludes mutable read-path and operational state:

- article views, comments, messages, sessions, audit rows, telemetry, risk signals, and notification state;
- PublicAOT, PublicHotRead, search, feed, sitemap, and cache runtime versions;
- admin principal identity and private draft state;
- database row timestamps except the article revision coordinate already represented by `articleRevisionId` and `revisionNo`;
- legal interpretation, external registry state, wallet identity, IPFS, Arweave, blockchain anchoring, and third-party timestamping.

The hash can show that a specific Rights V3 policy snapshot and content canonical hash were used by FsusBlog's proof pipeline. It does not prove the policy is legally sufficient, that the author owns the work, that backups exist, or that PostgreSQL, Redis, artifacts, or operators can never be compromised.
