using System.Data.Common;
using FsusBlog.V2.Contracts;

internal static partial class Migration
{
    private sealed record LegacyRepublishEvidence(long PreviousReleaseId, DateTime PreviousReleaseAt,
        int BeforeCategory, int[] BeforeTags);

    private static async Task<Dictionary<long, LegacyRepublishEvidence>> ReadLegacyOrdinaryRepublishAsync(LegacySource source,
        DbTransaction tx, Dictionary<string, LegacyTable> tables, LegacyTable principals, LegacyTable events, CancellationToken ct)
    {
        string E(string name) => "event." + source.Field(events, name);
        string A(string name) => "article." + source.Field(tables[Article], name);
        string R(string name) => "revision." + source.Field(tables[Revision], name);
        string H(string name) => "previous_revision." + source.Field(tables[Revision], name);
        string P(string name) => "publication." + source.Field(tables[Publication], name);
        string F(string name) => "first_release." + source.Field(tables[Publication], name);
        string S(string name) => "rights." + source.Field(tables[RightsSnapshot], name);
        string B(string name) => "body." + source.Field(tables[Block], name);
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {E("id")}, {A("id")}, {R("id")}, {F("id")}, {SelectRepresentableLegacyOutboxClock(F("published_at"))},
                {H("categoryid")}, {H("tag_ids")}, {R("title")}, {R("summary")}, {R("cover_image_url")},
                {R("categoryid")}, {R("tag_ids")}, {B("markdown_content")},
                {S("canonical_url")}, {S("content_canonical_hash")}, {S("policy_hash")}, {S("license_type")},
                {S("copyright_holder")}, {S("copyright_year")}, {S("rights_statement")}, {S("attribution_template")},
                {S("copy_policy")}, {S("max_excerpt_chars")}, {S("allow_code_copy")}, {S("show_public_badge")}
            FROM {source.Table(events)} event
            JOIN {source.Table(tables[Article])} article ON {A("id")}={E("aggregate_id")}
            JOIN {source.Table(tables[Revision])} revision ON {R("id")}={E("article_revision_id")}
                AND {R("article_id")}={A("id")} AND {R("revision_no")}=2
            JOIN {source.Table(tables[Block])} body ON {B("id")}={R("content_block_id")}
            JOIN {source.Table(principals)} author ON author.{source.Field(principals, "id")}={R("created_by_admin_principal_id")}
            JOIN {source.Table(tables[Publication])} publication ON {P("id")}={E("article_publication_id")}
                AND {P("article_id")}={A("id")} AND {P("article_revision_id")}={R("id")}
                AND {P("publication_no")}=2 AND {P("revision_no")}=2 AND {P("transition_kind")}='immediate-publish'
            JOIN {source.Table(tables[Publication])} first_release ON {F("article_id")}={A("id")}
                AND {F("publication_no")}=1 AND {F("revision_no")}=1 AND {F("transition_kind")}='immediate-publish'
            JOIN {source.Table(tables[Revision])} previous_revision ON {H("id")}={F("article_revision_id")}
                AND {H("article_id")}={A("id")} AND {H("revision_no")}=1
            JOIN {source.Table(principals)} first_author ON first_author.{source.Field(principals, "id")}={H("created_by_admin_principal_id")}
            JOIN {source.Table(tables[RightsSnapshot])} rights ON {S("id")}={P("rights_snapshot_id")}
                AND {S("article_id")}={A("id")} AND {S("article_revision_id")}={R("id")} AND {S("revision_no")}=2
            WHERE {E("event_type")}='updated' AND {E("status")}='processed' AND {E("schema_version")}=2
                AND {R("created_by_admin_principal_id")}>0 AND {R("rollback_source_revision_id")} IS NULL AND {R("rollback_reason")} IS NULL
                AND {H("created_by_admin_principal_id")}>0 AND {H("rollback_source_revision_id")} IS NULL AND {H("rollback_reason")} IS NULL
                AND {H("summary")} IS NOT NULL AND {H("cover_image_url")} IS NOT NULL
                AND {R("summary")} IS NOT NULL AND {R("cover_image_url")} IS NOT NULL
                AND {P("responsibility_snapshot_id")} IS NULL AND {S("id")}={E("rights_snapshot_id")}
                AND {S("canonical_url")} IS NULL
                AND {F("published_at")}={A("createtime")} AND {F("published_at")}={H("created_at")}
                AND {F("published_at")}<{E("created_at")} AND {R("created_at")}={E("created_at")}
                AND {P("published_at")}={E("created_at")} AND {P("created_at")}={E("created_at")} AND {S("created_at")}={E("created_at")}
            ORDER BY {E("id")} LIMIT {RehearsalLimit + 1}
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var result = new Dictionary<long, LegacyRepublishEvidence>();
        var count = 0;
        while (await rows.ReadAsync(ct))
        {
            if (++count > RehearsalLimit)
                throw new InvalidOperationException($"Legacy republish outbox count exceeds the {RehearsalLimit}-row observation limit.");
            if (rows.IsDBNull(4) || rows.GetInt32(5) <= 0 || rows.GetInt32(10) <= 0) continue;
            var firstAt = rows.GetDateTime(4);
            if (!HasOrdinaryRepublishRights(rows, firstAt)) continue;
            result.Add(rows.GetInt64(0), new LegacyRepublishEvidence(rows.GetInt64(3), firstAt, rows.GetInt32(5),
                ParseLegacyOutboxTags(rows.GetString(6))));
        }
        return result;
    }

    private static bool HasOrdinaryRepublishRights(DbDataReader rows, DateTime firstAt)
    {
        int article = rows.GetInt32(1);
        long sourceRevision = rows.GetInt64(2);
        int? year = rows.IsDBNull(18) ? null : rows.GetInt32(18);
        string? Text(int field) => rows.IsDBNull(field) ? null : rows.GetString(field);
        var license = Text(16);
        var copyPolicy = Text(21);
        if (article <= 0 || sourceRevision <= 0 || year == 0 || string.IsNullOrWhiteSpace(license) ||
            string.IsNullOrWhiteSpace(copyPolicy) || rows.IsDBNull(22) || rows.GetInt32(22) < 0 || rows.IsDBNull(23) || rows.IsDBNull(24))
            return false;

        // The ordinary writer reloads persisted first publication time before writing the new policy and event.
        var published = new DateTimeOffset(DateTime.SpecifyKind(firstAt, DateTimeKind.Utc));
        var content = ArticleCanonicalHashesV1.ContentDigest(new(article, sourceRevision, 2,
            FormattableString.Invariant($"article:{article}"), rows.GetString(7), Text(8), Text(9), rows.GetInt32(10),
            ParseLegacyOutboxTags(rows.GetString(11)), 2, published, null, rows.GetString(12)));
        if (content != Text(14)) return false;
        var policy = ArticleCanonicalHashesV1.PolicyDigest(new(article, sourceRevision, 2, license, Text(17), year,
            Text(19), Text(20), copyPolicy, rows.GetInt32(22), rows.GetBoolean(23), rows.GetBoolean(24), Text(13), content));
        return policy == Text(15);
    }

    private static int[] ParseLegacyOutboxTags(string tags) => tags.Length == 0 ? [] : tags.Split(',').Select(ParseRevisionTag).ToArray();
}
