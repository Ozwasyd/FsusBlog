using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

internal static class AuditTamperEvidence
{
    internal const int MinimumTamperEvidenceKeyByteCount = 32;
    private const int MinimumTamperEvidenceKeyDistinctCharacters = 8;

    public static byte[]? ResolveKey(IConfiguration configuration)
    {
        string? configured = configuration["Audit:TamperEvidenceKey"];
        if (string.IsNullOrWhiteSpace(configured))
        {
            return null;
        }

        string trimmed = configured.Trim();
        if (!TryValidateKeyMaterial(trimmed, out string error))
        {
            throw new InvalidOperationException(error);
        }

        return Encoding.UTF8.GetBytes(trimmed);
    }

    public static AuditTamperEvidenceResult Sign(AuditRecord record, byte[]? key)
        => Sign(record, key, bindContextPayload: true);

    private static AuditTamperEvidenceResult Sign(
        AuditRecord record,
        byte[]? key,
        bool bindContextPayload)
    {
        string chainId = record.ChainId ?? NormalizeUtc(record.OccurredAtUtc).ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var canonical = new ArrayBufferWriter<byte>(1024);
        WriteCanonical(record, chainId, canonical, bindContextPayload);
        ReadOnlySpan<byte> canonicalBytes = canonical.WrittenSpan;
        string recordHash = record.RecordHash ?? Convert.ToHexStringLower(SHA256.HashData(canonicalBytes));
        string? recordMac = record.RecordMac;
        if (recordMac is null && key is { Length: > 0 })
        {
            EnsureUsableKey(key);
            recordMac = Convert.ToHexStringLower(HMACSHA256.HashData(key, canonicalBytes));
        }

        return new AuditTamperEvidenceResult(chainId, recordHash, recordMac);
    }

    public static bool Verify(AuditLog log, byte[]? key)
        => VerifyDetailed(log, key).IsValid;

    internal static AuditTamperVerificationResult VerifyDetailed(
        AuditLog log,
        byte[]? key,
        string? expectedPreviousHash = null)
    {
        if (string.IsNullOrWhiteSpace(log.RecordHash))
        {
            return AuditTamperVerificationResult.Invalid("record_hash_missing", "record_hash");
        }

        string expectedChainId = NormalizeUtc(log.OccurredAtUtc)
            .ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        if (!string.Equals(log.ChainId, expectedChainId, StringComparison.Ordinal))
        {
            return AuditTamperVerificationResult.Invalid("chain_id_mismatch", "chain_id");
        }

        if (expectedPreviousHash is not null
            && !FixedTimeEqualsHexSha256(log.PrevHash, expectedPreviousHash))
        {
            return AuditTamperVerificationResult.Invalid("prev_hash_mismatch", "prev_hash");
        }

        if (!IsUsableKey(key))
        {
            return AuditTamperVerificationResult.Invalid("tamper_key_missing", "record_mac");
        }

        AuditRecord record = FromLog(log);
        AuditTamperEvidenceResult evidence = Sign(record with
        {
            RecordHash = null,
            RecordMac = null
        }, key);
        if (!FixedTimeEqualsHexSha256(log.RecordHash, evidence.RecordHash))
        {
            AuditTamperEvidenceResult payloadUnboundV1 = Sign(
                record with
                {
                    RecordHash = null,
                    RecordMac = null
                },
                key,
                bindContextPayload: false);
            if (!FixedTimeEqualsHexSha256(log.RecordHash, payloadUnboundV1.RecordHash))
            {
                return AuditTamperVerificationResult.Invalid("record_hash_mismatch", "record_hash");
            }
            evidence = payloadUnboundV1;
        }

        if (string.IsNullOrWhiteSpace(log.RecordMac))
        {
            return AuditTamperVerificationResult.Invalid("record_mac_missing", "record_mac");
        }

        if (string.IsNullOrWhiteSpace(evidence.RecordMac)
            || !FixedTimeEqualsHexSha256(log.RecordMac, evidence.RecordMac))
        {
            return AuditTamperVerificationResult.Invalid("record_mac_mismatch", "record_mac");
        }

        return AuditTamperVerificationResult.Valid();
    }

    internal static AuditTamperVerificationResult VerifyIsolatedMutation(
        AuditLog source,
        AuditLog candidate,
        byte[]? key)
    {
        AuditTamperVerificationResult sourceVerification = VerifyDetailed(source, key);
        if (!sourceVerification.IsValid)
        {
            return AuditTamperVerificationResult.Invalid("source_record_invalid", sourceVerification.Field ?? "record");
        }

        string[] fields = ChangedCanonicalFields(source, candidate);
        if (fields.Length != 1)
        {
            return AuditTamperVerificationResult.Invalid(
                fields.Length == 0 ? "mutation_missing" : "multiple_fields_mismatch",
                "record");
        }
        return fields[0] switch
        {
            "record_body" => AuditTamperVerificationResult.Invalid("record_body_mismatch", fields[0]),
            "prev_hash" => AuditTamperVerificationResult.Invalid("prev_hash_mismatch", fields[0]),
            "record_hash" => AuditTamperVerificationResult.Invalid("record_hash_mismatch", fields[0]),
            "record_mac" => AuditTamperVerificationResult.Invalid("record_mac_mismatch", fields[0]),
            "chain_id" => AuditTamperVerificationResult.Invalid("chain_id_mismatch", fields[0]),
            "protected_payload" => AuditTamperVerificationResult.Invalid("protected_payload_mismatch", fields[0]),
            _ => AuditTamperVerificationResult.Invalid("record_field_mismatch", fields[0])
        };
    }

    internal static string[] ChangedCanonicalFields(AuditLog source, AuditLog candidate)
    {
        var changed = new List<string>();
        if (!string.Equals(source.EventInfo, candidate.EventInfo, StringComparison.Ordinal))
        {
            changed.Add("record_body");
        }
        if (!string.Equals(source.PrevHash, candidate.PrevHash, StringComparison.Ordinal))
        {
            changed.Add("prev_hash");
        }
        if (!string.Equals(source.RecordHash, candidate.RecordHash, StringComparison.Ordinal))
        {
            changed.Add("record_hash");
        }
        if (!string.Equals(source.RecordMac, candidate.RecordMac, StringComparison.Ordinal))
        {
            changed.Add("record_mac");
        }
        if (!string.Equals(source.ChainId, candidate.ChainId, StringComparison.Ordinal))
        {
            changed.Add("chain_id");
        }
        if (!(source.ContextPayload ?? []).SequenceEqual(candidate.ContextPayload ?? []))
        {
            changed.Add("protected_payload");
        }
        return [.. changed];
    }

    internal static string ComputeRecordHash(AuditLog log)
    {
        ArgumentNullException.ThrowIfNull(log);
        AuditRecord record = FromLog(log) with
        {
            RecordHash = null,
            RecordMac = null
        };
        return Sign(record, key: null).RecordHash;
    }

    internal static bool TryValidateKeyMaterial(string? configured, out string error)
    {
        string value = configured?.Trim() ?? string.Empty;
        if (value.Length == 0)
        {
            error = "Audit:TamperEvidenceKey is required.";
            return false;
        }

        if (Encoding.UTF8.GetByteCount(value) < MinimumTamperEvidenceKeyByteCount)
        {
            error = $"Audit:TamperEvidenceKey must be at least {MinimumTamperEvidenceKeyByteCount} bytes.";
            return false;
        }

        if (!HasMinimumCharacterDiversity(value))
        {
            error = $"Audit:TamperEvidenceKey must include at least {MinimumTamperEvidenceKeyDistinctCharacters} distinct characters.";
            return false;
        }

        if (value.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("MUST_BE_OVERRIDDEN", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("replace-with", StringComparison.OrdinalIgnoreCase))
        {
            error = "Audit:TamperEvidenceKey must not use a template placeholder.";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static void EnsureUsableKey(byte[] key)
    {
        if (!IsUsableKey(key))
        {
            throw new InvalidOperationException(
                $"Audit tamper evidence key must be at least {MinimumTamperEvidenceKeyByteCount} bytes and include sufficient diversity.");
        }
    }

    private static bool IsUsableKey(byte[]? key)
        => key is { Length: >= MinimumTamperEvidenceKeyByteCount } && HasMinimumByteDiversity(key);

    private static bool HasMinimumCharacterDiversity(string value)
        => new HashSet<char>(value).Count >= MinimumTamperEvidenceKeyDistinctCharacters;

    private static bool HasMinimumByteDiversity(byte[] value)
        => new HashSet<byte>(value).Count >= MinimumTamperEvidenceKeyDistinctCharacters;

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

    private static void WriteCanonical(
        AuditRecord record,
        string chainId,
        IBufferWriter<byte> buffer,
        bool bindContextPayload)
    {
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writer.WriteString("Source", record.Source);
        writer.WriteString("Type", record.Type);
        writer.WriteString("OccurredAtUtc", NormalizeUtc(record.OccurredAtUtc).ToString("O", CultureInfo.InvariantCulture));
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
        if (bindContextPayload && record.ContextPayload is { Length: > 0 })
        {
            writer.WriteString(
                "ContextPayloadSha256",
                Convert.ToHexStringLower(SHA256.HashData(record.ContextPayload)));
        }
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

    internal static AuditRecord FromLog(AuditLog log)
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

    private static DateTime NormalizeUtc(DateTime value)
        => value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
}

internal sealed record AuditTamperEvidenceResult(string ChainId, string RecordHash, string? RecordMac);

internal sealed record AuditTamperVerificationResult(bool IsValid, string Reason, string? Field)
{
    public static AuditTamperVerificationResult Valid()
        => new(true, "valid", null);

    public static AuditTamperVerificationResult Invalid(string reason, string field)
        => new(false, reason, field);
}
