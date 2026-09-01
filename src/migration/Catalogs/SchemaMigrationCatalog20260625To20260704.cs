using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;

namespace FsusBlog.Migration.Catalogs;

internal static class SchemaMigrationCatalog20260625To20260704
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "projection-integrity-20260625-20260704",
            StartVersion: new DateOnly(2026, 6, 25),
            EndVersion: new DateOnly(2026, 7, 4),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260621-pre-sys-user-security-profile-split",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    "20260621-post-visit-log-ip-anonymization",
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                SecurityAndProjectionMigrationDefinitions.BuildAdminAccountListKeysetIndexMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildArticleRevisionAtomicRevisionNoMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSecurityPolicyVersionCounterMigration(),
                LegacyIdentityMigrationDefinitions.BuildUserSessionActiveUniqueMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentBlockedRegionLookupMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildPublicArticleListKeysetIndexMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildArticleViewProjectionWatermarkMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAssetLibraryArticleRefMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAuditLogChainTailIndexMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAuthorAnalyticsRollupMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentModerationSignalLatestIndexMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildTaxonomyCountProjectionMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildVisitLogStatsRollupMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildArticlePublishProofMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildArticleRightsV3SchemaMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildIntegrityMerkleCheckpointMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildIntegrityTransparencyLogMigration()
            ]);
}
