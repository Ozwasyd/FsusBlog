using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using Npgsql;

internal static partial class Migration
{
    private static readonly string[] LegacyRightsTimestampFormats =
    [
        "yyyy-MM-dd HH:mm:ssK", "yyyy-MM-dd HH:mm:ss.FFFFFFFK",
        "yyyy-MM-dd'T'HH:mm:ssK", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"
    ];

    private static async Task VerifyProjectedLegacyRightsAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand($"""
            SELECT p.article_id,p.source_revision_id,p.revision,p.source_transition,p.published_at,
                   r.title,r.body,r.summary,r.cover_image_url,r.source_category_id,r.source_tag_ids,
                   s.id,s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,
                   s.attribution_template,s.copy_policy,s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,
                   s.proof_binding_enabled,s.canonical_url,s.content_canonical_hash,s.policy_hash
            FROM {ImportSchema}.shadow_publication p
            LEFT JOIN {ImportSchema}.shadow_revision r ON r.source_revision_id=p.source_revision_id
                AND r.article_id=p.article_id AND r.revision=p.revision
            LEFT JOIN {ImportSchema}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
                AND s.article_id=p.article_id AND s.article_revision_id=p.source_revision_id AND s.revision_no=p.revision
            ORDER BY p.article_id,p.publication_number
            """, target, tx);
        await using var rows = await command.ExecuteReaderAsync(token);
        var sources = new HashSet<long>();
        while (await rows.ReadAsync(token))
        {
            if (rows.IsDBNull(11) || rows.IsDBNull(5) || rows.IsDBNull(6) || rows.IsDBNull(10))
                throw new InvalidOperationException("A legacy publication lacks its exact revision or rights snapshot.");
            if (LegacyRightsText(rows, 3) != "immediate-publish")
                throw new InvalidOperationException("A legacy publication requires unsupported historical rights coordinates.");
            var snapshot = rows.GetInt64(11);
            if (snapshot <= 0 || !sources.Add(snapshot))
                throw new InvalidOperationException("A legacy rights snapshot is bound to more than one publication or has invalid identity.");

            int article = LegacyRightsInt(rows, 0);
            long sourceRevision = rows.GetInt64(1);
            int revision = LegacyRightsInt(rows, 2);
            int category = LegacyRightsInt(rows, 9);
            if (article <= 0 || sourceRevision <= 0 || revision <= 0 || category <= 0)
                throw new InvalidOperationException("A legacy publication has invalid canonical coordinates.");
            var published = LegacyRightsTime(LegacyRightsText(rows, 4));
            var tagCsv = rows.GetString(10);
            int[] tags = tagCsv.Length == 0 ? [] : tagCsv.Split(',').Select(ParseRevisionTag).Distinct().Order().ToArray();

            var content = LegacyRightsSha256(
                "fsusblog.integrity.article-canonical.v1",
                "hashVersion:i:1",
                LegacyRightsInteger("articleId", article),
                LegacyRightsInteger("articleRevisionId", sourceRevision),
                LegacyRightsInteger("revisionNo", revision),
                LegacyRightsString("publicRouteKey", FormattableString.Invariant($"article:{article}")),
                LegacyRightsString("title", rows.GetString(5)),
                LegacyRightsString("summary", LegacyRightsText(rows, 7)),
                LegacyRightsString("coverImageUrl", LegacyRightsText(rows, 8)),
                LegacyRightsInteger("categoryId", category),
                "tagIds:i:" + string.Join(',', tags.Select(tag => tag.ToString(CultureInfo.InvariantCulture))),
                "status:i:2",
                "publishedAt:t:" + published,
                "scheduledPublishAt:n",
                LegacyRightsString("markdown", rows.GetString(6)));
            if (content != LegacyRightsText(rows, 24))
                throw new InvalidOperationException("A legacy publication's recorded canonical content SHA-256 does not match its frozen revision.");

            var holder = LegacyRightsText(rows, 14);
            int? year = rows.IsDBNull(15) ? null : LegacyRightsInt(rows, 15);
            var statement = LegacyRightsText(rows, 16);
            var attribution = LegacyRightsText(rows, 17);
            if (year == 0)
                throw new InvalidOperationException("A legacy publication copyright year collides with the current unset sentinel.");
            var rights = new ArticleRightsPolicy(article, revision, true, LegacyRightsBoolean(rows, 12),
                LegacyRightsText(rows, 13) ?? "", holder ?? "", year ?? 0, statement ?? "", attribution ?? "",
                LegacyRightsText(rows, 18) ?? "", LegacyRightsInt(rows, 19), LegacyRightsBoolean(rows, 20),
                LegacyRightsBoolean(rows, 21), LegacyRightsBoolean(rows, 22));
            try { Wire.Validate(rights); }
            catch (ProtocolException)
            {
                throw new InvalidOperationException("A legacy publication rights policy cannot be represented by the current contract.");
            }

            var policy = LegacyRightsSha256(
                "fsusblog.rights.article-policy.v1",
                "hashVersion:i:1",
                LegacyRightsInteger("articleId", article),
                LegacyRightsInteger("articleRevisionId", sourceRevision),
                LegacyRightsInteger("revisionNo", revision),
                LegacyRightsString("licenseType", rights.LicenseType),
                LegacyRightsString("copyrightHolder", holder),
                year is { } value ? LegacyRightsInteger("copyrightYear", value) : "copyrightYear:n",
                LegacyRightsString("rightsStatement", statement),
                LegacyRightsString("attributionTemplate", attribution),
                LegacyRightsString("copyPolicy", rights.CopyPolicy),
                LegacyRightsInteger("maxExcerptChars", rights.MaxExcerptChars),
                rights.AllowCodeCopy ? "allowCodeCopy:b:1" : "allowCodeCopy:b:0",
                rights.ShowPublicBadge ? "showPublicBadge:b:1" : "showPublicBadge:b:0",
                LegacyRightsString("canonicalUrl", LegacyRightsText(rows, 23)),
                "contentCanonicalHash:h:" + content);
            if (policy != LegacyRightsText(rows, 25))
                throw new InvalidOperationException("A legacy publication's recorded rights policy SHA-256 does not match its frozen snapshot.");
        }
    }

    // The two payloads follow ArticleCanonicalHashV1 and ArticleRightsCanonicalHashV1 at LegacyReference.
    private static string LegacyRightsSha256(params string[] lines) =>
        "sha256:" + Convert.ToHexStringLower(SHA256.HashData(StrictUtf8.GetBytes(string.Join('\n', lines) + '\n')));

    private static string LegacyRightsString(string field, string? value) => value is null ? field + ":n" :
        field + ":s:" + Convert.ToBase64String(StrictUtf8.GetBytes(value.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n').Normalize(NormalizationForm.FormC)));

    private static string LegacyRightsInteger(string field, long value) =>
        field + ":i:" + value.ToString(CultureInfo.InvariantCulture);

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

    private static string LegacyRightsTime(string? value) =>
        ParseLegacyProjectionTimestamp(value).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
}
