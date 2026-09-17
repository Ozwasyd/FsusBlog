using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

public interface IAuthoringAuditWriter
{
    void Write(string source, string eventInfo, long actorAdminPrincipalId, string target);
}

public sealed class AuthoringAuditWriter(AuditLogChannel auditLogChannel) : IAuthoringAuditWriter
{
    public void Write(string source, string eventInfo, long actorAdminPrincipalId, string target)
    {
        byte[] payload = Encoding.UTF8.GetBytes($"actor={actorAdminPrincipalId};target={target}");
        auditLogChannel.TryWrite(new AuditRecord(
            source,
            AuditTypeCatalog.Business,
            DateTime.UtcNow,
            eventInfo,
            payload));
    }
}

internal static class AuthoringNormalization
{
    internal static string Normalize(string? raw, int maxLength)
    {
        string value = TextHelpers.TrimOrEmpty(raw);
        return value.Length > maxLength ? value[..maxLength] : value;
    }

    internal static object DbValue(string? value)
        => string.IsNullOrWhiteSpace(value) ? DBNull.Value : value;

    internal static object DbValue(int? value)
        => value.HasValue ? value.Value : DBNull.Value;

    internal static object DbValue(DateTime? value)
        => value.HasValue ? value.Value : DBNull.Value;

    internal static List<int> NormalizeTagIds(IEnumerable<int>? tagIds)
        => tagIds is null
            ? []
            : tagIds.Where(static id => id > 0).Distinct().OrderBy(static id => id).Take(32).ToList();

    internal static List<int> ParseTagIds(string? raw)
        => string.IsNullOrWhiteSpace(raw)
            ? []
            : raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(static item => int.TryParse(item, out int id) ? id : 0)
                .Where(static id => id > 0)
                .Distinct()
                .ToList();

    internal static IReadOnlyList<string> ParseCommaList(string? value)
        => (value ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static item => item, StringComparer.Ordinal)
            .ToArray();

    internal static string HashText(string text)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
}
