using System.Data.Common;
using FsusBlog.V2.Contracts;

internal static partial class Migration
{
    private sealed record LegacyPublishedOutboxUpdate(int PublicationNumber, long PreviousReleaseId, DateTime PreviousReleaseAt,
        int BeforeCategory, int[] BeforeTags);

    private static async Task<Dictionary<long, LegacyPublishedOutboxUpdate>> ReadLegacyOrdinaryRepublishAsync(LegacySource source,
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
                {H("categoryid")}, {H("tag_ids")}, {LegacyPublishedRightsFields(R, B, S)}
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
        var result = new Dictionary<long, LegacyPublishedOutboxUpdate>();
        var count = 0;
        while (await rows.ReadAsync(ct))
        {
            if (++count > RehearsalLimit)
                throw new InvalidOperationException($"Legacy republish outbox count exceeds the {RehearsalLimit}-row observation limit.");
            if (rows.IsDBNull(4) || rows.IsDBNull(5) || rows.GetInt32(5) <= 0) continue;
            var firstAt = rows.GetDateTime(4);
            if (!HasCanonicalLegacyOutboxRights(rows, 7, rows.GetInt32(1), rows.GetInt64(2), 2, firstAt)) continue;
            result.Add(rows.GetInt64(0), new LegacyPublishedOutboxUpdate(2, rows.GetInt64(3), firstAt, rows.GetInt32(5),
                ParseLegacyOutboxTags(rows.GetString(6))));
        }
        return result;
    }

    private static string LegacyPublishedRightsFields(Func<string, string> revision, Func<string, string> body,
        Func<string, string> rights) => string.Join(',',
        new[] { "title", "summary", "cover_image_url", "categoryid", "tag_ids" }.Select(revision)
            .Append(body("markdown_content"))
            .Concat(new[] { "canonical_url", "content_canonical_hash", "policy_hash", "license_type", "copyright_holder",
                "copyright_year", "rights_statement", "attribution_template", "copy_policy", "max_excerpt_chars",
                "allow_code_copy", "show_public_badge" }.Select(rights)));

    private static bool HasCanonicalLegacyOutboxRights(DbDataReader rows, int offset, int article, long sourceRevision,
        int revision, DateTime firstAt)
    {
        int Number(int field) => rows.GetInt32(offset + field);
        bool Missing(int field) => rows.IsDBNull(offset + field);
        string? Text(int field) => Missing(field) ? null : rows.GetString(offset + field);
        int? year = Missing(11) ? null : Number(11);
        var license = Text(9);
        var copyPolicy = Text(14);
        if (article <= 0 || sourceRevision <= 0 || year == 0 || string.IsNullOrWhiteSpace(license) ||
            string.IsNullOrWhiteSpace(copyPolicy) || Missing(15) || Number(15) < 0 || Missing(16) || Missing(17) ||
            Missing(3) || Number(3) <= 0 || Text(0) is not { } title || Text(4) is not { } tags || Text(5) is not { } markdown)
            return false;

        // The ordinary writer reloads persisted first publication time before writing the new policy and event.
        var published = new DateTimeOffset(DateTime.SpecifyKind(firstAt, DateTimeKind.Utc));
        var content = ArticleCanonicalHashesV1.ContentDigest(new(article, sourceRevision, revision,
            FormattableString.Invariant($"article:{article}"), title, Text(1), Text(2), Number(3),
            ParseLegacyOutboxTags(tags), 2, published, null, markdown));
        if (content != Text(7)) return false;
        var policy = ArticleCanonicalHashesV1.PolicyDigest(new(article, sourceRevision, revision, license, Text(10), year,
            Text(12), Text(13), copyPolicy, Number(15), rows.GetBoolean(offset + 16), rows.GetBoolean(offset + 17), Text(6), content));
        return policy == Text(8);
    }

    private static int[] ParseLegacyOutboxTags(string tags) => tags.Length == 0 ? [] : tags.Split(',').Select(ParseRevisionTag).ToArray();
}
