# Issue #1013 runtime fallback retirement handoff

The six #1013 production retirements were already present when this issue pass began.
This pass audited the current shared workspace, found no legitimate production-code
gap, and therefore did not rewrite dirty files owned by other issues. It adds one
issue-level acceptance owner, six independent release notes, and explicit milestone
evidence that does not claim unexecuted production checks.

## Audited state

| item | current production state | primary existing evidence |
| --- | --- | --- |
| A3-1 | legacy upload-session root sweep absent; expiration-bucket cleanup only | `FileServiceTests.UploadSessionCleanup_SourceUsesExpirationBucketIndex` |
| A3-2 | HMAC-only runtime; one-time finalize migration quarantines legacy rows and asserts count zero | `SchemaMigrationIntegrationTests.RunAsync_FinalizesLegacySiteSubscriptionHashes` |
| A3-3 | all three article readers use `article_body` / `ArticleBody.MarkdownContent` | `ArticleServiceValidationTests.ArticleService_SourceDoesNotQueryLegacyArticleContentColumn` |
| A3-4 | legacy plain-cookie switch cannot alter reads; production accepts only current host-prefixed names | `AuthCookieServiceSecurityTests.ReadTokenCookies_DevelopmentRejectsLegacyPlainCookieFallback` |
| A3-7 | canonical lowercase-hex SHA-256 only; legacy Base64Url entry is a miss | `PublicAotFileShellCacheTests.TryGetEntryAsync_LegacyBase64UrlHydrationSidecarHash_TreatsDocumentAsMiss` |
| A3-8 | cleanup runs as `ClearLegacyPublicArtifactsStep`; manual admin action absent | `SchemaMigrationRegistryTests.GetDescriptors_ClearLegacyPublicArtifacts_RunsAsOneTimeMigrationStep` |

`RuntimeFallbackRetirementAcceptanceTests` provides one stable #1013 owner across
these otherwise distributed suites. It also asserts that the issue milestone manifest
keeps external evidence in `deferred-unverified` state until the unified validation
and release-observation phase supplies real run ids and counts.

## Independent release notes

- [A3-1 upload cleanup](releases/issue-1013-a3-1-upload-session-root-sweep.md)
- [A3-2 subscription HMAC](releases/issue-1013-a3-2-subscription-hmac-cutover.md)
- [A3-3 article content](releases/issue-1013-a3-3-article-content-finalize.md)
- [A3-4 cookie read](releases/issue-1013-a3-4-plain-cookie-read.md)
- [A3-7 AOT sidecar hash](releases/issue-1013-a3-7-aot-sidecar-hash.md)
- [A3-8 artifact clear migration](releases/issue-1013-a3-8-artifact-clear-migration.md)

The GitHub issue requests one PR per subitem. The active instruction explicitly
forbids Git and GitHub writes, so this implementation pass cannot create those PRs or
claim that delivery condition. The files remain separable by release-note/evidence
id for a later authorized publish phase.

## External milestone evidence still required

- A3-1: one served release cycle plus a read-only legacy-root scan count of zero.
- A3-2: applied migration history plus exact legacy row count zero.
- A3-3: content-finalize history snapshot from every environment.
- A3-4: local configuration and browser-session dependency survey.
- A3-7: complete AOT rebuild evidence plus legacy sidecar count zero.
- A3-8: successful one-time migration history and cleanup result.

The machine-readable placeholders are in
`tests/backend/issue-1013-runtime-fallback-milestones.json`. Null counts and null run
ids are intentional; replacing them requires actual external evidence, not a source
assertion.

## Dirty/shared files deliberately not edited

- `src/backend/Services/FileService.cs` belonged to concurrent storage work.
- `src/backend/Infrastructure/Auth/AuthCookieService.cs` and auth/bootstrap paths had
  concurrent session/identity work.
- `src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs` had a
  concurrent migration descriptor addition.
- `src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs`
  had concurrent artifact behavior work.
- production/deployment/operations/security/API documentation and release evidence
  were held by #1027/#1031 and other active threads.
- the four central test-governance files remain locked by the main thread.

## Risk and no-restart degradation

- Upload cleanup: pause the worker and repair an exact orphan/index; never restore a
  full root sweep.
- Subscription: pause subscription mutations and diagnose an isolated restore;
  never restore SHA-256 runtime lookup.
- Article content: keep an unmigrated environment out of traffic; apply the supported
  finalizer instead of probing schema at runtime.
- Cookie: clear stale cookies and reauthenticate; local HTTP uses only the current
  insecure-transport switch.
- PublicAOT: invalidate/rebuild and serve cache misses while converging; never accept
  the legacy hash.
- ArticleDetail artifacts: use rights recompute and V3 rebuild; never recreate the
  retired manual clear action.

## Validation status

No test, build, lint, restore, syntax, profile, Playwright, migration, AOT rebuild,
production query, or release-cycle observation was executed in this implementation
phase. All pass/fail and milestone claims remain deferred to unified validation.
