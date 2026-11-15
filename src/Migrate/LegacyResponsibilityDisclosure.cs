using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;
using Npgsql;

internal static partial class Migration
{
    // Frozen v1 ArticleResponsibilityContracts and ArticleResponsibilityManifest.
    private sealed record LegacyResponsiblePerson(string? Name, string? ProfileUrl);
    private sealed record LegacyEvidenceSource(string? Title, string? Url, string? SourceType, DateOnly? AccessedOn,
        string? Version, string? CitationNote, bool IsPublic = true);
    private static readonly JsonSerializerOptions LegacyDisclosureJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static async Task<string> ReadLegacyResponsibilityDisclosuresAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        string siteAuthor, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand($"""
            SELECT s.id, admissible,
                admissible AND inherit_site_author=1,
                CASE WHEN admissible THEN authors_json END, CASE WHEN admissible THEN reviewer_json END,
                CASE WHEN admissible THEN sources_json END, CASE WHEN admissible THEN update_summary END,
                CASE WHEN admissible THEN update_reason END, CASE WHEN admissible THEN effective_at END,
                CASE WHEN admissible THEN conclusion_impact END, CASE WHEN admissible THEN methodology END,
                CASE WHEN admissible THEN applicability END, CASE WHEN admissible THEN limitations END
            FROM {ImportSchema}.shadow_article_responsibility_snapshot s
            CROSS JOIN LATERAL (SELECT octet_length(row_to_json(s)::text)<=65536 AS admissible) budget
            ORDER BY s.id LIMIT 3
            """, db, tx);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var disclosures = new Dictionary<long, object>(2);
        try
        {
            while (await rows.ReadAsync(ct))
            {
                if (disclosures.Count >= 2 || !rows.GetBoolean(1)) throw new JsonException();
                string? Text(int field) => rows.IsDBNull(field) ? null : rows.GetString(field);
                var authors = ReadLegacyDisclosureArray<LegacyResponsiblePerson>(Text(3)).Select(PublicLegacyPerson)
                    .OfType<LegacyResponsiblePerson>().Take(8).ToArray();
                if (authors.Length == 0 && rows.GetBoolean(2)) authors = [new(siteAuthor, null)];
                var reviewer = Text(4) is { } reviewerJson && !string.IsNullOrWhiteSpace(reviewerJson)
                    ? PublicLegacyPerson(JsonSerializer.Deserialize<LegacyResponsiblePerson>(reviewerJson, LegacyDisclosureJson)) : null;
                var sources = ReadLegacyDisclosureArray<LegacyEvidenceSource>(Text(5)).Where(source => source.IsPublic)
                    .Select(source => source with { Title = TrimLegacyDisclosure(source.Title), Url = LegacyPublicUrl(source.Url),
                        SourceType = TrimLegacyDisclosure(source.SourceType) ?? "other", Version = TrimLegacyDisclosure(source.Version),
                        CitationNote = TrimLegacyDisclosure(source.CitationNote) })
                    .Where(source => source.Title is not null && source.Url is not null).Take(100).ToArray();
                var summary = TrimLegacyDisclosure(Text(6));
                var reason = TrimLegacyDisclosure(Text(7));
                DateTime? effectiveAt = null;
                if (Text(8) is { } time)
                {
                    if (!DateTime.TryParseExact(time, "yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture,
                            DateTimeStyles.None, out var parsed) || parsed.Ticks % 10 != 0)
                        throw new JsonException();
                    effectiveAt = parsed;
                }
                var impact = TrimLegacyDisclosure(Text(9))?.ToLowerInvariant();
                var update = summary is null && reason is null && effectiveAt is null ? null : new
                {
                    summary = summary ?? "未提供变更摘要", reason = reason ?? "未提供变更原因", effectiveAt,
                    conclusionImpact = impact is "none" or "clarified" or "changed" ? impact : "unknown"
                };
                disclosures.Add(rows.GetInt64(0), new { authors, reviewer, sources, update,
                    methodology = TrimLegacyDisclosure(Text(10)), applicability = TrimLegacyDisclosure(Text(11)),
                    limitations = TrimLegacyDisclosure(Text(12)) });
            }
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("Legacy rollback responsibility disclosure is malformed or exceeds its byte budget.");
        }
        return JsonSerializer.Serialize(disclosures, LegacyDisclosureJson);
    }

    private static T[] ReadLegacyDisclosureArray<T>(string? json) where T : class
    {
        var array = JsonSerializer.Deserialize<T[]>(json ?? "null", LegacyDisclosureJson);
        if (array is null || array.Any(item => item is null)) throw new JsonException();
        return array;
    }

    private static string? TrimLegacyDisclosure(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static LegacyResponsiblePerson? PublicLegacyPerson(LegacyResponsiblePerson? person) =>
        TrimLegacyDisclosure(person?.Name) is { } name ? new(name, LegacyPublicUrl(person?.ProfileUrl)) : null;

    private static string? LegacyPublicUrl(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) || uri.UserInfo.Length != 0 ||
            string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
            return null;
        if (!IPAddress.TryParse(uri.Host, out var address)) return uri.AbsoluteUri;
        if (IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal) return null;
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            if (bytes[0] is 10 or 127 || bytes[0] == 169 && bytes[1] == 254 ||
                bytes[0] == 172 && bytes[1] is >= 16 and <= 31 || bytes[0] == 192 && bytes[1] == 168) return null;
        }
        return uri.AbsoluteUri;
    }
}
