using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Security-risk journal identity and the existing normalized SQL payload boundary.</summary>
internal static class SecurityRiskDurableDelivery
{
    internal static string Reference(string id)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(id)));

    internal static SecurityRiskEventWrite Normalize(SecurityRiskEventWrite source)
    {
        // Stable identities must not be replaced by ToEntity's legacy random-ID fallback.
        if (string.IsNullOrWhiteSpace(source.Id) || source.Id.Length > 64 || source.Id != source.Id.Trim())
        {
            throw new InvalidDataException("security_risk_identity_invalid");
        }
        SecurityRiskEvent entity = SecurityRiskEventStore.ToEntity(source);
        return new(entity.Id, source.OccurredAtUtc, entity.Source, entity.Reason, entity.Action,
            entity.ScoreDelta, entity.TotalScore, entity.TtlSeconds, source.ExpiresAtUtc, entity.SubjectHash,
            entity.RouteKey, entity.ClientIpHash, entity.DeviceFpHash, entity.Path, entity.Method,
            entity.UserAgent, entity.Detail, entity.TraceId, entity.PseudonymEpoch);
    }

    internal static bool Matches(SecurityRiskEvent expected, SecurityRiskEvent actual)
        => expected.Id == actual.Id
            && Timestamp(expected.OccurredAtUtc) == Timestamp(actual.OccurredAtUtc)
            && expected.Source == actual.Source && expected.Reason == actual.Reason
            && expected.Action == actual.Action && expected.ScoreDelta == actual.ScoreDelta
            && expected.TotalScore == actual.TotalScore && expected.TtlSeconds == actual.TtlSeconds
            && Timestamp(expected.ExpiresAtUtc) == Timestamp(actual.ExpiresAtUtc)
            && expected.SubjectHash == actual.SubjectHash && expected.RouteKey == actual.RouteKey
            && expected.ClientIpHash == actual.ClientIpHash && expected.DeviceFpHash == actual.DeviceFpHash
            && expected.Path == actual.Path && expected.Method == actual.Method
            && expected.UserAgent == actual.UserAgent && expected.Detail == actual.Detail
            && expected.TraceId == actual.TraceId && expected.PseudonymEpoch == actual.PseudonymEpoch;

    private static long Timestamp(DateTime value)
    {
        DateTime utc = value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc) : value.ToUniversalTime();
        return utc.Ticks - utc.Ticks % 10; // PostgreSQL timestamp precision is microseconds.
    }

    internal static byte[] AssociatedData(string reference, long sequence)
        => Encoding.UTF8.GetBytes($"security-risk-delivery:v1:{reference}:{sequence.ToString(CultureInfo.InvariantCulture)}");

    internal static bool SamePayload(SecurityRiskEventWrite left, SecurityRiskEventWrite right)
        => JsonSerializer.Serialize(left) == JsonSerializer.Serialize(right);

    internal static string PayloadIdentity(SecurityRiskEventWrite normalized)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(normalized)));
}

internal sealed record SecurityRiskDurableEntry(long Sequence, string Reference, SecurityRiskEventWrite Payload);
internal sealed record SecurityRiskJournalEnvelope(
    int Version, long Sequence, string Reference, byte[] Nonce, byte[] Tag, byte[] Ciphertext);
internal sealed record SecurityRiskJournalSnapshot(long Pending, long InFlight, long Accepted, long Committed,
    long Terminal, long Sequence, string? Reference, string? Reason);
