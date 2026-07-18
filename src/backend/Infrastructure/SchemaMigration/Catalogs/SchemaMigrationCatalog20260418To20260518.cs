using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;

internal static class SchemaMigrationCatalog20260418To20260518
{
    internal static SchemaMigrationCatalog Create()
        => new(
            CatalogId: "legacy-bootstrap-20260418-20260518",
            StartVersion: new DateOnly(2026, 4, 18),
            EndVersion: new DateOnly(2026, 5, 18),
            GapPolicy: SchemaMigrationGapPolicy.AllowSparseVersions,
            Dependencies: [],
            Descriptors:
            [
                LegacyIdentityMigrationDefinitions.BuildCommentThreadCompatMigration(),
                LegacyIdentityMigrationDefinitions.BuildContentCompatMigration(),
                LegacyIdentityMigrationDefinitions.BuildUserSessionCompatPreMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildCoverImageMigration(),
                LegacyIdentityMigrationDefinitions.BuildLegacy20260517ProfileCompatibilityMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentModerationMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildSingleAuthorArticleLifecycleMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildAuditLogMigration(),
                LegacyIdentityMigrationDefinitions.BuildCommentThreadIndexMigration(),
                LegacyIdentityMigrationDefinitions.BuildContentCleanupMigration(),
                LegacyIdentityMigrationDefinitions.BuildMessagingSplitMigration(),
                LegacyIdentityMigrationDefinitions.BuildUserSessionFinalizeMigration(),
                LegacyIdentityMigrationDefinitions.BuildUserSoftDeleteMigration(),
                SecurityAndProjectionMigrationDefinitions.BuildHumanReadEventMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAuthoringDraftLifecycleMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildAuthoringWorkspaceTablesMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildCommentModerationIndexMigration(),
                AuthoringAndIntegrityMigrationDefinitions.BuildSingleAuthorArticleLifecycleIndexMigration()
            ]);
}
