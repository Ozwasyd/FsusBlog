# A3-8 Legacy public-artifact clear migration

Status: code landed; production migration-history evidence deferred.

## Change

Legacy ArticleDetail AEDS cleanup is the non-transactional one-time descriptor
`20260709-post-clear-legacy-public-artifacts`. `SchemaMigrationRunner` dispatches its
`ClearLegacyPublicArtifactsStep` through
`IArticleDetailAedsArtifactMaintenanceService`. The admin cache-action switch no
longer exposes `clear-legacy-public-artifacts`; it retains only current recompute and
ArticleDetail AEDS V3 rebuild actions.

## Release gate

Capture the successful migration-history record and the cleanup result before
reporting the manual action retired for a production environment. The current phase
did not run the migration or inspect production artifacts.

## Operational fallback

The cleanup is intentionally one-time and non-compensable. Do not recreate the
manual legacy-clear action. If current artifacts are missing, run the supported
rights recompute and `rebuild-article-detail-aeds-v3` actions; PublicAOT can remain a
cache miss while rebuilding. Restore a backed-up artifact set only with its matching
image/database pair.

## Test ownership

- `SchemaMigrationRegistryTests.GetDescriptors_ClearLegacyPublicArtifacts_RunsAsOneTimeMigrationStep`
- `PublicContentInvalidationFlowTests.AdminCacheAction_ExposesOnlyRuntimeArticleDetailAedsV3Actions`
- `RuntimeFallbackRetirementAcceptanceTests.A3_8_LegacyArtifactClearIsOneTimeMigrationNotAdminRuntimeAction`

