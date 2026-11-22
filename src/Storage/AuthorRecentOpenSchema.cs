using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AuthorRecentOpenShape = Tables(
        Table("author_recent_open_collection site_id:uuid owner_id:uuid revision:int8",
            "p site_id,owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>0"),
        Table("author_recent_open site_id:uuid owner_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,article_id",
            "u site_id,owner_id,sequence",
            "f article_id public.article:id",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "c article_revision article_revision>0",
            "c sequence sequence>0"),
        Table("author_recent_open_receipt site_id:uuid owner_id:uuid request_id:uuid article_id:int4 article_revision:int8 sequence:int8 opened_at:timestamptz",
            "p site_id,owner_id,request_id",
            "u site_id,owner_id,sequence",
            "f site_id,owner_id public.author_recent_open_collection:site_id,owner_id",
            "c article_revision article_revision>0",
            "c sequence sequence>0"));

    private static readonly RelationGroup AuthorRecentOpenRelations = new(
        "The author recent opens schema is incomplete.",
        "public.author_recent_open_collection", "public.author_recent_open", "public.author_recent_open_receipt");

    internal static Task<bool> HasAuthorRecentOpensAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AuthorRecentOpenRelations.IsPresentAsync(db, tx, ct);
}
