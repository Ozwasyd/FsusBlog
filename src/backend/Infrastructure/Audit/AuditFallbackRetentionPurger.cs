using System.Text.Json;

using FsusBlog.Server.Entities;

using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditFallbackRetentionPurger(
    IConfiguration configuration,
    AuditRetentionErasureService erasureService)
{
    private readonly string _fallbackRoot = ResolveFallbackRoot(configuration);

    public async Task<int> PurgeExpiredAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_fallbackRoot))
        {
            return 0;
        }

        TimeSpan maximumAge = AuditRetentionStorageContract.All
            .Single(static policy => policy.Surface == "local-fallback")
            .MaximumCiphertextAge;
        DateTime cutoff = now.ToUniversalTime().Subtract(maximumAge).UtcDateTime;
        int deleted = 0;
        foreach (string path in Directory.EnumerateFiles(_fallbackRoot, "critical-audit-*.jsonl", SearchOption.TopDirectoryOnly)
                     .Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (File.GetLastWriteTimeUtc(path) >= cutoff)
            {
                continue;
            }

            List<AuditLog> rows = await ReadEncryptedRowsAsync(path, cancellationToken).ConfigureAwait(false);
            foreach (IGrouping<string, AuditLog> actionRows in rows.GroupBy(static row => row.Action, StringComparer.Ordinal))
            {
                await erasureService.AnchorAndDestroyKeysAsync(
                    actionRows.OrderBy(static row => row.Id).ToArray(),
                    cancellationToken).ConfigureAwait(false);
            }
            File.Delete(path);
            deleted++;
        }
        return deleted;
    }

    private static async Task<List<AuditLog>> ReadEncryptedRowsAsync(
        string path,
        CancellationToken cancellationToken)
    {
        string[] lines = await File.ReadAllLinesAsync(path, cancellationToken).ConfigureAwait(false);
        var rows = new List<AuditLog>(lines.Length);
        for (int index = 0; index < lines.Length; index++)
        {
            using JsonDocument document = JsonDocument.Parse(lines[index]);
            JsonElement root = document.RootElement;
            string envelopeText = RequiredString(root, "RetentionEnvelopeBase64Url");
            byte[] envelope = WebEncoders.Base64UrlDecode(envelopeText);
            string action = RequiredString(root, "Action");
            _ = AuditRetentionCatalog.GetRequired(action);
            DateTime occurredAt = root.GetProperty("OccurredAtUtc").GetDateTime().ToUniversalTime();
            long id = checked(occurredAt.Ticks + index + 1L);
            var record = new AuditRecord(
                RequiredString(root, "Source"),
                RequiredString(root, "Type"),
                occurredAt,
                AuditRetentionPayloadProtector.EncryptedEventInfo,
                envelope,
                action,
                RequiredString(root, "Outcome"),
                RequiredString(root, "Severity"),
                ActorType: OptionalString(root, "ActorType"),
                ActorId: OptionalString(root, "ActorId"),
                TargetType: OptionalString(root, "TargetType"),
                TargetId: OptionalString(root, "TargetId"),
                IsHighValue: root.GetProperty("IsHighValue").GetBoolean(),
                ChainId: $"fallback-{occurredAt:yyyyMMdd}");
            AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, key: null);
            rows.Add(new AuditLog
            {
                Id = id,
                Source = record.Source,
                Type = record.Type,
                OccurredAtUtc = record.OccurredAtUtc,
                ActorType = record.ActorType,
                ActorId = record.ActorId,
                Action = record.Action,
                TargetType = record.TargetType,
                TargetId = record.TargetId,
                Outcome = record.Outcome,
                Severity = record.Severity,
                IsHighValue = record.IsHighValue,
                EventInfo = record.EventInfo,
                ContextPayload = record.ContextPayload,
                ChainId = evidence.ChainId,
                RecordHash = evidence.RecordHash
            });
        }
        return rows;
    }

    private static string RequiredString(JsonElement root, string propertyName)
        => OptionalString(root, propertyName)
            ?? throw new InvalidDataException($"audit_fallback_{propertyName}_missing");

    private static string? OptionalString(JsonElement root, string propertyName)
        => root.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string ResolveFallbackRoot(IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        return Path.Combine(dataRoot, "audit-fallback");
    }
}
