using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts ArticleCoverShape = Table(
        "article_revision_cover article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision",
        "f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id");


    private const string ArticleCoverRelation = "public.article_revision_cover";

    internal static Task<bool> HasArticleCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, ArticleCoverRelation, ct);
}
