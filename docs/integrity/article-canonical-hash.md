# Article Canonical Hash

`ArticleCanonicalHashV1` defines the first local integrity payload for public article content. It is a deterministic content digest contract only; it does not publish to IPFS, Arweave, a chain, or any external anchoring service.

## Scope

The canonical hash proves one public article content version as represented by:

- `Article.Id`
- optional `ArticleRevision.Id`
- optional `RevisionNo`
- public route identity (`publicRouteKey`, for example `article:42`)
- `Title`
- `Summary`
- `CoverImageUrl`
- `CategoryId`
- `TagIds`
- `Status`
- `PublishedAt`
- `ScheduledPublishAt`
- Markdown content from `ArticleBody.MarkdownContent` or `ArticleRevision.MarkdownContent`

Current published article payloads may bind only `Article.Id` plus current `ArticleBody.MarkdownContent` when no revision exists. Revision payloads must bind `ArticleRevision.Id`, `Article.Id`, and `RevisionNo` together; callers must not invent a separate abstract revision identifier.

## Canonical Rules

- Domain separator: `fsusblog.integrity.article-canonical.v1`
- `hashVersion`: `1`
- Hash algorithm: `sha256`
- Encoding: UTF-8
- Text normalization: Unicode NFC
- Newlines: LF only
- Field order: fixed by `ArticleCanonicalHashV1.BuildPayloadBytes`
- String fields: `n` for `null`, `s:` plus Base64 UTF-8 for present strings; empty string is `s:`
- Time fields: UTC ISO format with seven fractional digits and `Z`
- Tags: positive tag ids are treated as a set, de-duplicated and sorted ascending

## Exclusions

The payload intentionally excludes:

- `Views`
- runtime cache versions
- PublicHotRead or AOT artifact versions
- viewer, session, IP, user agent, request context, and trace context
- comments, private messages, audit logs, moderation records, and user private data
- `CreatedByAdminPrincipalId` as a public identity field

If a future proof needs author or operator binding, it must use a site signature or a separately documented privacy-preserving field, not expose raw admin principal ids.

## Limits

This hash only proves that the same canonical input produces the same digest. It does not prove the database was never compromised, does not prove user privacy or comment compliance, and does not replace authorization, audit, backup, or moderation controls.
