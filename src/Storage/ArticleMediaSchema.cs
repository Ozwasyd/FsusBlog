namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string ArticleMediaRelation = "public.article_revision_media";
    private static readonly SchemaFacts ArticleMediaShape = Table(
        "article_revision_media article_id:int4 revision:int8 asset_id:uuid",
        "p article_id,revision,asset_id",
        "f article_id,revision public.article_revision:article_id,revision",
        "f asset_id public.private_media:id");

}
