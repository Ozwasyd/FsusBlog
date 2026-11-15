using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationMediaAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasPublicationMediaAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requirePublicationMedia: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists) await ApplySchemaAddition(db, tx, "publication-media.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requirePublicationMedia: true);
        await VerifyPublicationMediaAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the article publication media schema.");
    }

    private static async Task VerifyPublicationMediaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPublicationMediaAsync(db, tx, ct)) return;

        await using var command = new NpgsqlCommand("""
            SELECT m.article_id
            FROM public.article_publication_media m
            JOIN public.article_publication_history h USING (article_id, publication_id, revision)
            JOIN public.article a ON a.id=m.article_id
            JOIN public.private_media p ON p.id=m.asset_id
            WHERE h.actor_id IS DISTINCT FROM a.owner_id
               OR h.kind NOT IN ('publish','replace')
               OR EXISTS (SELECT FROM public.article_schedule_receipt s
                          WHERE s.actor_id=h.actor_id AND s.command_id=h.command_id)
               OR p.owner_id IS DISTINCT FROM a.owner_id OR p.phase<>1
               OR (p.content_hash,p.format,p.length,p.width,p.height)
                    IS DISTINCT FROM (m.content_hash,m.format,m.length,m.width,m.height)
            UNION ALL
            SELECT article_id FROM public.article_publication_media
            GROUP BY article_id,publication_id
            HAVING max(ordinal)<>count(*) OR sum(length)>$1
            LIMIT 1
            """, db, tx);
        command.Parameters.AddWithValue(CurrentSchema.PublicationMediaMaximumBytes);
        if (await command.ExecuteScalarAsync(ct) is int article)
            throw new InvalidOperationException($"Article {article} has inconsistent publication media metadata.");
    }
}
