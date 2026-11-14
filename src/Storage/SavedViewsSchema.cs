using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SavedViewColumns =
    [
        "author_saved_view_collection site_id:uuid owner_id:uuid revision:int8",
        "author_saved_view site_id:uuid owner_id:uuid id:uuid revision:int8 name:text name_key:bytea definition:bytea digest:bytea retired:bool",
        "author_saved_view_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 fingerprint:bytea happened_at:timestamptz"
    ];

    private static readonly string[] SavedViewConstraints =
    [
        "author_saved_view_collection p site_id,owner_id",
        "author_saved_view_collection f owner_id public.blog_user:id",
        "author_saved_view_collection c revision revision>0",
        "author_saved_view p site_id,owner_id,id",
        "author_saved_view f site_id,owner_id public.author_saved_view_collection:site_id,owner_id",
        "author_saved_view c revision revision>0",
        "author_saved_view c name octet_length(name)<=512",
        "author_saved_view c definition octet_length(definition)<=262288",
        "author_saved_view c digest octet_length(digest)=32",
        "author_saved_view_command p site_id,owner_id,request_id",
        "author_saved_view_command f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
        "author_saved_view_command c revision revision>0",
        "author_saved_view_command c collection_revision,revision collection_revision>=revision",
        "author_saved_view_command c action action>=1ANDaction<=3",
        "author_saved_view_command c fingerprint octet_length(fingerprint)=32"
    ];

    internal static async Task<bool> HasSavedViewsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select count(oid) from (values (to_regclass('public.author_saved_view_collection')),
                (to_regclass('public.author_saved_view')), (to_regclass('public.author_saved_view_command'))) expected(oid)
            """, db, tx);
        return (await query.ExecuteScalarAsync(ct)) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("The saved views schema is incomplete.")
        };
    }
}
