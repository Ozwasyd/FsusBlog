using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SavedViewPlacementColumns =
    [
        "author_saved_view_default site_id:uuid owner_id:uuid view_id:uuid",
        "author_saved_view_pin site_id:uuid owner_id:uuid view_id:uuid pin_order:int4",
        "author_saved_view_placement_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 before_id:uuid? fingerprint:bytea happened_at:timestamptz"
    ];

    private static readonly string[] SavedViewPlacementConstraints =
    [
        "author_saved_view_default p site_id,owner_id",
        "author_saved_view_default f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
        "author_saved_view_pin p site_id,owner_id,view_id",
        "author_saved_view_pin f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
        "author_saved_view_pin c pin_order pin_order>0",
        "author_saved_view_pin u site_id,owner_id,pin_order deferred",
        "author_saved_view_placement_command p site_id,owner_id,request_id",
        "author_saved_view_placement_command f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
        "author_saved_view_placement_command f site_id,owner_id,before_id public.author_saved_view:site_id,owner_id,id",
        "author_saved_view_placement_command c revision revision>0",
        "author_saved_view_placement_command c collection_revision,revision collection_revision>=revision",
        "author_saved_view_placement_command c action action>=4ANDaction<=8",
        "author_saved_view_placement_command c fingerprint octet_length(fingerprint)=32"
    ];

    internal static async Task<bool> HasSavedViewPlacementAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select count(oid) from (values (to_regclass('public.author_saved_view_default')),
                (to_regclass('public.author_saved_view_pin')), (to_regclass('public.author_saved_view_placement_command'))) expected(oid)
            """, db, tx);
        return (await query.ExecuteScalarAsync(ct)) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("The saved view placement schema is incomplete.")
        };
    }
}
