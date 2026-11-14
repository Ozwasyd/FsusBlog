namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AuthoringWorkspaceRelation = "public.authoring_workspace";

    private static readonly string[] AuthoringWorkspaceColumns =
    [
        "authoring_workspace user_id:uuid schema_version:int4 revision:int8 updated_at:timestamptz active_article_id:int4 tabs:_int4"
    ];

    private static readonly string[] AuthoringWorkspaceConstraints =
    [
        "authoring_workspace p user_id",
        "authoring_workspace f user_id public.blog_user:id",
        "authoring_workspace c schema_version schema_version=1",
        "authoring_workspace c revision revision>0",
        "authoring_workspace c active_article_id active_article_id>=0",
        "authoring_workspace c tabs cardinality(tabs)<=100"
    ];
}
