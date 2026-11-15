using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string ArticleRevisionColumns = "article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz";
    private const string ArticleSummaryConstraint = "article_revision c author_summary char_length(author_summary)>=1ANDchar_length(author_summary)<=512";

    internal static async Task<bool> HasArticleSummaryAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            SELECT CASE WHEN EXISTS (
                       SELECT FROM pg_catalog.pg_attribute
                       WHERE attrelid = pg_catalog.to_regclass('public.article_revision')
                         AND attname = 'author_summary' AND attnum > 0 AND NOT attisdropped
                   ) THEN 1 ELSE 0 END
                 + CASE WHEN EXISTS (
                       SELECT FROM pg_catalog.pg_constraint
                       WHERE conrelid = pg_catalog.to_regclass('public.article_revision')
                         AND conname = 'article_revision_author_summary_length' AND contype = 'c'
                   ) THEN 1 ELSE 0 END
            """, connection, transaction);
        return await query.ExecuteScalarAsync(ct) switch
        {
            0 => false,
            2 => true,
            _ => throw new InvalidOperationException("The article author summary schema is incomplete.")
        };
    }
}
