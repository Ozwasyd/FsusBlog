using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SavedViewShape = Tables(
        Table("author_saved_view_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("author_saved_view site_id:uuid owner_id:uuid id:uuid revision:int8 name:text name_key:bytea definition:bytea digest:bytea retired:bool",
            "p site_id,owner_id,id",
            "f site_id,owner_id public.author_saved_view_collection:site_id,owner_id",
            "c revision revision>0",
            "c name octet_length(name)<=512",
            "c definition octet_length(definition)<=262288",
            "c digest octet_length(digest)=32"),
        Table("author_saved_view_command site_id:uuid owner_id:uuid request_id:uuid view_id:uuid revision:int8 collection_revision:int8 action:int4 fingerprint:bytea happened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "f site_id,owner_id,view_id public.author_saved_view:site_id,owner_id,id",
            "c revision revision>0",
            "c collection_revision,revision collection_revision>=revision",
            "c action action>=1ANDaction<=3",
            "c fingerprint octet_length(fingerprint)=32"));

    private static readonly RelationGroup SavedViewRelations = new(
        "The saved views schema is incomplete.",
        "public.author_saved_view_collection", "public.author_saved_view", "public.author_saved_view_command");

    internal static Task<bool> HasSavedViewsAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SavedViewRelations.IsPresentAsync(db, tx, ct);
}
