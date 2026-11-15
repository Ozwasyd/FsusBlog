using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleScheduleAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await InstallPreviewSchemaAsync(connection, tx, PreviewSchema.Schedule, "scheduled-publication.sql", ct);
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
