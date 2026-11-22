using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SavedViewPlacementShape = Tables(
        Table("author_saved_view_default site_id:uuid owner_id:uuid view_id:uuid",
            "p site_id,owner_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id"),
        Table("author_saved_view_pin site_id:uuid owner_id:uuid view_id:uuid pin_order:int4",
            "p site_id,owner_id,view_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "c pin_order pin_order>0",
            "u site_id,owner_id,pin_order deferred"),
        Table("author_saved_view_placement_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 before_id:uuid? fingerprint:bytea happened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "f site_id,owner_id,before_id public.author_saved_view:site_id,owner_id,id",
            "c revision revision>0",
            "c collection_revision,revision collection_revision>=revision",
            "c action action>=4ANDaction<=8",
            "c fingerprint octet_length(fingerprint)=32"));

    private static readonly RelationGroup SavedViewPlacementRelations = new(
        "The saved view placement schema is incomplete.",
        "public.author_saved_view_default", "public.author_saved_view_pin", "public.author_saved_view_placement_command");

    internal static Task<bool> HasSavedViewPlacementAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewPlacementRelations.IsPresentAsync(db, tx, ct);
}
