using FsusBlog.V2.Contracts;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static class PublicationCanonicalFacts
{
    internal const string Columns = """
        h.publication_id,h.article_id,h.revision,h.publication_no,h.happened_at,h.kind,s.id,
        r.title,r.body,category.category_id,
        array(select t.tag_id from public.article_revision_tag t
            where t.article_id=r.article_id and t.revision=r.revision order by t.tag_id),
        w.enabled,w.license_type,w.copyright_holder,w.copyright_year,w.rights_statement,
        w.attribution_template,w.copy_policy,w.max_excerpt_chars,w.allow_code_copy,w.show_public_badge,w.proof_binding_enabled
        """;

    internal const string RevisionJoins = """
        join public.article_revision r on r.article_id=h.article_id and r.revision=h.revision
        join public.article_publication_rights s on s.article_id=h.article_id and s.revision=h.revision and s.publication_id=h.publication_id
        join public.article_revision_rights w on w.article_id=r.article_id and w.revision=r.revision
        left join public.article_revision_category category on category.article_id=r.article_id and category.revision=r.revision
        """;

    internal static string CoverColumn(bool hasCover) => hasCover ? """
        (select m.content_hash from public.article_publication_cover c
         join public.article_publication_media m using(article_id,publication_id,asset_id)
         where (m.article_id,m.publication_id,m.revision)=(h.article_id,h.publication_id,h.revision))
        """ : "null::bytea";

    internal static PublicationCanonicalBinding Read(NpgsqlDataReader row)
    {
        var publication = row.GetInt64(0);
        var article = row.GetInt32(1);
        var revision = row.GetInt64(2);
        var ordinal = row.GetInt32(3);
        var at = row.GetDateTime(4);
        var transition = row.GetString(5);
        var rightsId = row.GetInt64(6);
        if (publication <= 0 || ordinal <= 0 || rightsId <= 0 || at == DateTime.MinValue || at == DateTime.MaxValue ||
            transition is not ("publish" or "replace"))
            throw new InvalidOperationException("Invalid native publication canonical binding.");
        var cover = row.IsDBNull(22) ? null : row.GetFieldValue<byte[]>(22);
        var content = ArticleCanonicalHashesV2.ContentDigest(new(article, revision, row.GetString(7), row.GetString(8),
            row.IsDBNull(9) ? null : row.GetInt32(9), row.GetFieldValue<int[]>(10), cover));
        var policy = ArticleCanonicalHashesV2.PolicyDigest(new(article, revision, true, row.GetBoolean(11), row.GetString(12),
            row.GetString(13), row.GetInt32(14), row.GetString(15), row.GetString(16), row.GetString(17), row.GetInt32(18),
            row.GetBoolean(19), row.GetBoolean(20), row.GetBoolean(21)), content);
        return new(publication, article, revision, ordinal, at, transition, rightsId, cover is null ? 2 : 3, content, policy);
    }
}

internal sealed record PublicationCanonicalBinding(long Publication, int Article, long Revision, int Number, DateTime PublishedAt,
    string Transition, long RightsSnapshot, int Version, byte[] Content, byte[] Policy);
