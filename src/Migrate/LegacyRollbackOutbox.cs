using System.Data.Common;
using Npgsql;

internal static partial class Migration
{
    private static async Task<Dictionary<long, LegacyPublishedOutboxUpdate>> ReadLegacyPublishedRollbackOutboxAsync(LegacySource source,
        DbTransaction tx, Dictionary<string, LegacyTable> tables, LegacyTable principals, LegacyTable events, CancellationToken ct)
    {
        string E(string name) => "event." + source.Field(events, name);
        string Field(string table, string alias, string name) => alias + "." + source.Field(tables[table], name);
        string A(string name) => Field(Article, "article", name);
        string R(string name) => Field(Revision, "revision", name);
        string H(string name) => Field(Revision, "previous_revision", name);
        string O(string name) => Field(Revision, "original", name);
        string P(string name) => Field(Publication, "publication", name);
        string F(string name) => Field(Publication, "first_release", name);
        string V(string name) => Field(Publication, "previous_release", name);
        string S(string name) => Field(RightsSnapshot, "rights", name);
        string B(string name) => Field(Block, "body", name);
        string C(string name) => Field(Responsibility, "cloned", name);
        string SourceRights(string name) => Field(RightsSnapshot, "original_rights", name);
        string SourceBody(string name) => Field(Block, "original_body", name);

        string SameFields(string relation, string target, string original, string[] fields) =>
            $"({string.Join(',', fields.Select(name => Field(relation, target, name)))}) IS NOT DISTINCT FROM " +
            $"({string.Join(',', fields.Select(name => Field(relation, original, name)))})";

        string[] articleFields = ["title", "summary", "cover_image_url", "categoryid", "tag_ids"];
        string[] rightsFields = ["enabled", "license_type", "copyright_holder", "copyright_year", "rights_statement",
            "attribution_template", "copy_policy", "max_excerpt_chars", "allow_code_copy", "show_public_badge", "proof_binding_enabled"];
        string[] responsibilityFields = ["inherit_site_author", "authors_json", "reviewer_json", "sources_json",
            "update_summary", "update_reason", "effective_at", "conclusion_impact", "methodology", "applicability",
            "limitations", "responsible_person_confirmed"];
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {E("id")}, {A("id")}, {R("id")}, {V("id")}, {SelectRepresentableLegacyOutboxClock(F("published_at"))},
                {H("categoryid")}, {H("tag_ids")}, {LegacyPublishedRightsFields(R, B, S)},
                {SelectRepresentableLegacyOutboxClock(V("published_at"))}, {R("rollback_reason")}, {O("id")},
                {LegacyPublishedRightsFields(O, SourceBody, SourceRights)}
            FROM {source.Table(events)} event
            JOIN {source.Table(tables[Article])} article ON {A("id")}={E("aggregate_id")}
            JOIN {source.Table(tables[Revision])} revision ON {R("id")}={E("article_revision_id")}
                AND {R("article_id")}={A("id")} AND {R("revision_no")}=3
            JOIN {source.Table(tables[Block])} body ON {B("id")}={R("content_block_id")}
            JOIN {source.Table(principals)} actor ON actor.{source.Field(principals, "id")}={R("created_by_admin_principal_id")}
            JOIN {source.Table(tables[Publication])} publication ON {P("id")}={E("article_publication_id")}
                AND {P("article_id")}={A("id")} AND {P("article_revision_id")}={R("id")}
                AND {P("publication_no")}=3 AND {P("revision_no")}=3 AND {P("transition_kind")}='rollback'
            JOIN {source.Table(tables[Publication])} first_release ON {F("article_id")}={A("id")}
                AND {F("publication_no")}=1 AND {F("revision_no")}=1 AND {F("transition_kind")}='immediate-publish'
            JOIN {source.Table(tables[Revision])} original ON {O("id")}={R("rollback_source_revision_id")}
                AND {O("id")}={F("article_revision_id")} AND {O("article_id")}={A("id")} AND {O("revision_no")}=1
            JOIN {source.Table(tables[Block])} original_body ON {SourceBody("id")}={O("content_block_id")}
            JOIN {source.Table(tables[Publication])} previous_release ON {V("article_id")}={A("id")}
                AND {V("publication_no")}=2 AND {V("revision_no")}=2 AND {V("transition_kind")}='immediate-publish'
            JOIN {source.Table(tables[Revision])} previous_revision ON {H("id")}={V("article_revision_id")}
                AND {H("article_id")}={A("id")} AND {H("revision_no")}=2
            JOIN {source.Table(tables[RightsSnapshot])} rights ON {S("id")}={P("rights_snapshot_id")}
                AND {S("article_id")}={A("id")} AND {S("article_revision_id")}={R("id")} AND {S("revision_no")}=3
            JOIN {source.Table(tables[RightsSnapshot])} original_rights ON {SourceRights("id")}={F("rights_snapshot_id")}
                AND {SourceRights("article_id")}={A("id")} AND {SourceRights("article_revision_id")}={O("id")}
                AND {SourceRights("revision_no")}=1
            JOIN {source.Table(tables[Responsibility])} cloned ON {C("id")}={P("responsibility_snapshot_id")}
                AND {C("id")}={E("responsibility_snapshot_id")} AND {C("article_id")}={A("id")}
                AND {C("article_revision_id")}={R("id")} AND {C("revision_no")}=3
                AND {C("responsibility_version")}=1 AND {E("responsibility_version")}=1 AND {C("previous_snapshot_id")} IS NULL
            WHERE {E("event_type")}='updated' AND {E("status")}='processed' AND {E("schema_version")}=2
                AND {R("created_by_admin_principal_id")}>0
                AND {A("status")}=2 AND {A("isdeleted")}=false AND {A("archived_at")} IS NULL AND {A("deleted_at")} IS NULL
                AND {A("scheduled_publish_at")} IS NULL AND {A("pending_publication_at")} IS NULL
                AND {A("current_revision_id")}={R("id")} AND {A("current_publication_id")}={P("id")}
                AND {A("last_published_at")}={P("published_at")} AND {A("public_updated_at")}={P("published_at")}
                AND {A("published_at")}={F("published_at")} AND {A("createtime")}={F("published_at")}
                AND {F("published_at")}<{V("published_at")} AND {V("published_at")}<{E("created_at")}
                AND {V("published_at")}={H("created_at")} AND {P("published_at")}={E("created_at")}
                AND {P("created_at")}={E("created_at")} AND {R("created_at")}={E("created_at")}
                AND {S("created_at")}={E("created_at")} AND {S("id")}={E("rights_snapshot_id")}
                AND {C("created_at")}>={E("created_at")} AND pg_catalog.isfinite({C("created_at")})
                AND {S("canonical_url")} IS NULL AND {SourceRights("canonical_url")} IS NULL
                AND {SameFields(Revision, "revision", "original", articleFields)}
                AND {B("markdown_content")}={SourceBody("markdown_content")}
                AND {SameFields(RightsSnapshot, "rights", "original_rights", rightsFields)}
                AND ({R("rollback_reason")} IS NOT NULL AND char_length({R("rollback_reason")}) BETWEEN 8 AND 500)
                AND EXISTS (
                    SELECT FROM {source.Table(tables[Responsibility])} predecessor
                    WHERE {Field(Responsibility, "predecessor", "id")}= (
                        SELECT {Field(Responsibility, "snapshot", "id")} FROM {source.Table(tables[Responsibility])} snapshot
                        WHERE {Field(Responsibility, "snapshot", "article_id")}={A("id")}
                          AND {Field(Responsibility, "snapshot", "article_revision_id")}={O("id")}
                          AND {Field(Responsibility, "snapshot", "revision_no")}=1
                          AND {Field(Responsibility, "snapshot", "created_at")}<={C("created_at")}
                        ORDER BY {Field(Responsibility, "snapshot", "responsibility_version")} DESC,
                          {Field(Responsibility, "snapshot", "id")} DESC LIMIT 1)
                      AND {SameFields(Responsibility, "cloned", "predecessor", responsibilityFields)})
            ORDER BY {E("id")} LIMIT {RehearsalLimit + 1}
            """);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var result = new Dictionary<long, LegacyPublishedOutboxUpdate>();
        var count = 0;
        while (await rows.ReadAsync(ct))
        {
            if (++count > RehearsalLimit)
                throw new InvalidOperationException($"Legacy rollback outbox count exceeds the {RehearsalLimit}-row observation limit.");
            if (rows.IsDBNull(4) || rows.IsDBNull(5) || rows.GetInt32(5) <= 0 || rows.IsDBNull(25)) continue;
            var reason = rows.GetString(26);
            var article = rows.GetInt32(1);
            var firstAt = rows.GetDateTime(4);
            if (reason.Length is < 8 or > 500 || reason != reason.Trim() ||
                !HasCanonicalLegacyOutboxRights(rows, 7, article, rows.GetInt64(2), 3, firstAt) ||
                !HasCanonicalLegacyOutboxRights(rows, 28, article, rows.GetInt64(27), 1, firstAt))
                continue;
            result.Add(rows.GetInt64(0), new LegacyPublishedOutboxUpdate(3, rows.GetInt64(3), rows.GetDateTime(25),
                rows.GetInt32(5), ParseLegacyOutboxTags(rows.GetString(6))));
        }
        return result;
    }

    private static async Task<int> CountVerifiedLegacyRollbackOutboxAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        int verifiedRollbacks, CancellationToken ct)
    {
        const string shadow = ImportSchema;
        await using var check = new NpgsqlCommand($"""
            SELECT count(*)::int,count(p.source_publication_id)::int
            FROM {shadow}.{LegacyOutboxParent.Table.Name} e
            LEFT JOIN {shadow}.shadow_publication p ON p.source_publication_id=e.article_publication_id
                AND p.article_id=e.aggregate_id AND p.source_revision_id=e.article_revision_id AND p.revision=e.revision_no
                AND p.source_rights_snapshot_id=e.rights_snapshot_id AND p.source_responsibility_snapshot_id=e.responsibility_snapshot_id
                AND p.publication_number=e.publication_no AND p.source_transition='rollback'
                AND p.published_at::timestamp=e.created_at::timestamp
            WHERE e.event_type='updated' AND e.publication_no=3
            """, target, tx);
        await using var rows = await check.ExecuteReaderAsync(ct);
        if (!await rows.ReadAsync(ct)) throw new InvalidOperationException("The legacy rollback outbox could not be measured.");
        int observed = rows.GetInt32(0);
        if (observed == 0 || observed != rows.GetInt32(1) || observed > verifiedRollbacks)
            throw new InvalidOperationException("The versioned legacy plan lacks a verified current publication for its rollback outbox events.");
        return observed;
    }
}
