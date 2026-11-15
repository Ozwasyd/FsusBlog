using System.Globalization;
using FsusBlog.V2.Contracts;
using Npgsql;

internal static partial class Migration
{
    private static readonly string[] LegacyRightsTimestampFormats =
    [
        "yyyy-MM-dd HH:mm:ssK", "yyyy-MM-dd HH:mm:ss.FFFFFFFK",
        "yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"
    ];

    private static async Task<int> VerifyProjectedLegacyRightsAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        bool hasRepublishOutbox, CancellationToken token)
    {
        var ordinary = hasRepublishOutbox ? $"""
            EXISTS (SELECT FROM {ImportSchema}.{LegacyOutboxParent.Table.Name} event
                WHERE event.event_type='updated' AND event.publication_no=2 AND event.article_publication_id=p.source_publication_id)
            """ : "false";
        await using var command = new NpgsqlCommand($"""
            SELECT p.article_id,p.source_revision_id,p.revision,p.source_transition,p.published_at,
                   r.title,r.body,r.summary,r.cover_image_url,r.source_category_id,r.source_tag_ids,
                   s.id,s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,
                   s.attribution_template,s.copy_policy,s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,
                   s.proof_binding_enabled,s.canonical_url,s.content_canonical_hash,s.policy_hash,first.published_at,
                   p.publication_number,a.published_at,p.source_created_at,r.happened_at,s.created_at,{ordinary}
            FROM {ImportSchema}.shadow_publication p
            LEFT JOIN {ImportSchema}.shadow_revision r ON r.source_revision_id=p.source_revision_id
                AND r.article_id=p.article_id AND r.revision=p.revision
            LEFT JOIN {ImportSchema}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
                AND s.article_id=p.article_id AND s.article_revision_id=p.source_revision_id AND s.revision_no=p.revision
            LEFT JOIN {ImportSchema}.shadow_publication first ON first.article_id=p.article_id AND first.publication_number=1
            LEFT JOIN {ImportSchema}.shadow_article a ON a.id=p.article_id
            ORDER BY p.article_id,p.publication_number
            """, target, tx);
        await using var rows = await command.ExecuteReaderAsync(token);
        var sources = new HashSet<long>();
        var republished = 0;
        while (await rows.ReadAsync(token))
        {
            if (rows.IsDBNull(11) || rows.IsDBNull(5) || rows.IsDBNull(6) || rows.IsDBNull(10))
                throw new InvalidOperationException("A legacy publication lacks its exact revision or rights snapshot.");
            var transition = LegacyRightsText(rows, 3);
            if (transition is not ("immediate-publish" or "rollback"))
                throw new InvalidOperationException("A legacy publication requires unsupported historical rights coordinates.");
            var snapshot = rows.GetInt64(11);
            if (snapshot <= 0 || !sources.Add(snapshot))
                throw new InvalidOperationException("A legacy rights snapshot is bound to more than one publication or has invalid identity.");

            // The production update path binds the first release time; the lifecycle writer binds the actual release time.
            var eventAt = LegacyRightsText(rows, 4);
            var firstAt = LegacyRightsText(rows, 26);
            var expectedContent = LegacyRightsText(rows, 24);
            var ordinaryRepublish = rows.GetBoolean(32);
            if (ordinaryRepublish && (transition != "immediate-publish" || rows.GetInt64(27) != 2 ||
                !CanVerifyLegacyRepublish(rows, firstAt, eventAt)))
                throw new InvalidOperationException("A retained legacy republish event lacks its original first and second release coordinates.");
            var content = LegacyRevisionContentHash(rows, status: 2,
                transition == "rollback" || ordinaryRepublish ? firstAt : eventAt, scheduledAt: null);
            if (!ordinaryRepublish && transition == "immediate-publish" && content != expectedContent && rows.GetInt64(27) > 1 &&
                CanVerifyLegacyRepublish(rows, firstAt, eventAt))
                content = LegacyRevisionContentHash(rows, status: 2, firstAt, scheduledAt: null);
            VerifyLegacyRevisionRightsHashes(rows, content, "publication");
            if (ordinaryRepublish) republished++;
        }
        return republished;
    }

    // Both frozen sources select the same canonical revision and policy coordinates.
    private static string LegacyRevisionContentHash(NpgsqlDataReader rows, int status, string? publishedAt, string? scheduledAt)
    {
        int article = LegacyRightsInt(rows, 0);
        long sourceRevision = rows.GetInt64(1);
        int revision = LegacyRightsInt(rows, 2);
        int category = LegacyRightsInt(rows, 9);
        if (article <= 0 || sourceRevision <= 0 || revision <= 0 || category <= 0)
            throw new InvalidOperationException("A legacy immutable rights snapshot has invalid canonical coordinates.");
        var tagCsv = rows.GetString(10);
        var tags = tagCsv.Length == 0 ? [] : tagCsv.Split(',').Select(ParseRevisionTag).ToArray();
        return ArticleCanonicalHashesV1.ContentDigest(new(article, sourceRevision, revision,
            FormattableString.Invariant($"article:{article}"), rows.GetString(5), LegacyRightsText(rows, 7),
            LegacyRightsText(rows, 8), category, tags, status,
            publishedAt is null ? null : ParseLegacyProjectionTimestamp(publishedAt),
            scheduledAt is null ? null : ParseLegacyProjectionTimestamp(scheduledAt), rows.GetString(6)));
    }

    private static void VerifyLegacyRevisionRightsHashes(NpgsqlDataReader rows, string content, string authority)
    {
        if (content != LegacyRightsText(rows, 24))
            throw new InvalidOperationException($"A legacy {authority}'s recorded canonical content SHA-256 does not match its frozen revision.");
        int article = LegacyRightsInt(rows, 0);
        long sourceRevision = rows.GetInt64(1);
        int revision = LegacyRightsInt(rows, 2);
        var holder = LegacyRightsText(rows, 14);
        int? year = rows.IsDBNull(15) ? null : LegacyRightsInt(rows, 15);
        var statement = LegacyRightsText(rows, 16);
        var attribution = LegacyRightsText(rows, 17);
        if (year == 0)
            throw new InvalidOperationException($"A legacy {authority} copyright year collides with the current unset sentinel.");
        var rights = new ArticleRightsPolicy(article, revision, true, LegacyRightsBoolean(rows, 12),
            LegacyRightsText(rows, 13) ?? "", holder ?? "", year ?? 0, statement ?? "", attribution ?? "",
            LegacyRightsText(rows, 18) ?? "", LegacyRightsInt(rows, 19), LegacyRightsBoolean(rows, 20),
            LegacyRightsBoolean(rows, 21), LegacyRightsBoolean(rows, 22));
        try { Wire.Validate(rights); }
        catch (ProtocolException)
        {
            throw new InvalidOperationException($"A legacy {authority} rights policy cannot be represented by the current contract.");
        }

        var policy = ArticleCanonicalHashesV1.PolicyDigest(new(article, sourceRevision, revision,
            rights.LicenseType, holder, year, statement, attribution, rights.CopyPolicy, rights.MaxExcerptChars,
            rights.AllowCodeCopy, rights.ShowPublicBadge, LegacyRightsText(rows, 23), content));
        if (policy != LegacyRightsText(rows, 25))
            throw new InvalidOperationException($"A legacy {authority}'s recorded rights policy SHA-256 does not match its frozen snapshot.");
    }

    private static bool CanVerifyLegacyRepublish(NpgsqlDataReader row, string? firstAt, string? eventAt)
    {
        if (firstAt is null || eventAt is null || row.IsDBNull(28) || row.IsDBNull(29) || row.IsDBNull(30) || row.IsDBNull(31))
            return false;
        var first = ParseLegacyProjectionTimestamp(firstAt);
        var actual = ParseLegacyProjectionTimestamp(eventAt);
        return first < actual && first == ParseLegacyProjectionTimestamp(row.GetString(28)) &&
               actual == ParseLegacyProjectionTimestamp(row.GetString(29)) &&
               actual == ParseLegacyProjectionTimestamp(row.GetString(30)) &&
               actual == ParseLegacyProjectionTimestamp(row.GetString(31));
    }

    private static string? LegacyRightsText(NpgsqlDataReader row, int ordinal) =>
        row.IsDBNull(ordinal) ? null : row.GetString(ordinal);

    private static int LegacyRightsInt(NpgsqlDataReader row, int ordinal)
    {
        if (!row.IsDBNull(ordinal))
        {
            long value = row.GetInt64(ordinal);
            if (value is >= int.MinValue and <= int.MaxValue) return (int)value;
        }
        throw new InvalidOperationException("A legacy publication has an out-of-range canonical integer.");
    }

    private static bool LegacyRightsBoolean(NpgsqlDataReader row, int ordinal) =>
        (row.IsDBNull(ordinal) ? -1 : row.GetInt64(ordinal)) switch
        {
            0 => false,
            1 => true,
            _ => throw new InvalidOperationException("A legacy publication has an invalid frozen rights flag.")
        };

    private static DateTimeOffset ParseLegacyProjectionTimestamp(string? value)
    {
        if (!DateTimeOffset.TryParseExact(value, LegacyRightsTimestampFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var utc) || utc.Ticks % 10 != 0)
            throw new InvalidOperationException("A legacy projection timestamp cannot be represented exactly in PostgreSQL.");
        return utc;
    }
}
