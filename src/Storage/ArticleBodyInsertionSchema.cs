using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string ArticleBodyInsertionBaseColumns =
        "article_body_insertion article_id:int4 revision:int8 source_revision:int8 offset_utf16:int4 length_utf16:int4 source_digest:bytea body_digest:bytea";

    private static readonly string[] ArticleBodyInsertionBaseConstraints =
    [
        "article_body_insertion p article_id,revision",
        "article_body_insertion f article_id,revision public.article_revision:article_id,revision",
        "article_body_insertion f article_id,source_revision public.article_revision:article_id,revision",
        "article_body_insertion c revision,source_revision revision=(source_revision+1)",
        "article_body_insertion c offset_utf16 offset_utf16>=0",
        "article_body_insertion c length_utf16 length_utf16>0",
        "article_body_insertion c source_digest octet_length(source_digest)=32",
        "article_body_insertion c body_digest octet_length(body_digest)=32"
    ];

    private static string ArticleBodyInsertionColumns(bool operations) =>
        ArticleBodyInsertionBaseColumns + (operations ? " operations:_int4?" : "");

    private static IReadOnlyList<string> ArticleBodyInsertionConstraints(bool operations) =>
        operations ? [..ArticleBodyInsertionBaseConstraints,
            "article_body_insertion c operations cardinality(operations)>=2ANDcardinality(operations)<=16",
            "article_body_insertion c operations array_ndims(operations)=1",
            "article_body_insertion c operations array_lower(operations,1)=1",
            "article_body_insertion c operations array_position(operations,NULL::integer)ISNULL"] : ArticleBodyInsertionBaseConstraints;

    internal static async Task<bool> HasArticleBodyInsertionOperationsAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        CancellationToken ct)
    {
        await using var read = new NpgsqlCommand("""
            select atttypid='pg_catalog.int4[]'::regtype
            from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('public.article_body_insertion')
                and attname='operations' and attnum>0 and not attisdropped
            """, db, tx);
        return await read.ExecuteScalarAsync(ct) switch
        {
            null => false,
            true => true,
            _ => throw new InvalidOperationException("Invalid article body insertion operations column.")
        };
    }

    internal static async Task<bool> HasArticleBodyInsertionAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var read = new NpgsqlCommand(
            "select relkind::text from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.article_body_insertion')",
            db, tx);
        return await read.ExecuteScalarAsync(ct) switch
        {
            null => false,
            "r" => true,
            _ => throw new InvalidOperationException("Invalid article body insertion relation.")
        };
    }
}
