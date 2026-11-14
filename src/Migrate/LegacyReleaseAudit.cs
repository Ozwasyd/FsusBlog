using System.Data.Common;
using System.Globalization;
using FsusBlog.V2.Core.Content;

internal static partial class Migration
{
    private const string Category = "category";
    private const string Tag = "tag";
    private const string ArticleTag = "article_tag";
    private const string TagAlias = "tag_url_alias";
    private const string RightsPolicy = "article_rights_policy";
    private const string RightsSnapshot = "article_rights_snapshot";
    private const string Responsibility = "article_responsibility_snapshot";

    private static string[] LegacyKeyColumns(string name) => name switch
    {
        ArticleTag => ["articleid", "tagid"],
        Body => ["article_id"],
        TagAlias => ["normalized_name"],
        _ => ["id"]
    };

    private static string LegacySort(LegacySource source, LegacyTable table, string name)
    {
        var columns = LegacyKeyColumns(name).Select(column => source.Field(table, column)).ToArray();
        if (name == TagAlias)
        {
            columns[0] = source.Provider switch
            {
                "postgres" => columns[0] + """ COLLATE "C" """,
                "mysql" => "BINARY " + columns[0],
                _ => columns[0] + " COLLATE BINARY"
            };
        }
        return string.Join(", ", columns);
    }

    private static bool IsLegacyReleaseText(string name) => name is "name" or "description" or "normalized_name" or
        "original_name" or "license_type" or "copyright_holder" or "rights_statement" or "attribution_template" or
        "copy_policy" or "canonical_url" or "policy_hash" or "content_canonical_hash" or "authors_json" or
        "reviewer_json" or "sources_json" or "update_summary" or "update_reason" or "conclusion_impact" or
        "methodology" or "applicability" or "limitations";

    private static bool IsLegacyBoolean(string name) => name is "isdeleted" or "enabled" or "allow_code_copy" or
        "show_public_badge" or "proof_binding_enabled" or "inherit_site_author" or "responsible_person_confirmed";

    private static async Task AuditLegacyReleaseReferencesAsync(LegacySource source, DbTransaction transaction,
        Dictionary<string, LegacyTable> tables, List<LegacyIssue> issues, CancellationToken token)
    {
        string T(string table) => source.Table(tables[table]);
        string C(string table, string alias, string column) => $"{alias}.{source.Field(tables[table], column)}";

        foreach (var table in new[] { Category, Tag })
        {
            await Check($"taxonomy ID exceeds Int32 or has missing name: {table}", $"""
                FROM {T(table)} t WHERE {C(table, "t", "id")} > 2147483647
                  OR {C(table, "t", "name")} IS NULL OR {C(table, "t", "name")} = ''
                """);
        }

        foreach (var table in new[] { Article, Revision })
        {
            await Check($"unmapped historical or current category identity: {table}", $"""
                FROM {T(table)} t
                LEFT JOIN {T(Category)} c ON {C(Category, "c", "id")} = {C(table, "t", "categoryid")}
                WHERE {C(table, "t", "categoryid")} IS NULL OR
                  ({C(table, "t", "categoryid")} <> 0 AND {C(Category, "c", "id")} IS NULL)
                """);
        }

        await Check("current article tag or URL alias refers to an absent source identity", $"""
            FROM (
                SELECT {C(ArticleTag, "l", "tagid")} FROM {T(ArticleTag)} l
                LEFT JOIN {T(Article)} a ON {C(Article, "a", "id")} = {C(ArticleTag, "l", "articleid")}
                LEFT JOIN {T(Tag)} t ON {C(Tag, "t", "id")} = {C(ArticleTag, "l", "tagid")}
                WHERE {C(Article, "a", "id")} IS NULL OR {C(Tag, "t", "id")} IS NULL
                UNION ALL
                SELECT {C(TagAlias, "n", "tag_id")} FROM {T(TagAlias)} n
                LEFT JOIN {T(Tag)} t ON {C(Tag, "t", "id")} = {C(TagAlias, "n", "tag_id")}
                WHERE {C(Tag, "t", "id")} IS NULL
            ) missing
            """);
        await Check("rights policy is not bound to one existing article", $"""
            FROM (
                SELECT {C(RightsPolicy, "p", "article_id")} FROM {T(RightsPolicy)} p
                LEFT JOIN {T(Article)} a ON {C(Article, "a", "id")} = {C(RightsPolicy, "p", "article_id")}
                WHERE {C(Article, "a", "id")} IS NULL
                UNION ALL
                SELECT {C(RightsPolicy, "p", "article_id")} FROM {T(RightsPolicy)} p
                GROUP BY {C(RightsPolicy, "p", "article_id")} HAVING COUNT(*) > 1
            ) missing
            """);

        foreach (var table in new[] { RightsSnapshot, Responsibility })
        {
            await Check($"snapshot article and revision coordinates differ: {table}", $"""
                FROM {T(table)} s LEFT JOIN {T(Revision)} r
                  ON {C(Revision, "r", "id")} = {C(table, "s", "article_revision_id")}
                  AND {C(Revision, "r", "article_id")} = {C(table, "s", "article_id")}
                  AND {C(Revision, "r", "revision_no")} = {C(table, "s", "revision_no")}
                WHERE {C(Revision, "r", "id")} IS NULL
                """);
        }
        await Check("immutable rights snapshot points outside its article policy", $"""
            FROM {T(RightsSnapshot)} s LEFT JOIN {T(RightsPolicy)} p
              ON {C(RightsPolicy, "p", "id")} = {C(RightsSnapshot, "s", "article_rights_policy_id")}
              AND {C(RightsPolicy, "p", "article_id")} = {C(RightsSnapshot, "s", "article_id")}
            WHERE {C(RightsPolicy, "p", "id")} IS NULL
            """);
        await Check("responsibility predecessor is outside its valid lineage", $"""
            FROM {T(Responsibility)} s LEFT JOIN {T(Responsibility)} p
              ON {C(Responsibility, "p", "id")} = {C(Responsibility, "s", "previous_snapshot_id")}
              AND {C(Responsibility, "p", "article_id")} = {C(Responsibility, "s", "article_id")}
              AND ({C(Responsibility, "s", "responsibility_version")} = 1 OR
                  ({C(Responsibility, "p", "article_revision_id")} = {C(Responsibility, "s", "article_revision_id")}
                   AND {C(Responsibility, "p", "responsibility_version")} = {C(Responsibility, "s", "responsibility_version")} - 1))
            WHERE {C(Responsibility, "s", "responsibility_version")} IS NULL
               OR {C(Responsibility, "s", "responsibility_version")} < 1
               OR ({C(Responsibility, "s", "previous_snapshot_id")} IS NOT NULL AND {C(Responsibility, "p", "id")} IS NULL)
               OR ({C(Responsibility, "s", "previous_snapshot_id")} IS NULL AND {C(Responsibility, "s", "responsibility_version")} > 1)
               OR {C(Responsibility, "s", "previous_snapshot_id")} >= {C(Responsibility, "s", "id")}
            """);
        foreach (var (snapshot, foreignKey, isOptional) in new[]
            { (RightsSnapshot, "rights_snapshot_id", false), (Responsibility, "responsibility_snapshot_id", true) })
        {
            await Check($"publication does not resolve its exact snapshot coordinates: {snapshot}", $"""
                FROM {T(Publication)} p LEFT JOIN {T(snapshot)} s
                  ON {C(snapshot, "s", "id")} = {C(Publication, "p", foreignKey)}
                  AND {C(snapshot, "s", "article_id")} = {C(Publication, "p", "article_id")}
                  AND {C(snapshot, "s", "article_revision_id")} = {C(Publication, "p", "article_revision_id")}
                  AND {C(snapshot, "s", "revision_no")} = {C(Publication, "p", "revision_no")}
                WHERE {C(snapshot, "s", "id")} IS NULL
                  {(isOptional ? $"AND {C(Publication, "p", foreignKey)} IS NOT NULL" : "")}
                """);
        }

        async Task Check(string name, string sql)
        {
            var count = await CountAsync(sql, transaction, token);
            if (count != 0) issues.Add(new LegacyIssue(name, count));
        }
    }

    private static bool IsExpectedTagKey(string stored, string original)
        => string.Equals(stored, TaxonomyNames.TagLookupKey(original), StringComparison.Ordinal);

    private static bool IsStoredRightsHash(string? value, string sentinel)
        => string.Equals(value, sentinel, StringComparison.Ordinal) ||
           value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal) &&
           value[7..].All(char.IsAsciiHexDigitLower);

    private static int ParseRevisionTag(string value)
        => int.TryParse(value.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) && parsed > 0
            ? parsed : throw new InvalidOperationException("A source revision contains an unmapped tag token.");
}
