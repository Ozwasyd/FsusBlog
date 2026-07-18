using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260602To20260621
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "identity-security-20260602-20260621",
            StartVersion: new DateOnly(2026, 6, 2),
            EndVersion: new DateOnly(2026, 6, 21),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies:
            [
                new SchemaMigrationCatalogDependency(
                    "20260518-pre-single-author-article-lifecycle",
                    SchemaMigrationPhase.PreCodeFirst),
                new SchemaMigrationCatalogDependency(
                    "20260518-post-single-author-article-lifecycle-indexes",
                    SchemaMigrationPhase.PostCodeFirst)
            ],
            Descriptors:
            [
                SecurityAndProjectionMigrationDefinitions.BuildAuditLogStructuredFieldsPreCodeFirstMigration(),
                LegacyIdentityMigrationDefinitions.BuildAdminPrincipalPlaneMigration(),
                LegacyIdentityMigrationDefinitions.BuildAnonymousIdentityAccountSchemaMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildCommentActorPreCodeFirstMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialAccountBindingMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAuthoringAdminPrincipalAttributionMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentModerationAdminPrincipalAttributionMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildPasskeyRecoveryKeyAccountIdMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildPasskeyUserHandleMigration(),
                LegacyIdentityMigrationDefinitions.BuildSysUserSecurityProfileSplitMigration(),
                LegacyIdentityMigrationDefinitions.BuildUserAuthSecurityHardeningMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAuditLogStructuredFieldsMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentPublicHotPathIndexMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildFrontendRumMetricMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentModerationSignalMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentRegionComplianceMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialAccountBindingLegacyCompatibilityMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildPasskeyRecoveryKeyAccountIdPostCodeFirstCompatMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAccountRecoveryKeyMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCommentGovernanceMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildCommentActorMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialIssuanceAuditMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialRootMetadataMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildArticleMutationOutboxEdgeMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSecurityChallengePersistenceMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSecurityRiskEventPersistenceMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialRootLifecycleMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSecurityPolicySnapshotMigration(),
                LegacyIdentityMigrationDefinitions.BuildMessageAccountPrincipalMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAnonymousCredentialAccountBindingFinalizeMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAuthoringAdminPrincipalAttributionIndexMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildCommentAttributionIndexFinalizerMigration(),
                LegacyIdentityMigrationDefinitions.BuildMessageLegacyIdentityColumnsFinalizeMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildPasskeyRecoveryKeyAccountIdFinalizerMigration(),
                LegacyIdentityMigrationDefinitions.BuildSysUserSecurityProfileSplitFinalizeMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildSysUserUsernameFinalizeMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildUserLegacyIdentityColumnsFinalizeMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildVisitLogAnonymousAttributionFinalizeMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildVisitLogIpAnonymizationMigration()
            ]);
}
