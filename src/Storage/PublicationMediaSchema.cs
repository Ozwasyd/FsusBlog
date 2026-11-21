using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const int PublicationMediaMaximumBytes = 40 * 1024 * 1024;

    private static readonly string[] PublicationMediaColumns =
    [
        "article_publication_media article_id:int4 publication_id:int8 revision:int8 ordinal:int4 asset_id:uuid content_hash:bytea format:int2 length:int4 width:int4 height:int4"
    ];

    private static readonly string[] PublicationMediaConstraints =
    [
        "article_publication_history u article_id,publication_id,revision",
        "article_publication_media p article_id,publication_id,ordinal",
        "article_publication_media u article_id,publication_id,asset_id",
        "article_publication_media u article_id,publication_id,content_hash",
        "article_publication_media f article_id,publication_id,revision public.article_publication_history:article_id,publication_id,revision",
        "article_publication_media f article_id,revision,asset_id public.article_revision_media:article_id,revision,asset_id",
        "article_publication_media c ordinal ordinal>=1ANDordinal<=32",
        "article_publication_media c content_hash octet_length(content_hash)=32",
        "article_publication_media c format format>=1ANDformat<=2",
        "article_publication_media c length length>=1ANDlength<=20971520",
        "article_publication_media c width width>=1ANDwidth<=8192",
        "article_publication_media c height height>=1ANDheight<=8192"
    ];

    private const string PublicationMediaRelation = "public.article_publication_media";

    internal static Task<bool> HasPublicationMediaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationMediaRelation, ct);

    private static bool HasPublicationMedia(CatalogPresenceSnapshot catalog) =>
        catalog.HasRelation(PublicationMediaRelation);
}
