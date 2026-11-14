using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationRightsAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var recovery = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var revision = await HasRelation(connection, tx, "public.article_rollback", ct);
        var admin = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        var publication = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        var schedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var media = await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.PublicationRightsRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication, schedule, media,
                requirePublicationRights: false);
            await ApplySchemaAddition(connection, tx, "publication-rights.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication, schedule, media);
        if (recovery) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (admin) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await ReportMissingPublicationRights(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified publication rights storage.");
    }

    private static async Task ReportMissingPublicationRights(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select count(*) from public.article_publication p where not exists (
                select from public.article_publication_rights s
                where s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
            )
            """, connection, tx);
        if (await cmd.ExecuteScalarAsync(ct) is long count && count != 0)
            Console.WriteLine($"Publication rights: {count} active coordinates have no exact rights snapshot and are excluded from public reads.");
    }
}
