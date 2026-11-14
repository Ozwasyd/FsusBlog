using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRevisionHistoryAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var hasArticleSchedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var hasPublicationHistory = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        var hasRecoveryScope = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var hasAdminIdentity = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        var hasMediaUpload = await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct);
        var hasPublicationRights = await HasRelation(connection, tx, CurrentSchema.PublicationRightsRelation, ct);
        if (!await HasRelation(connection, tx, "public.article_rollback", ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope,
                requireRevisionHistory: false, requireAdminIdentity: hasAdminIdentity, requirePublicationHistory: hasPublicationHistory,
                requireArticleSchedule: hasArticleSchedule, requireMediaUpload: hasMediaUpload, requirePublicationRights: hasPublicationRights);
            await ApplySchemaAddition(connection, tx, "revision-rollback.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, requireAdminIdentity: hasAdminIdentity,
            requirePublicationHistory: hasPublicationHistory, requireArticleSchedule: hasArticleSchedule, requireMediaUpload: hasMediaUpload, requirePublicationRights: hasPublicationRights);
        if (hasAdminIdentity) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private article revision history schema.");
    }
}
