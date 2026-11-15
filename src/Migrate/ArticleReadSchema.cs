using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleReadSchemaAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        var installed = await CurrentSchema.HasArticleReadSchemaAsync(db, tx, ct);
        var totalsInstalled = await CurrentSchema.HasArticleReadTotalSchemaAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleRead: installed, requireArticleReadTotal: totalsInstalled);
        if (!installed)
            await ApplySchemaAddition(db, tx, "article-read.sql", ct);
        if (!totalsInstalled)
        {
            await ApplySchemaAddition(db, tx, "zz-article-read-total.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleRead: true, requireArticleReadTotal: true);
        }
        await ExecuteAsync(db, tx, """
            with expected as materialized (
                select article_id,least(sum(count),2147483647)::integer views
                from public.article_read_hour group by article_id
            ), removed as (
                delete from public.article_read_total total
                where not exists (select from expected where expected.article_id=total.article_id)
            )
            insert into public.article_read_total as total(article_id,views)
            select article_id,views from expected
            on conflict(article_id) do update set views=excluded.views
            where total.views<>excluded.views
            """, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the article read schema and reconciled totals from hourly counts.");
    }
}
