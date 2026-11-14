namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CanvasHistoryColumns =
    [
        "canvas_history_patch canvas_id:uuid edit_revision:int8 undone:bool moved_at_revision:int8 payload:bytea digest:bytea",
        "canvas_history_transition canvas_id:uuid revision:int8 target_revision:int8? discarded_redo:_int8"
    ];

    private static readonly string[] CanvasHistoryConstraints =
    [
        "canvas_history_patch p canvas_id,edit_revision",
        "canvas_history_patch f canvas_id,edit_revision public.canvas_document_event:canvas_id,revision",
        "canvas_history_patch f canvas_id,moved_at_revision public.canvas_document_event:canvas_id,revision",
        "canvas_history_patch c payload octet_length(payload)>=1ANDoctet_length(payload)<=33554432",
        "canvas_history_patch c digest octet_length(digest)=32",
        "canvas_history_transition p canvas_id,revision",
        "canvas_history_transition f canvas_id,revision public.canvas_document_event:canvas_id,revision",
        "canvas_history_transition f canvas_id,target_revision public.canvas_document_event:canvas_id,revision"
    ];
}
