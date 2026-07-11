# A3-3 Article content-column fallback retirement

Status: code landed; all-environment migration evidence deferred.

## Change

`ArticleService`, `PublicHotArtifactProjector`, and
`ArticleDetailAedsArtifactStore` read article content only from `article_body` /
`ArticleBody.MarkdownContent`. Their legacy column state caches, schema-probe methods,
`COALESCE(..., a.content)` branches, and `a.content` grouping terms are absent.

## Release gate

Every target database must contain a successful
`20260418-post-content-cleanup` history record before traffic uses this build. Store
one protected history snapshot per environment in release evidence; do not infer
application from a release tag. Those live snapshots were not collected in this
implementation phase.

## Operational fallback

Do not add a runtime schema probe or read fallback. If an environment missed the
finalizer, keep it out of traffic, apply the supported migration path, and verify
`article_body` completeness. Roll back only as a matched previous image/database
pair from backup.

## Test ownership

- `ArticleServiceValidationTests.ArticleService_SourceDoesNotQueryLegacyArticleContentColumn`
- `RuntimeFallbackRetirementAcceptanceTests.A3_3_ArticleReadersHaveNoLegacyContentColumnFallback`

