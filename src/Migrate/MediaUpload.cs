using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeMediaUploadAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var schedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var publication = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        var revision = await HasRelation(connection, tx, "public.article_rollback", ct);
        var recovery = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var admin = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication, schedule,
                requireMediaUpload: false);
            await ApplySchemaAddition(connection, tx, "private-media-uploads.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication, schedule);
        if (recovery) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (admin) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private resumable media upload schema.");
    }
}
