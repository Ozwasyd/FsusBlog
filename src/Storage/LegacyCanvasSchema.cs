namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts LegacyCanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8",
            "p id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("canvas_edge canvas_id:uuid id:uuid article_id:int4 target_article_id:int4 explicit_reference:bool",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f article_id public.article:id",
            "f target_article_id public.article:id",
            "c article_id,target_article_id article_id<>target_article_id"),
        CanvasLinkPlan("f canvas_id,edge_id public.canvas_edge:canvas_id,id"));
}
