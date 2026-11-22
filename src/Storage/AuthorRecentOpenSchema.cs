using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AuthorRecentOpenShape = new(
        Columns: [
            "author_recent_open_collection site_id:uuid owner_id:uuid revision:int8",
            "author_recent_open site_id:uuid owner_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "author_recent_open_receipt site_id:uuid owner_id:uuid request_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz"
        ],
        Constraints: [
            "author_recent_open_collection p site_id,owner_id",
            "author_recent_open_collection f owner_id public.admin_principal:id",
            "author_recent_open_collection c revision revision>0",
            "author_recent_open p site_id,owner_id,article_id",
            "author_recent_open u site_id,owner_id,sequence",
            "author_recent_open f article_id public.article:id",
            "author_recent_open f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "author_recent_open c article_revision article_revision>0",
            "author_recent_open c sequence sequence>0",
            "author_recent_open_receipt p site_id,owner_id,request_id",
            "author_recent_open_receipt u site_id,owner_id,sequence",
            "author_recent_open_receipt f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "author_recent_open_receipt c article_revision article_revision>0",
            "author_recent_open_receipt c sequence sequence>0"
        ]);

    private static readonly string[] AuthorRecentOpenRelations =
        ["public.author_recent_open_collection", "public.author_recent_open", "public.author_recent_open_receipt"];

    internal static Task<bool> HasAuthorRecentOpensAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "The author recent opens schema is incomplete.",
            AuthorRecentOpenRelations);

    private static bool HasAuthorRecentOpens(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The author recent opens schema is incomplete.", AuthorRecentOpenRelations);
}
