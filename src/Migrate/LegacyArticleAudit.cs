using System.Buffers.Binary;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

internal static partial class Migration
{
    private const int MaxLegacyRowsPerTable = 500_000;
    private const int MaxLegacyTextBytes = 2_000_000;
    private const string Article = "article";
    private const string Body = "article_body";
    private const string Revision = "article_revision";
    private const string Block = "article_revision_content_block";
    private const string Publication = "article_publication";
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    // Physical names from the pinned v1 entities and publication/content-block migration definitions.
    // The first field in each projection is the stable source key.
    private static readonly Dictionary<string, string[]> LegacyColumns = new(StringComparer.Ordinal)
    {
        [Article] = ["id", "title", "summary", "coverimageurl", "categoryid", "createtime", "metadata_updated_at",
            "isdeleted", "status", "current_revision_id", "current_publication_id", "scheduled_publish_at",
            "pending_publication_at", "published_at", "last_published_at", "public_updated_at", "archived_at", "deleted_at"],
        [Body] = ["article_id", "markdown_content", "updated_at"],
        [Revision] = ["id", "article_id", "revision_no", "title", "summary", "cover_image_url", "categoryid", "tag_ids",
            "content_block_id", "markdown_content", "diff_summary", "created_by_admin_principal_id",
            "rollback_source_revision_id", "rollback_reason", "created_at"],
        [Block] = ["id", "content_hash", "markdown_content", "byte_length", "created_at"],
        [Publication] = ["id", "article_id", "publication_no", "article_revision_id", "revision_no", "rights_snapshot_id",
            "responsibility_snapshot_id", "transition_kind", "published_at", "created_at"],
        [Category] = ["id", "name", "description"],
        [Tag] = ["id", "name", "description"],
        [ArticleTag] = ["articleid", "tagid"],
        [TagAlias] = ["normalized_name", "tag_id", "original_name", "created_at_utc"],
        [RightsPolicy] = ["id", "article_id", "enabled", "license_type", "copyright_holder", "copyright_year",
            "rights_statement", "attribution_template", "copy_policy", "max_excerpt_chars", "allow_code_copy",
            "show_public_badge", "proof_binding_enabled", "created_at", "updated_at"],
        [RightsSnapshot] = ["id", "article_id", "article_revision_id", "revision_no", "article_rights_policy_id",
            "enabled", "license_type", "copyright_holder", "copyright_year", "rights_statement", "attribution_template",
            "copy_policy", "max_excerpt_chars", "allow_code_copy", "show_public_badge", "proof_binding_enabled",
            "canonical_url", "policy_hash", "content_canonical_hash", "created_at"],
        [Responsibility] = ["id", "article_id", "article_revision_id", "revision_no", "responsibility_version",
            "previous_snapshot_id", "inherit_site_author", "authors_json", "reviewer_json", "sources_json",
            "update_summary", "update_reason", "effective_at", "conclusion_impact", "methodology", "applicability",
            "limitations", "responsible_person_confirmed", "created_at"]
    };

    private sealed record LegacyIssue(string Kind, long Count);
    private sealed record LegacyProjection(string Table, long Rows, string? Sha256);
    private sealed record LegacyAudit(List<LegacyProjection> Projections, List<LegacyIssue> Issues);

    private static async Task<LegacyAudit> AuditLegacyAsync(LegacySource source, DbTransaction transaction,
        Dictionary<string, LegacyTable> tables, bool plan, CancellationToken token)
    {
        var issues = new List<LegacyIssue>();
        var projections = new List<LegacyProjection>();

        string T(string key) => source.Table(tables[key]);
        string C(string key, string alias, string col) => $"{alias}.{source.Field(tables[key], col)}";
        string A(string col) => C(Article, "a", col);
        string B(string col) => C(Body, "b", col);
        string R(string col) => C(Revision, "r", col);
        string X(string col) => C(Block, "x", col);
        string P(string col) => C(Publication, "p", col);

        foreach (var (key, columns) in LegacyColumns)
        {
            var rows = await CountAsync($"FROM {T(key)}", transaction, token);
            projections.Add(new LegacyProjection(key, rows, null));
            if (rows > MaxLegacyRowsPerTable)
                issues.Add(new LegacyIssue($"table exceeds intake row budget: {key}", rows));

            if (!plan || issues.Count != 0)
                continue;

            var keys = LegacyKeyColumns(key).Select(column => C(key, "t", column)).ToArray();
            var badKey = key == TagAlias ? $"{keys[0]} IS NULL OR {keys[0]} = ''"
                : string.Join(" OR ", keys.Select(id => $"{id} IS NULL OR {id} <= 0"));
            await FindingAsync($"missing or invalid row key: {key}", $"FROM {T(key)} t WHERE {badKey}");
            var grouping = string.Join(", ", keys);
            await FindingAsync($"duplicate row key: {key}",
                $"FROM (SELECT {grouping} FROM {T(key)} t GROUP BY {grouping} HAVING COUNT(*) > 1) duplicates");
            if (source.Provider == "sqlite")
            {
                var invalid = columns.Select(column => source.InvalidStorage(C(key, "t", column),
                    IsLegacyText(column), IsLegacyTimestamp(column), IsLegacyBoolean(column)));
                await FindingAsync($"incorrect SQLite storage type: {key}", $"FROM {T(key)} t WHERE {string.Join(" OR ", invalid)}");
            }
        }

        if (!plan || issues.Count != 0)
            return new LegacyAudit(projections, issues);

        await FindingAsync("article identity outside v1 Int32 range or invalid lifecycle status",
            $"FROM {T(Article)} a WHERE {A("id")} > 2147483647 OR {A("isdeleted")} IS NULL OR {A("status")} IS NULL OR {A("status")} NOT BETWEEN 0 AND 4");
        await FindingAsync("article body refers to an absent article",
            $"FROM {T(Body)} b LEFT JOIN {T(Article)} a ON {A("id")} = {B("article_id")} WHERE {A("id")} IS NULL");
        await FindingAsync("article has no stored body",
            $"FROM {T(Article)} a LEFT JOIN {T(Body)} b ON {A("id")} = {B("article_id")} WHERE {B("article_id")} IS NULL OR {B("markdown_content")} IS NULL");
        await FindingAsync("article current revision missing or points to another article",
            $"FROM {T(Article)} a LEFT JOIN {T(Revision)} r ON {R("id")} = {A("current_revision_id")} AND {R("article_id")} = {A("id")} WHERE {R("id")} IS NULL");
        await FindingAsync("article current publication missing or points to another article",
            $"""
            FROM {T(Article)} a
            LEFT JOIN {T(Publication)} p ON {P("id")} = {A("current_publication_id")} AND {P("article_id")} = {A("id")}
            WHERE ({A("status")} = 2 AND {A("isdeleted")} = false OR {A("current_publication_id")} IS NOT NULL)
              AND {P("id")} IS NULL
            """);
        await FindingAsync("revision missing parent article, immutable content block or Int32 revision number",
            $"""
            FROM {T(Revision)} r LEFT JOIN {T(Article)} a ON {A("id")} = {R("article_id")}
            LEFT JOIN {T(Block)} x ON {X("id")} = {R("content_block_id")}
            WHERE {A("id")} IS NULL OR {X("id")} IS NULL OR {R("revision_no")} IS NULL OR {R("revision_no")} NOT BETWEEN 1 AND 2147483647
            """);
        await FindingAsync("duplicate article revision number",
            $"FROM (SELECT {R("article_id")}, {R("revision_no")} FROM {T(Revision)} r GROUP BY {R("article_id")}, {R("revision_no")} HAVING COUNT(*) > 1) duplicates");
        await FindingAsync("publication missing parent article, matching revision or required coordinate",
            $"""
            FROM {T(Publication)} p LEFT JOIN {T(Article)} a ON {A("id")} = {P("article_id")}
            LEFT JOIN {T(Revision)} r ON {R("id")} = {P("article_revision_id")}
                 AND {R("article_id")} = {P("article_id")} AND {R("revision_no")} = {P("revision_no")}
            WHERE {A("id")} IS NULL OR {R("id")} IS NULL OR {P("publication_no")} IS NULL
                  OR {P("publication_no")} NOT BETWEEN 1 AND 2147483647
                  OR {P("rights_snapshot_id")} IS NULL OR {P("rights_snapshot_id")} <= 0
            """);
        await FindingAsync("duplicate article publication number",
            $"FROM (SELECT {P("article_id")}, {P("publication_no")} FROM {T(Publication)} p GROUP BY {P("article_id")}, {P("publication_no")} HAVING COUNT(*) > 1) duplicates");
        await AuditLegacyReleaseReferencesAsync(source, transaction, tables, issues, token);

        for (var i = 0; i < projections.Count; i++)
        {
            var projection = projections[i];
            var result = await FingerprintLegacyAsync(source, transaction, projection.Table, tables[projection.Table], token);
            if (result.Oversized != 0)
                issues.Add(new LegacyIssue($"text exceeds intake byte budget: {projection.Table}", result.Oversized));
            if (result.BadContentHashes != 0)
                issues.Add(new LegacyIssue(projection.Table == Block
                    ? "immutable block byte count or SHA-256 mismatch" : "unrecognized legacy rights snapshot hash representation",
                    result.BadContentHashes));
            projections[i] = projection with { Sha256 = result.Digest };
        }

        return new LegacyAudit(projections, issues);

        async Task FindingAsync(string kind, string sql)
        {
            var count = await CountAsync(sql, transaction, token);
            if (count != 0) issues.Add(new LegacyIssue(kind, count));
        }
    }

    private static async Task<long> CountAsync(string from, DbTransaction transaction, CancellationToken token)
    {
        await using var command = CreateLegacyCommand(transaction, "SELECT COUNT(*) " + from);
        return Convert.ToInt64(await command.ExecuteScalarAsync(token), CultureInfo.InvariantCulture);
    }

    private static async Task<(string? Digest, long Oversized, long BadContentHashes)> FingerprintLegacyAsync(
        LegacySource source, DbTransaction transaction, string name, LegacyTable table, CancellationToken token)
    {
        var columns = LegacyColumns[name].Select(col => source.Field(table, col)).ToArray();
        var text = columns.Where((_, index) => IsLegacyText(LegacyColumns[name][index])).ToArray();
        var qualified = source.Table(table);
        var oversized = text.Length == 0 ? 0 : await CountAsync("FROM " + qualified + " WHERE " +
            string.Join(" OR ", text.Select(field => $"{source.Utf8Length(field)} > {MaxLegacyTextBytes}")), transaction, token);
        if (oversized != 0)
            return (null, oversized, 0);

        using var data = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(data, name);
        foreach (var field in LegacyColumns[name]) AppendLegacyValue(data, field);

        long badHashes = 0;
        var policyHashIndex = Array.IndexOf(LegacyColumns[name], "policy_hash");
        var canonicalHashIndex = Array.IndexOf(LegacyColumns[name], "content_canonical_hash");
        await using var command = CreateLegacyCommand(transaction,
            $"SELECT {string.Join(", ", columns)} FROM {qualified} ORDER BY {LegacySort(source, table, name)}");
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token);
        while (await reader.ReadAsync(token))
        {
            token.ThrowIfCancellationRequested();
            var values = new object?[columns.Length];
            for (var i = 0; i < values.Length; i++)
            {
                values[i] = await reader.IsDBNullAsync(i, token) ? null : reader.GetValue(i);
                AppendLegacyValue(data, values[i]);
            }
            if (name == Block && !LegacyBlockMatches(values))
                badHashes++;
            if (name == RightsSnapshot &&
                (!IsStoredRightsHash(values[policyHashIndex] as string, "rights-v3:policy-hash:recompute") ||
                 !IsStoredRightsHash(values[canonicalHashIndex] as string, "rights-v3:content-hash:recompute")))
                badHashes++;
        }

        return (Convert.ToHexStringLower(data.GetHashAndReset()), 0, badHashes);
    }

    private static bool LegacyBlockMatches(object?[] values)
    {
        if (values[1] is not string { Length: 64 } expected || !expected.All(char.IsAsciiHexDigit) ||
            values[2] is not string markdown || values[3] is not (int or long))
            return false;

        var bytes = StrictUtf8.GetBytes(markdown);
        return bytes.LongLength == Convert.ToInt64(values[3], CultureInfo.InvariantCulture) &&
            Convert.ToHexString(SHA256.HashData(bytes)).Equals(expected, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsLegacyText(string name) => name is "title" or "summary" or "coverimageurl" or "cover_image_url"
        or "tag_ids" or "markdown_content" or "diff_summary" or "rollback_reason" or "content_hash" or "transition_kind"
        || IsLegacyReleaseText(name);

    private static bool IsLegacyTimestamp(string name) => name == "createtime" || name.EndsWith("_at", StringComparison.Ordinal)
        || name.EndsWith("_at_utc", StringComparison.Ordinal);

    private static void AppendLegacyValue(IncrementalHash data, object? value)
    {
        var (kind, text) = value switch
        {
            null => ((byte)'n', ""),
            string s => ((byte)'s', s),
            bool b => ((byte)'b', b ? "1" : "0"),
            int or long or short or byte or sbyte or uint or ulong or ushort
                => ((byte)'i', Convert.ToString(value, CultureInfo.InvariantCulture)!),
            DateTime dt => ((byte)'t', dt.ToString("O", CultureInfo.InvariantCulture)),
            DateTimeOffset dt => ((byte)'t', dt.ToString("O", CultureInfo.InvariantCulture)),
            _ => throw new InvalidOperationException("Legacy column contains an unsupported runtime type.")
        };
        var bytes = StrictUtf8.GetBytes(text);
        Span<byte> prefix = stackalloc byte[5];
        prefix[0] = kind;
        BinaryPrimitives.WriteInt32BigEndian(prefix[1..], bytes.Length);
        data.AppendData(prefix);
        data.AppendData(bytes);
    }
}
