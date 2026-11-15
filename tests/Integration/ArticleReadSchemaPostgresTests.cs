using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleReadSchemaPostgresTests
{
    [PostgresFact]
    public async Task SchemaAcceptsLegacyAbsenceAndRejectsPartialWrongOrMissingWatermark()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await database.DataSource.OpenConnectionAsync(ct);
        Assert.True(await CurrentSchema.HasArticleReadSchemaAsync(db, null, ct));

        await Execute(db, "ALTER TABLE public.article_read_hour RENAME TO incomplete_article_read_hour", ct);
        var partial = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("aggregate storage is incomplete", partial.Message, StringComparison.Ordinal);
        await Execute(db, "ALTER TABLE public.incomplete_article_read_hour RENAME TO article_read_hour", ct);

        await Execute(db, "DELETE FROM public.article_read_epoch", ct);
        var missingWatermark = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("watermark is missing", missingWatermark.Message, StringComparison.Ordinal);
        await Execute(db, "INSERT INTO public.article_read_epoch (singleton) VALUES (true)", ct);

        await Execute(db, """
            ALTER TABLE public.article_read_dwell
                DROP CONSTRAINT article_read_dwell_bucket_check,
                ADD CHECK (bucket BETWEEN 0 AND 4)
            """, ct);
        var wrongBucket = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("article_read_dwell c bucket bucket>=0ANDbucket<=3", wrongBucket.Message, StringComparison.Ordinal);

        await Execute(db, "DROP TABLE public.article_read_hour, public.article_read_dwell, public.article_read_epoch", ct);
        Assert.False(await CurrentSchema.HasArticleReadSchemaAsync(db, null, ct));
        await CurrentSchema.VerifyAsync(db, ct);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db);
        await command.ExecuteNonQueryAsync(ct);
    }
}
