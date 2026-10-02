using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Audit;

/// <summary>
/// Binds a journal delivery to its immutable, unique retention envelope. The existing
/// database ciphertext is its commit postcondition; no second audit ledger is introduced.
/// </summary>
internal static class AuditDurableDelivery
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    internal static string Identity(byte[] envelope)
        => Convert.ToHexStringLower(SHA256.HashData(envelope));

    internal static AuditRecord NormalizeForStore(AuditRecord record)
    {
        DateTime utc = record.OccurredAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(record.OccurredAtUtc, DateTimeKind.Utc)
            : record.OccurredAtUtc.ToUniversalTime();
        // PostgreSQL timestamp precision is microseconds. Sign exactly the stored
        // representation, so a commit acknowledgement loss can verify the row.
        return record with
        {
            OccurredAtUtc = new DateTime(utc.Ticks - utc.Ticks % 10, DateTimeKind.Utc),
            ActorType = string.IsNullOrWhiteSpace(record.ActorType) ? null : record.ActorType,
            TargetType = string.IsNullOrWhiteSpace(record.TargetType) ? null : record.TargetType
        };
    }

    internal static void Validate(AuditRecord record)
    {
        if (record.ContextPayload is not { Length: > 0 } payload
            || record.EventInfo != AuditRetentionPayloadProtector.EncryptedEventInfo
            || record.ContextJson is not null
            || record.DurableDeliveryId != Identity(payload))
        {
            throw new InvalidDataException("audit_durable_envelope_identity_invalid");
        }
        AuditRetentionEnvelope? envelope = JsonSerializer.Deserialize<AuditRetentionEnvelope>(
            payload, s_jsonOptions);
        AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(record.Action);
        if (envelope is not { Version: AuditRetentionPayloadProtector.EnvelopeVersion }
            || envelope.KeyDomain != policy.CryptographicEraseKeyDomain
            || string.IsNullOrWhiteSpace(envelope.EpochId))
        {
            throw new InvalidDataException("audit_durable_envelope_invalid");
        }
    }
}
