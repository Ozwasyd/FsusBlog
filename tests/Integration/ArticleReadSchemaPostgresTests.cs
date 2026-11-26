namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleReadSchemaPostgresTests
{
    [PostgresFact]
    public async Task SchemaAcceptsLegacyAbsenceAndRejectsPartialWrongOrMissingWatermark()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        Assert.True(await CurrentSchema.HasArticleReadSchemaAsync(db, null, ct));

        await Execute(db, "ALTER TABLE public.article_read_hour RENAME TO incomplete_article_read_hour", ct);
        await FixtureSql.ExpectSchemaError(db, "aggregate storage is incomplete", ct);
        await Execute(db, "ALTER TABLE public.incomplete_article_read_hour RENAME TO article_read_hour", ct);

        await Execute(db, "DELETE FROM public.article_read_epoch", ct);
        await FixtureSql.ExpectSchemaError(db, "watermark is missing", ct);
        await Execute(db, "INSERT INTO public.article_read_epoch (singleton) VALUES (true)", ct);

        await Execute(db, """
            ALTER TABLE public.article_read_dwell
                DROP CONSTRAINT article_read_dwell_bucket_check,
                ADD CHECK (bucket BETWEEN 0 AND 4)
            """, ct);
        await FixtureSql.ExpectSchemaError(db, "article_read_dwell c bucket bucket>=0ANDbucket<=3", ct);

        await Execute(db, "DROP TABLE public.article_read_hour, public.article_read_dwell, public.article_read_epoch", ct);
        Assert.False(await CurrentSchema.HasArticleReadSchemaAsync(db, null, ct));
        await FixtureSql.ExpectSchemaError(db, "article read total schema presence", ct);
        await Execute(db, "DROP TABLE public.article_read_total", ct);
        await CurrentSchema.VerifyAsync(db, ct);
    }

    [PostgresFact]
    public async Task ReadTotalSchemaRequiresBothDescendingIndexKeys()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(30));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        Assert.True(await CurrentSchema.HasArticleReadTotalSchemaAsync(db, null, ct));

        await Execute(db, "DROP INDEX public.article_read_total_rank", ct);
        await FixtureSql.ExpectSchemaError(db, "descending btree index", ct);

        await Execute(db, "CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC, article_id)", ct);
        await FixtureSql.ExpectSchemaError(db, "descending btree index", ct);

        await Execute(db, "DROP TABLE public.article_read_total", ct);
        Assert.False(await CurrentSchema.HasArticleReadTotalSchemaAsync(db, null, ct));
        await CurrentSchema.VerifyAsync(db, ct);
    }

    private static Task Execute(NpgsqlConnection db, string sql, CancellationToken ct) =>
        FixtureSql.ExecuteAsync(db, null, ct, sql);
}
