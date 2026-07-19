using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Services.Security;

public static class SecurityChallengeEnvelopeStatuses
{
    public const string Active = "active";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Expired = "expired";
    public const string Revoked = "revoked";
}

public sealed record SecurityChallengeEnvelopeState(
    string EnvelopeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    string[] ChallengeIds,
    string[] RequiredKinds,
    bool[] VerifiedMembers,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs,
    string Status,
    int Version,
    string? TerminalReason = null)
{
    public int MemberCount => ChallengeIds.Length;

    public int CompletedCount => VerifiedMembers.Count(static verified => verified);
}

public sealed record SecurityChallengeEnvelopeMemberRequest(
    string EnvelopeId,
    string ChallengeId,
    string Kind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion);

public sealed record SecurityChallengeEnvelopeMemberResult(
    bool Accepted,
    string Reason,
    SecurityChallengeEnvelopeState? State,
    int MemberIndex,
    int CompletedCount,
    int MemberCount,
    bool EnvelopeCompleted)
{
    public static SecurityChallengeEnvelopeMemberResult Reject(string reason, SecurityChallengeEnvelopeState? state = null, int memberIndex = -1)
        => new(false, NormalizeReason(reason), state, memberIndex, state?.CompletedCount ?? 0, state?.MemberCount ?? 0, false);

    public static SecurityChallengeEnvelopeMemberResult Success(SecurityChallengeEnvelopeState state, int memberIndex)
        => new(true, "ok", state, memberIndex, state.CompletedCount, state.MemberCount,
            string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal));

    private static string NormalizeReason(string reason)
        => string.IsNullOrWhiteSpace(reason) ? "challenge_envelope_rejected" : reason.Trim();
}

public interface ISecurityChallengeEnvelopeStateService
{
    Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default);

    Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default);

    Task<bool> FailAsync(SecurityChallengeEnvelopeMemberRequest request, string reason, CancellationToken cancellationToken = default);
}

public sealed class SecurityChallengeEnvelopeStateService(
    ICacheStringReader cacheReader,
    ICacheCompareExchangeStore compareExchange,
    TimeProvider timeProvider) : ISecurityChallengeEnvelopeStateService
{
    private const int MaxCasAttempts = 4;
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateNewState(state);
        DateTimeOffset now = timeProvider.GetUtcNow();
        TimeSpan ttl = DateTimeOffset.FromUnixTimeMilliseconds(state.ExpiresAtUnixMs) - now;
        if (ttl <= TimeSpan.Zero)
        {
            return false;
        }

        return await compareExchange.TrySetVersionedStringAsync(
            CachePolicyId.SecurityChallengeEnvelope,
            BuildIdentity(state.EnvelopeId),
            Encode(state),
            state.Version.ToString(System.Globalization.CultureInfo.InvariantCulture),
            allowOverwrite: false,
            l2TtlOverride: ttl,
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public async Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = await ReadAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
        return Validate(state, request, timeProvider.GetUtcNow());
    }

    public async Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        CancellationToken cancellationToken = default)
    {
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SecurityChallengeEnvelopeState? current = await ReadAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            SecurityChallengeEnvelopeMemberResult validated = Validate(current, request, timeProvider.GetUtcNow());
            if (!validated.Accepted || current is null)
            {
                return validated;
            }

            bool[] verified = (bool[])current.VerifiedMembers.Clone();
            verified[validated.MemberIndex] = true;
            bool completed = verified.All(static value => value);
            var updated = current with
            {
                VerifiedMembers = verified,
                Status = completed ? SecurityChallengeEnvelopeStatuses.Completed : SecurityChallengeEnvelopeStatuses.Active,
                Version = checked(current.Version + 1)
            };
            if (await TryUpdateAsync(current, updated, cancellationToken).ConfigureAwait(false))
            {
                return SecurityChallengeEnvelopeMemberResult.Success(updated, validated.MemberIndex);
            }
        }

        return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_conflict");
    }

    public async Task<bool> FailAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        string reason,
        CancellationToken cancellationToken = default)
    {
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SecurityChallengeEnvelopeState? current = await ReadAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            if (current is null || !CanFail(current, request, timeProvider.GetUtcNow()))
            {
                return false;
            }

            var updated = current with
            {
                Status = SecurityChallengeEnvelopeStatuses.Failed,
                Version = checked(current.Version + 1),
                TerminalReason = NormalizeReason(reason)
            };
            if (await TryUpdateAsync(current, updated, cancellationToken).ConfigureAwait(false))
            {
                return true;
            }
        }

        return false;
    }

    private async Task<SecurityChallengeEnvelopeState?> ReadAsync(string envelopeId, CancellationToken cancellationToken)
    {
        if (!IsUuidV7(envelopeId))
        {
            return null;
        }

        string? encoded = await cacheReader.GetStringAsync(
            CachePolicyId.SecurityChallengeEnvelope,
            BuildIdentity(envelopeId),
            cancellationToken).ConfigureAwait(false);
        return Decode(encoded);
    }

    private async Task<bool> TryUpdateAsync(
        SecurityChallengeEnvelopeState current,
        SecurityChallengeEnvelopeState updated,
        CancellationToken cancellationToken)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        TimeSpan ttl = DateTimeOffset.FromUnixTimeMilliseconds(updated.ExpiresAtUnixMs) - now;
        if (ttl <= TimeSpan.Zero)
        {
            return false;
        }

        return await compareExchange.TrySetVersionedStringAsync(
            CachePolicyId.SecurityChallengeEnvelope,
            BuildIdentity(updated.EnvelopeId),
            Encode(updated),
            current.Version.ToString(System.Globalization.CultureInfo.InvariantCulture),
            allowOverwrite: false,
            l2TtlOverride: ttl,
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private static SecurityChallengeEnvelopeMemberResult Validate(
        SecurityChallengeEnvelopeState? state,
        SecurityChallengeEnvelopeMemberRequest request,
        DateTimeOffset now)
    {
        if (state is null)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_missing");
        }
        if (!FixedEquals(state.EnvelopeId, request.EnvelopeId)
            || !FixedEquals(state.Action, request.Action)
            || !FixedEquals(state.RouteKey, request.RouteKey)
            || !FixedEquals(state.SubjectHash, request.SubjectHash)
            || !FixedEquals(state.ClientIpHash, request.ClientIpHash)
            || !FixedEquals(state.DeviceFpHash, request.DeviceFpHash)
            || !FixedEquals(state.PolicyVersion, request.PolicyVersion))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_binding_mismatch", state);
        }
        if (state.ExpiresAtUnixMs <= now.ToUnixTimeMilliseconds())
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_expired", state);
        }
        if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
        {
            string reason = string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal)
                ? "challenge_envelope_replayed"
                : $"challenge_envelope_{state.Status}";
            return SecurityChallengeEnvelopeMemberResult.Reject(reason, state);
        }

        int memberIndex = Array.FindIndex(state.ChallengeIds, id => FixedEquals(id, request.ChallengeId));
        if (memberIndex < 0 || !FixedEquals(state.RequiredKinds[memberIndex], request.Kind))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_member_mismatch", state);
        }
        int nextIndex = Array.FindIndex(state.VerifiedMembers, static verified => !verified);
        if (nextIndex < 0)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_replayed", state, memberIndex);
        }
        if (memberIndex < nextIndex || state.VerifiedMembers[memberIndex])
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_replayed", state, memberIndex);
        }
        if (memberIndex != nextIndex)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_out_of_order", state, memberIndex);
        }

        return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
    }

    private static bool CanFail(
        SecurityChallengeEnvelopeState state,
        SecurityChallengeEnvelopeMemberRequest request,
        DateTimeOffset now)
    {
        if (state.ExpiresAtUnixMs <= now.ToUnixTimeMilliseconds()
            || !string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
            || !FixedEquals(state.EnvelopeId, request.EnvelopeId)
            || !FixedEquals(state.Action, request.Action)
            || !FixedEquals(state.RouteKey, request.RouteKey)
            || !FixedEquals(state.SubjectHash, request.SubjectHash)
            || !FixedEquals(state.ClientIpHash, request.ClientIpHash)
            || !FixedEquals(state.DeviceFpHash, request.DeviceFpHash)
            || !FixedEquals(state.PolicyVersion, request.PolicyVersion))
        {
            return false;
        }

        int memberIndex = Array.FindIndex(state.ChallengeIds, id => FixedEquals(id, request.ChallengeId));
        return memberIndex >= 0 && FixedEquals(state.RequiredKinds[memberIndex], request.Kind);
    }

    private static void ValidateNewState(SecurityChallengeEnvelopeState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (!IsUuidV7(state.EnvelopeId))
            throw new ArgumentException("EnvelopeId must be UUIDv7.", nameof(state));
        if (state.MemberCount is <= 0 or > 8
            || state.RequiredKinds.Length != state.MemberCount
            || state.VerifiedMembers.Length != state.MemberCount
            || state.VerifiedMembers.Any(static value => value)
            || state.ChallengeIds.Distinct(StringComparer.Ordinal).Count() != state.MemberCount)
            throw new ArgumentException("Envelope members are invalid.", nameof(state));
        if (state.IssuedAtUnixMs <= 0 || state.ExpiresAtUnixMs <= state.IssuedAtUnixMs)
            throw new ArgumentException("Envelope expiry is invalid.", nameof(state));
        if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
            || state.Version != 0)
            throw new ArgumentException("New envelope state must be active at version zero.", nameof(state));
    }

    private static string Encode(SecurityChallengeEnvelopeState state)
    {
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(state, s_jsonOptions);
        return $"v1|{state.Version.ToString(System.Globalization.CultureInfo.InvariantCulture)}|{Convert.ToBase64String(json).TrimEnd('=').Replace('+', '-').Replace('/', '_')}";
    }

    private static SecurityChallengeEnvelopeState? Decode(string? encoded)
    {
        try
        {
            string[] parts = (encoded ?? string.Empty).Split('|', 3, StringSplitOptions.None);
            if (parts.Length != 3 || !string.Equals(parts[0], "v1", StringComparison.Ordinal)
                || !int.TryParse(parts[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out int version))
            {
                return null;
            }
            string payload = parts[2].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
            SecurityChallengeEnvelopeState? state = JsonSerializer.Deserialize<SecurityChallengeEnvelopeState>(Convert.FromBase64String(payload), s_jsonOptions);
            return state is not null && state.Version == version ? state : null;
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            return null;
        }
    }

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left ?? string.Empty);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right ?? string.Empty);
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static bool IsUuidV7(string value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return Guid.TryParseExact(normalized, "D", out _)
            && normalized.Length == 36
            && normalized[14] == '7';
    }

    private static string BuildIdentity(string envelopeId)
        => $"envelope:{envelopeId.Trim()}";

    private static string NormalizeReason(string reason)
    {
        string normalized = (reason ?? string.Empty).Trim();
        return normalized.Length switch
        {
            0 => "challenge_member_failed",
            > 128 => normalized[..128],
            _ => normalized
        };
    }
}
