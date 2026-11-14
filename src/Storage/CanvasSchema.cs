namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CanvasColumns =
    [
        "authoring_canvas id:uuid owner_id:uuid revision:int8",
        "canvas_edge canvas_id:uuid id:uuid article_id:int4 target_article_id:int4 explicit_reference:bool",
        "canvas_link_plan id:uuid canvas_id:uuid edge_id:uuid canvas_revision:int8 host_revision:int8 target_revision:int8 source_offset:int4 insert_digest:bytea session_digest:bytea session_generation:int8 expires_at:timestamptz applied_article_id:int4? applied_revision:int8? applied_canvas_revision:int8?"
    ];

    private static readonly string[] CanvasConstraints =
    [
        "authoring_canvas p id",
        "authoring_canvas f owner_id public.blog_user:id",
        "authoring_canvas c revision revision>0",
        "canvas_edge p canvas_id,id",
        "canvas_edge f canvas_id public.authoring_canvas:id",
        "canvas_edge f article_id public.article:id",
        "canvas_edge f target_article_id public.article:id",
        "canvas_edge c article_id,target_article_id article_id<>target_article_id",
        "canvas_link_plan p id",
        "canvas_link_plan c canvas_revision canvas_revision>0",
        "canvas_link_plan c host_revision host_revision>0",
        "canvas_link_plan c target_revision target_revision>0",
        "canvas_link_plan c source_offset source_offset>=0",
        "canvas_link_plan c insert_digest octet_length(insert_digest)=32",
        "canvas_link_plan c session_digest octet_length(session_digest)=32",
        "canvas_link_plan c session_generation session_generation>0",
        "canvas_link_plan f canvas_id,edge_id public.canvas_edge:canvas_id,id",
        "canvas_link_plan f applied_article_id,applied_revision public.article_revision:article_id,revision",
    ];
}
