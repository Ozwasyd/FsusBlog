using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PublicationCoverColumns =
        ["article_publication_cover article_id:int4 publication_id:int8 asset_id:uuid"];
    private static readonly string[] PublicationCoverConstraints =
    [
        "article_publication_cover p article_id,publication_id",
        "article_publication_cover f article_id,publication_id,asset_id public.article_publication_media:article_id,publication_id,asset_id"
    ];

    private static string PublicationCanonicalVersionConstraint(bool hasCover) => hasCover
        ? "article_publication_canonical c canonical_version canonical_version=ANY(ARRAY[2,3])"
        : "article_publication_canonical c canonical_version canonical_version=2";

    private const string PublicationCoverRelation = "public.article_publication_cover";

    internal static Task<bool> HasPublicationCoverAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCoverRelation, ct);
}
