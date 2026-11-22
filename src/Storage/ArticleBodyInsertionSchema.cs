using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
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

    private static string ArticleBodyInsertionColumns(bool operations, bool edits)
    {
        var nullable = edits ? "?" : "";
        return $"article_body_insertion article_id:int4 revision:int8 source_revision:int8 offset_utf16:int4{nullable} length_utf16:int4{nullable} source_digest:bytea body_digest:bytea" +
            (operations ? " operations:_int4?" : "") + (edits ? " edit_texts:_text?" : "");
    }

    private static IReadOnlyList<string> ArticleBodyInsertionConstraints(bool operations, bool edits)
    {
        string[] constraints = operations ? [..ArticleBodyInsertionBaseConstraints,
            "article_body_insertion c operations cardinality(operations)>=2ANDcardinality(operations)<=16",
            "article_body_insertion c operations array_ndims(operations)=1",
            "article_body_insertion c operations array_lower(operations,1)=1",
            "article_body_insertion c operations array_position(operations,NULL::integer)ISNULL"] : ArticleBodyInsertionBaseConstraints;
        return edits ? [..constraints,
            "article_body_insertion c edit_texts cardinality(edit_texts)>=1ANDcardinality(edit_texts)<=8",
            "article_body_insertion c edit_texts array_ndims(edit_texts)=1",
            "article_body_insertion c edit_texts array_lower(edit_texts,1)=1",
            "article_body_insertion c edit_texts array_position(edit_texts,NULL::text)ISNULL"] : constraints;
    }

    private const string ArticleBodyInsertionRelation = "public.article_body_insertion";

    private static readonly BodyArrayColumn BodyEditTexts = new("edit_texts", "text", "Invalid article body edit text column.");
    private static readonly BodyArrayColumn BodyInsertionOperations = new("operations", "int4", "Invalid article body insertion operations column.");
    private static readonly TableProbe BodyInsertionTable = new(ArticleBodyInsertionRelation, "Invalid article body insertion relation.");

    internal static Task<bool> HasArticleBodyEditsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyEditTexts.IsPresentAsync(db, tx, ct);

    internal static Task<bool> HasArticleBodyInsertionOperationsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyInsertionOperations.IsPresentAsync(db, tx, ct);

    internal static Task<bool> HasArticleBodyInsertionAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        BodyInsertionTable.IsPresentAsync(db, tx, ct);

    private sealed class BodyArrayColumn(string name, string elementType, string invalid)
    {
        private readonly string _catalogType = $"pg_catalog._{elementType}";
        private readonly string _sql = $"""
            select atttypid='pg_catalog.{elementType}[]'::regtype
            from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('{ArticleBodyInsertionRelation}')
                and attname='{name}' and attnum>0 and not attisdropped
            """;

        internal Task<bool> IsPresentAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
            MatchesOptionalScalarAsync(db, tx, _sql, true, invalid, ct);

        internal bool IsPresent(CatalogPresenceSnapshot catalog) =>
            catalog.TryGetColumn(ArticleBodyInsertionRelation, name, out var column) &&
            RequireMatch(column.TypeName == _catalogType, invalid);
    }
}
