namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string ArticleMediaRelation = "public.article_revision_media";
    private static readonly SchemaFacts ArticleMediaShape = new(
        Columns: ["article_revision_media article_id:int4 revision:int8 asset_id:uuid"],
        Constraints: [
            "article_revision_media p article_id,revision,asset_id",
            "article_revision_media f article_id,revision public.article_revision:article_id,revision",
            "article_revision_media f asset_id public.private_media:id"
        ]);

}
