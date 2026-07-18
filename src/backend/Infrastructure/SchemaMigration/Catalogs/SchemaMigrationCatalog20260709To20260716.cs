using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260709To20260716
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "current-20260709-20260716",
            StartVersion: new DateOnly(2026, 7, 9),
            EndVersion: new DateOnly(2026, 7, 16),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260629-pre-admin-account-list-keyset-indexes",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    "20260704-post-integrity-transparency-log",
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                LegacyIdentityMigrationDefinitions.BuildAccountSubjectHashExpandMigration(),
                LegacyIdentityMigrationDefinitions.BuildReadEventRetirementCompatMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildVisitLogIpPseudonymEpochCompatMigration(),
                AnonymousEligibilityPredicateMigrationDefinitions.BuildAnonymousEligibilityPredicatePreCodeFirstMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildClearLegacyPublicArtifactsMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildSiteSubscriptionHmacFinalizeMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAccountSubjectHashBackfillMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildRecoveryPasskeyCompletionIdempotencyMigration(),
                LegacyIdentityMigrationDefinitions.BuildPublicArticleProjectionMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildActiveReleaseFenceDurableWitnessMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildActiveReleaseFencedCommitLedgerMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildArticleMutationOutboxClaimLeaseMigration(),
                AnonymousPrivacyMigrationDefinitions.BuildBlindCredentialIssuancePrivacyMigration(),
                LegacyIdentityMigrationDefinitions.BuildReadEventRetirementMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSecurityRiskPseudonymEpochMigration(),
                AnonymousEligibilityPredicateMigrationDefinitions.BuildAnonymousEligibilityPredicateMigration(),
                CommentAuthorModeRetirementMigrationDefinitions.BuildCommentAuthorModeRetirementMigration()
            ]);
}
