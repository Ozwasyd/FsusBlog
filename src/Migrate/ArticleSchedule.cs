using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleScheduleAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var recovery = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var revision = await HasRelation(connection, tx, "public.article_rollback", ct);
        var admin = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        var publication = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication,
                requireArticleSchedule: false);
            await ApplySchemaAddition(connection, tx, "scheduled-publication.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, recovery, revision, admin, publication);
        if (recovery) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (admin) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await VerifyArticleScheduleAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified durable article schedule storage.");
    }

    private static async Task VerifyArticleScheduleAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var verify = new NpgsqlCommand("""
            select p.article_id from public.article_schedule p
            join public.article a on a.id=p.article_id
            join public.article_schedule_receipt r on r.actor_id=p.actor_id and r.command_id=p.command_id
            join public.article_command c on c.actor_id=p.actor_id and c.command_id=p.command_id
            where a.owner_id<>p.actor_id or a.deleted or p.revision<>a.revision
                or p.revision<>c.revision or p.article_id<>c.article_id or p.due_at is distinct from r.due_at
                or coalesce(a.published_revision,0)<>r.published_revision
            limit 1
            """, connection, tx);
        if (await verify.ExecuteScalarAsync(ct) is int id)
            throw new InvalidOperationException($"Article {id} has inconsistent pending publication coordinates.");
    }
}
