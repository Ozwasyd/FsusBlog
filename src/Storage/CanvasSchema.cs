namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CanvasColumns =
    [
        "authoring_canvas id:uuid owner_id:uuid revision:int8 title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool touched_at:timestamptz",
        "canvas_node canvas_id:uuid id:uuid kind:int4 x:int4 y:int4 width:int4 height:int4 article_id:int4? anchor:text? pinned_revision:int8? note:text? member_ids:_uuid",
        "canvas_edge canvas_id:uuid id:uuid source_node_id:uuid target_node_id:uuid explicit_reference:bool sort_order:int4 label:text?",
        "canvas_document_event canvas_id:uuid revision:int8 actor_id:uuid command_id:uuid command_kind:int4 fingerprint:bytea title:text viewport_x:int4 viewport_y:int4 viewport_zoom:int4 deleted:bool node_count:int4 edge_count:int4 touched_at:timestamptz",
        "canvas_link_plan id:uuid canvas_id:uuid edge_id:uuid canvas_revision:int8 host_revision:int8 target_revision:int8 source_offset:int4 insert_digest:bytea session_digest:bytea session_generation:int8 expires_at:timestamptz applied_article_id:int4? applied_revision:int8? applied_canvas_revision:int8?"
    ];

    private static readonly string[] CanvasConstraints =
    [
        "authoring_canvas p id",
        "authoring_canvas f owner_id public.admin_principal:id",
        "authoring_canvas c revision revision>0",
        "authoring_canvas c viewport_zoom viewport_zoom>=100ANDviewport_zoom<=4000",
        "canvas_node p canvas_id,id",
        "canvas_node f canvas_id public.authoring_canvas:id",
        "canvas_node f article_id public.article:id",
        "canvas_node f article_id,pinned_revision public.article_revision:article_id,revision",
        "canvas_node c kind kind>=0ANDkind<=4",
        "canvas_edge p canvas_id,id",
        "canvas_edge f canvas_id public.authoring_canvas:id",
        "canvas_edge f canvas_id,source_node_id public.canvas_node:canvas_id,id",
        "canvas_edge f canvas_id,target_node_id public.canvas_node:canvas_id,id",
        "canvas_edge c sort_order sort_order>=0",
        "canvas_document_event p canvas_id,revision",
        "canvas_document_event u canvas_id,command_id",
        "canvas_document_event f canvas_id public.authoring_canvas:id",
        "canvas_document_event f actor_id public.admin_principal:id",
        "canvas_document_event c revision revision>0",
        "canvas_document_event c fingerprint octet_length(fingerprint)=32",
        "canvas_document_event c node_count node_count>=0ANDnode_count<=10000",
        "canvas_document_event c edge_count edge_count>=0ANDedge_count<=10000",
        "canvas_link_plan p id",
        "canvas_link_plan c canvas_revision canvas_revision>0",
        "canvas_link_plan c host_revision host_revision>0",
        "canvas_link_plan c target_revision target_revision>0",
        "canvas_link_plan c source_offset source_offset>=0",
        "canvas_link_plan c insert_digest octet_length(insert_digest)=32",
        "canvas_link_plan c session_digest octet_length(session_digest)=32",
        "canvas_link_plan c session_generation session_generation>0",
        "canvas_link_plan f canvas_id public.authoring_canvas:id",
        "canvas_link_plan f applied_article_id,applied_revision public.article_revision:article_id,revision",
    ];
}
