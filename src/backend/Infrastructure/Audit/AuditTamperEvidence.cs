using System.Buffers;
using System.Globalization;
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
        string chainId = record.ChainId ?? record.OccurredAtUtc.ToUniversalTime().ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var canonical = new ArrayBufferWriter<byte>(1024);
        WriteCanonical(record, chainId, canonical);
        ReadOnlySpan<byte> canonicalBytes = canonical.WrittenSpan;
        string recordHash = record.RecordHash ?? Convert.ToHexStringLower(SHA256.HashData(canonicalBytes));
        string? recordMac = record.RecordMac;
        if (recordMac is null && key is { Length: > 0 })
        {
            recordMac = Convert.ToHexStringLower(HMACSHA256.HashData(key, canonicalBytes));
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
        if (!FixedTimeEqualsHexSha256(log.RecordHash, evidence.RecordHash))
        {
            return false;
        }

        return string.IsNullOrWhiteSpace(log.RecordMac)
            || string.IsNullOrWhiteSpace(evidence.RecordMac)
            || FixedTimeEqualsHexSha256(log.RecordMac, evidence.RecordMac);
    }

    internal static bool FixedTimeEqualsHexSha256(string? left, string? right)
    {
        Span<byte> leftBytes = stackalloc byte[SHA256.HashSizeInBytes];
        Span<byte> rightBytes = stackalloc byte[SHA256.HashSizeInBytes];
        bool leftDecoded = TryDecodeSha256Hex(left, leftBytes);
        bool rightDecoded = TryDecodeSha256Hex(right, rightBytes);

        bool matches = CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
        return leftDecoded & rightDecoded & matches;
    }

    private static bool TryDecodeSha256Hex(string? value, Span<byte> destination)
    {
        if (value is null || value.Length != SHA256.HashSizeInBytes * 2)
        {
            return false;
        }

        try
        {
            byte[] decoded = Convert.FromHexString(value);
            if (decoded.Length != destination.Length)
            {
                return false;
            }

            decoded.CopyTo(destination);
            return true;
        }
        catch (FormatException)
        {
            destination.Clear();
            return false;
        }
    }

    private static void WriteCanonical(AuditRecord record, string chainId, IBufferWriter<byte> buffer)
    {
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writer.WriteString("Source", record.Source);
        writer.WriteString("Type", record.Type);
        writer.WriteString("OccurredAtUtc", record.OccurredAtUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        writer.WriteString("Action", NormalizeNonEmpty(record.Action, AuditActionCatalog.LogRecorded));
        writer.WriteString("Outcome", NormalizeNonEmpty(record.Outcome, AuditOutcomeCatalog.Unknown));
        writer.WriteString("Severity", NormalizeNonEmpty(record.Severity, AuditSeverityCatalog.Info));
        WriteNullableString(writer, "ActorType", record.ActorType);
        WriteNullableString(writer, "ActorId", record.ActorId);
        WriteNullableString(writer, "ActorRole", record.ActorRole);
        WriteNullableString(writer, "TargetType", record.TargetType);
        WriteNullableString(writer, "TargetId", record.TargetId);
        writer.WriteBoolean("IsHighValue", record.IsHighValue);
        WriteNullableString(writer, "TraceId", record.TraceId);
        WriteNullableString(writer, "RequestPath", record.RequestPath);
        WriteNullableString(writer, "RequestMethod", record.RequestMethod);
        WriteNullableString(writer, "IpHash", record.IpHash);
        WriteNullableString(writer, "UserAgentHash", record.UserAgentHash);
        WriteNullableString(writer, "SessionIdHash", record.SessionIdHash);
        WriteNullableString(writer, "DeviceFingerprintHash", record.DeviceFingerprintHash);
        WriteNullableString(writer, "ReasonCode", record.ReasonCode);
        writer.WriteString("EventInfo", record.EventInfo);
        WriteNullableString(writer, "ContextJson", record.ContextJson);
        writer.WriteString("ChainId", chainId);
        WriteNullableString(writer, "PrevHash", record.PrevHash);
        writer.WriteEndObject();
    }

    private static void WriteNullableString(Utf8JsonWriter writer, string propertyName, string? value)
    {
        if (value is null)
        {
            writer.WriteNull(propertyName);
            return;
        }

        writer.WriteString(propertyName, value);
    }

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
