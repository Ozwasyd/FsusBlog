using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

internal static class AuditTamperEvidence
{
    public static byte[]? ResolveKey(IConfiguration configuration)
    {
        string? configured = configuration["Audit:TamperEvidenceKey"];
        if (string.IsNullOrWhiteSpace(configured))
        {
            configured = configuration["Security:AuditTamperEvidenceKey"];
        }

        return string.IsNullOrWhiteSpace(configured)
            ? null
            : Encoding.UTF8.GetBytes(configured.Trim());
    }

    public static AuditTamperEvidenceResult Sign(AuditRecord record, byte[]? key)
    {
        string chainId = record.ChainId ?? record.OccurredAtUtc.ToString("yyyyMMdd");
        byte[] canonicalBytes = Encoding.UTF8.GetBytes(BuildCanonical(record, chainId));
        string recordHash = record.RecordHash ?? Convert.ToHexString(SHA256.HashData(canonicalBytes)).ToLowerInvariant();
        string? recordMac = record.RecordMac;
        if (recordMac is null && key is { Length: > 0 })
        {
            recordMac = Convert.ToHexString(HMACSHA256.HashData(key, canonicalBytes)).ToLowerInvariant();
        }

        return new AuditTamperEvidenceResult(chainId, recordHash, recordMac);
    }

    public static bool Verify(AuditLog log, byte[]? key)
    {
        if (string.IsNullOrWhiteSpace(log.RecordHash))
        {
            return false;
        }

        AuditRecord record = FromLog(log);
        AuditTamperEvidenceResult evidence = Sign(record with { RecordHash = null, RecordMac = null }, key);
        if (!string.Equals(log.RecordHash, evidence.RecordHash, StringComparison.Ordinal))
        {
            return false;
        }

        return string.IsNullOrWhiteSpace(log.RecordMac)
            || string.IsNullOrWhiteSpace(evidence.RecordMac)
            || string.Equals(log.RecordMac, evidence.RecordMac, StringComparison.Ordinal);
    }

    private static string BuildCanonical(AuditRecord record, string chainId)
        => JsonSerializer.Serialize(new
        {
            record.Source,
            record.Type,
            OccurredAtUtc = record.OccurredAtUtc.ToUniversalTime().ToString("O"),
            Action = NormalizeNonEmpty(record.Action, AuditActionCatalog.LogRecorded),
            Outcome = NormalizeNonEmpty(record.Outcome, AuditOutcomeCatalog.Unknown),
            Severity = NormalizeNonEmpty(record.Severity, AuditSeverityCatalog.Info),
            record.ActorType,
            record.ActorId,
            record.ActorRole,
            record.TargetType,
            record.TargetId,
            record.IsHighValue,
            record.TraceId,
            record.RequestPath,
            record.RequestMethod,
            record.IpHash,
            record.UserAgentHash,
            record.SessionIdHash,
            record.DeviceFingerprintHash,
            record.ReasonCode,
            record.EventInfo,
            record.ContextJson,
            ChainId = chainId,
            record.PrevHash
        });

    private static AuditRecord FromLog(AuditLog log)
        => new(
            log.Source,
            log.Type,
            log.OccurredAtUtc,
            log.EventInfo,
            log.ContextPayload,
            Action: log.Action,
            Outcome: log.Outcome,
            Severity: log.Severity,
            ActorType: log.ActorType,
            ActorId: log.ActorId,
            ActorRole: log.ActorRole,
            TargetType: log.TargetType,
            TargetId: log.TargetId,
            IsHighValue: log.IsHighValue,
            TraceId: log.TraceId,
            RequestPath: log.RequestPath,
            RequestMethod: log.RequestMethod,
            IpHash: log.IpHash,
            UserAgentHash: log.UserAgentHash,
            SessionIdHash: log.SessionIdHash,
            DeviceFingerprintHash: log.DeviceFingerprintHash,
            ReasonCode: log.ReasonCode,
            ContextJson: log.ContextJson,
            ChainId: log.ChainId,
            PrevHash: log.PrevHash,
            RecordHash: log.RecordHash,
            RecordMac: log.RecordMac);

    private static string NormalizeNonEmpty(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}

internal sealed record AuditTamperEvidenceResult(string ChainId, string RecordHash, string? RecordMac);
