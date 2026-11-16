using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string PublicationCanonicalRelation = "public.article_publication_canonical";

    private static readonly string[] PublicationCanonicalColumns =
    [
        "article_publication_canonical publication_id:int8 article_id:int4 revision:int8 publication_no:int4 published_at:timestamptz transition:text rights_snapshot_id:int8 outbox_id:int8 outbox_kind:text canonical_version:int4 content_sha256:bytea policy_sha256:bytea"
    ];

    private static readonly string[] PublicationCanonicalConstraints =
    [
        "article_publication_history u publication_id,article_id,revision,publication_no,happened_at,kind",
        "article_publication_rights u id,publication_id,article_id,revision",
        "blog_outbox u id,article_id,revision,kind",
        "article_publication_canonical p publication_id",
        "article_publication_canonical u rights_snapshot_id",
        "article_publication_canonical u outbox_id",
        "article_publication_canonical f publication_id,article_id,revision,publication_no,published_at,transition public.article_publication_history:publication_id,article_id,revision,publication_no,happened_at,kind",
        "article_publication_canonical f rights_snapshot_id,publication_id,article_id,revision public.article_publication_rights:id,publication_id,article_id,revision",
        "article_publication_canonical f outbox_id,article_id,revision,outbox_kind public.blog_outbox:id,article_id,revision,kind",
        "article_publication_canonical c transition transition=ANY(ARRAY['publish'::text,'replace'::text])",
        "article_publication_canonical c outbox_kind outbox_kind='publish'::text",
        "article_publication_canonical c content_sha256 octet_length(content_sha256)=32",
        "article_publication_canonical c policy_sha256 octet_length(policy_sha256)=32"
    ];

    internal static Task<bool> HasPublicationCanonicalAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, PublicationCanonicalRelation, ct);
}
