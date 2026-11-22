namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CanvasShape = Tables(
        Table("authoring_canvas id:uuid owner_id:uuid revision:int8 title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool touched_at:timestamptz",
            "p id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0",
            "c viewport_zoom viewport_zoom>=100ANDviewport_zoom<=4000"),
        Table("canvas_node canvas_id:uuid id:uuid kind:int4 x:int4 y:int4 width:int4 height:int4 article_id:int4? anchor:text? pinned_revision:int8? note:text? member_ids:_uuid",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f article_id public.article:id",
            "f article_id,pinned_revision public.article_revision:article_id,revision",
            "c kind kind>=0ANDkind<=4"),
        Table("canvas_edge canvas_id:uuid id:uuid source_node_id:uuid target_node_id:uuid explicit_reference:bool sort_order:int4 label:text?",
            "p canvas_id,id",
            "f canvas_id public.authoring_canvas:id",
            "f canvas_id,source_node_id public.canvas_node:canvas_id,id",
            "f canvas_id,target_node_id public.canvas_node:canvas_id,id",
            "c sort_order sort_order>=0"),
        Table("canvas_document_event canvas_id:uuid revision:int8 actor_id:uuid command_id:uuid command_kind:int4 fingerprint:bytea title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool node_count:int4 edge_count:int4 touched_at:timestamptz",
            "p canvas_id,revision",
            "u canvas_id,command_id",
            "f canvas_id public.authoring_canvas:id",
            "f actor_id public.admin_principal:id",
            "c revision revision>0",
            "c fingerprint octet_length(fingerprint)=32",
            "c node_count node_count>=0ANDnode_count<=10000",
            "c edge_count edge_count>=0ANDedge_count<=10000"),
        CanvasLinkPlan("f canvas_id public.authoring_canvas:id"));

    private static SchemaFacts CanvasLinkPlan(string canvasReference) => Table(
        "canvas_link_plan id:uuid canvas_id:uuid edge_id:uuid canvas_revision:int8 host_revision:int8 target_revision:int8 source_offset:int4 insert_digest:bytea session_digest:bytea session_generation:int8 expires_at:timestamptz applied_article_id:int4? applied_revision:int8? applied_canvas_revision:int8?",
        "p id",
        "c canvas_revision canvas_revision>0",
        "c host_revision host_revision>0",
        "c target_revision target_revision>0",
        "c source_offset source_offset>=0",
        "c insert_digest octet_length(insert_digest)=32",
        "c session_digest octet_length(session_digest)=32",
        "c session_generation session_generation>0",
        canvasReference,
        "f applied_article_id,applied_revision public.article_revision:article_id,revision");
}
