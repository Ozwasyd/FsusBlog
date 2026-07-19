using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Services.Security;

public static class SecurityChallengeEnvelopeStatuses
{
    public const string Active = "active";
    public const string ProofMinting = "proof_minting";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Expired = "expired";
    public const string Revoked = "revoked";
}

public static class SecurityChallengeEnvelopeMemberStatuses
{
    public const string Issued = "issued";
    public const string Verified = "verified";
    public const string Failed = "failed";
    public const string Expired = "expired";
    public const string Replayed = "replayed";
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
    string[] MemberStatuses,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs,
    string Status,
    int Version,
    string? TerminalReason = null,
    string? ProofToken = null,
    string? ProofNonce = null,
    long? ProofIssuedAtUnixMs = null,
    long? ProofExpiresAtUnixMs = null)
{
    public int MemberCount => ChallengeIds.Length;

    public int CompletedCount => MemberStatuses.Count(static status =>
        string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal));

    public bool HasPreparedProof =>
        !string.IsNullOrWhiteSpace(ProofToken)
        && !string.IsNullOrWhiteSpace(ProofNonce)
        && ProofIssuedAtUnixMs.HasValue
        && ProofExpiresAtUnixMs.HasValue;
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

public sealed record SecurityChallengeEnvelopeBindingRequest(
    string EnvelopeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion);

public sealed record SecurityChallengeProofPreparation(
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

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

    Task<SecurityChallengeEnvelopeState?> GetAsync(string envelopeId, CancellationToken cancellationToken = default);

    Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        SecurityChallengeProofPreparation? proofPreparation = null,
        CancellationToken cancellationToken = default);

    Task<SecurityChallengeEnvelopeMemberResult> CompleteProofAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        string proofToken,
        CancellationToken cancellationToken = default);

    Task<bool> FailAsync(SecurityChallengeEnvelopeMemberRequest request, string reason, CancellationToken cancellationToken = default);

    Task<bool> RevokeAsync(SecurityChallengeEnvelopeBindingRequest request, string reason, CancellationToken cancellationToken = default);
}

public sealed class SecurityChallengeEnvelopeStateService(
    ICacheStringReader cacheReader,
    ICacheCompareExchangeStore compareExchange,
    TimeProvider timeProvider) : ISecurityChallengeEnvelopeStateService
{
    private const int MaxCasAttempts = 8;
    private const int ProofTokenRandomBytes = 32;
    private const int ProofNonceRandomBytes = 16;
    private static readonly TimeSpan s_terminalRetention = TimeSpan.FromMinutes(5);
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateNewState(state);
        TimeSpan ttl = ResolveRetentionTtl(state, timeProvider.GetUtcNow());
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

    public Task<SecurityChallengeEnvelopeState?> GetAsync(string envelopeId, CancellationToken cancellationToken = default)
        => ReadAndExpireAsync(envelopeId, cancellationToken);

    public async Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = await ReadAndExpireAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
        return Validate(state, request, timeProvider.GetUtcNow());
    }

    public async Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        SecurityChallengeProofPreparation? proofPreparation = null,
        CancellationToken cancellationToken = default)
    {
        string? candidateProofToken = null;
        string? candidateProofNonce = null;
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SecurityChallengeEnvelopeState? current = await ReadAndExpireAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            SecurityChallengeEnvelopeMemberResult validated = Validate(current, request, timeProvider.GetUtcNow());
            if (!validated.Accepted || current is null)
            {
                return validated;
            }

            if (!string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
            {
                return validated;
            }

            string[] memberStatuses = (string[])current.MemberStatuses.Clone();
            memberStatuses[validated.MemberIndex] = SecurityChallengeEnvelopeMemberStatuses.Verified;
            bool allVerified = memberStatuses.All(static status =>
                string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal));
            SecurityChallengeEnvelopeState updated;
            if (allVerified)
            {
                SecurityChallengeProofPreparation prepared = ValidateProofPreparation(current, proofPreparation);
                candidateProofToken ??= GenerateProofToken();
                candidateProofNonce ??= GenerateProofNonce();
                updated = current with
                {
                    MemberStatuses = memberStatuses,
                    Status = SecurityChallengeEnvelopeStatuses.ProofMinting,
                    Version = checked(current.Version + 1),
                    ProofToken = candidateProofToken,
                    ProofNonce = candidateProofNonce,
                    ProofIssuedAtUnixMs = prepared.IssuedAt.ToUnixTimeMilliseconds(),
                    ProofExpiresAtUnixMs = prepared.ExpiresAt.ToUnixTimeMilliseconds()
                };
            }
            else
            {
                updated = current with
                {
                    MemberStatuses = memberStatuses,
                    Version = checked(current.Version + 1)
                };
            }

            if (await TryUpdateAsync(current, updated, cancellationToken).ConfigureAwait(false))
            {
                return SecurityChallengeEnvelopeMemberResult.Success(updated, validated.MemberIndex);
            }
        }

        return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_conflict");
    }

    public async Task<SecurityChallengeEnvelopeMemberResult> CompleteProofAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        string proofToken,
        CancellationToken cancellationToken = default)
    {
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SecurityChallengeEnvelopeState? current = await ReadAndExpireAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            SecurityChallengeEnvelopeMemberResult validated = Validate(current, request, timeProvider.GetUtcNow());
            if (!validated.Accepted || current is null)
            {
                return validated;
            }
            if (string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
            {
                return FixedEquals(current.ProofToken ?? string.Empty, proofToken)
                    ? validated
                    : SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_proof_mismatch", current, validated.MemberIndex);
            }
            if (!string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
                || !current.HasPreparedProof
                || !FixedEquals(current.ProofToken ?? string.Empty, proofToken))
            {
                return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_proof_not_ready", current, validated.MemberIndex);
            }

            var updated = current with
            {
                Status = SecurityChallengeEnvelopeStatuses.Completed,
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
            SecurityChallengeEnvelopeState? current = await ReadAndExpireAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            if (current is null || !CanFail(current, request))
            {
                return false;
            }

            int memberIndex = Array.FindIndex(current.ChallengeIds, id => FixedEquals(id, request.ChallengeId));
            string terminalReason = NormalizeReason(reason);
            string memberStatus = ResolveTerminalMemberStatus(terminalReason);
            string[] memberStatuses = (string[])current.MemberStatuses.Clone();
            memberStatuses[memberIndex] = memberStatus;
            var updated = current with
            {
                MemberStatuses = memberStatuses,
                Status = ResolveTerminalEnvelopeStatus(memberStatus),
                Version = checked(current.Version + 1),
                TerminalReason = terminalReason
            };
            if (await TryUpdateAsync(current, updated, cancellationToken).ConfigureAwait(false))
            {
                return true;
            }
        }

        return false;
    }

    public async Task<bool> RevokeAsync(
        SecurityChallengeEnvelopeBindingRequest request,
        string reason,
        CancellationToken cancellationToken = default)
    {
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SecurityChallengeEnvelopeState? current = await ReadAndExpireAsync(request.EnvelopeId, cancellationToken).ConfigureAwait(false);
            if (current is null || !HasBinding(current, request))
            {
                return false;
            }
            if (string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.Revoked, StringComparison.Ordinal))
            {
                return true;
            }
            if (string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.Failed, StringComparison.Ordinal)
                || string.Equals(current.Status, SecurityChallengeEnvelopeStatuses.Expired, StringComparison.Ordinal))
            {
                return false;
            }

            string[] memberStatuses = Enumerable.Repeat(
                SecurityChallengeEnvelopeMemberStatuses.Revoked,
                current.MemberCount).ToArray();
            var updated = current with
            {
                MemberStatuses = memberStatuses,
                Status = SecurityChallengeEnvelopeStatuses.Revoked,
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

    private async Task<SecurityChallengeEnvelopeState?> ReadAndExpireAsync(string envelopeId, CancellationToken cancellationToken)
    {
        for (int attempt = 0; attempt < MaxCasAttempts; attempt++)
        {
            SecurityChallengeEnvelopeState? current = await ReadAsync(envelopeId, cancellationToken).ConfigureAwait(false);
            if (current is null || current.ExpiresAtUnixMs > timeProvider.GetUtcNow().ToUnixTimeMilliseconds()
                || IsTerminal(current.Status))
            {
                return current;
            }

            string[] memberStatuses = current.MemberStatuses
                .Select(static status => string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Issued, StringComparison.Ordinal)
                    ? SecurityChallengeEnvelopeMemberStatuses.Expired
                    : status)
                .ToArray();
            var expired = current with
            {
                MemberStatuses = memberStatuses,
                Status = SecurityChallengeEnvelopeStatuses.Expired,
                Version = checked(current.Version + 1),
                TerminalReason = "challenge_envelope_expired"
            };
            if (await TryUpdateAsync(current, expired, cancellationToken).ConfigureAwait(false))
            {
                return expired;
            }
        }

        return await ReadAsync(envelopeId, cancellationToken).ConfigureAwait(false);
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
        TimeSpan ttl = ResolveRetentionTtl(updated, timeProvider.GetUtcNow());
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
        if (!HasBinding(state, request))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_binding_mismatch", state);
        }

        int memberIndex = Array.FindIndex(state.ChallengeIds, id => FixedEquals(id, request.ChallengeId));
        if (memberIndex < 0 || !FixedEquals(state.RequiredKinds[memberIndex], request.Kind))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_member_mismatch", state);
        }
        if (state.ExpiresAtUnixMs <= now.ToUnixTimeMilliseconds()
            || string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Expired, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_expired", state, memberIndex);
        }
        if (string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
            || string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
        {
            bool finalMember = memberIndex == state.MemberCount - 1
                && state.MemberStatuses.All(static status =>
                    string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal));
            if (finalMember && state.HasPreparedProof)
            {
                return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
            }

            string reason = string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
                ? "challenge_member_replayed"
                : "challenge_envelope_replayed";
            return SecurityChallengeEnvelopeMemberResult.Reject(reason, state, memberIndex);
        }
        if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject($"challenge_envelope_{state.Status}", state, memberIndex);
        }

        int nextIndex = Array.FindIndex(state.MemberStatuses, static status =>
            string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Issued, StringComparison.Ordinal));
        if (nextIndex < 0)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_replayed", state, memberIndex);
        }
        if (memberIndex < nextIndex
            || string.Equals(state.MemberStatuses[memberIndex], SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_replayed", state, memberIndex);
        }
        if (memberIndex != nextIndex)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_out_of_order", state, memberIndex);
        }

        return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
    }

    private static bool CanFail(SecurityChallengeEnvelopeState state, SecurityChallengeEnvelopeMemberRequest request)
    {
        if ((!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
                && !string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal))
            || !HasBinding(state, request))
        {
            return false;
        }

        int memberIndex = Array.FindIndex(state.ChallengeIds, id => FixedEquals(id, request.ChallengeId));
        return memberIndex >= 0 && FixedEquals(state.RequiredKinds[memberIndex], request.Kind);
    }

    private static bool HasBinding(SecurityChallengeEnvelopeState state, SecurityChallengeEnvelopeMemberRequest request)
        => FixedEquals(state.EnvelopeId, request.EnvelopeId)
            && FixedEquals(state.Action, request.Action)
            && FixedEquals(state.RouteKey, request.RouteKey)
            && FixedEquals(state.SubjectHash, request.SubjectHash)
            && FixedEquals(state.ClientIpHash, request.ClientIpHash)
            && FixedEquals(state.DeviceFpHash, request.DeviceFpHash)
            && FixedEquals(state.PolicyVersion, request.PolicyVersion);

    private static bool HasBinding(SecurityChallengeEnvelopeState state, SecurityChallengeEnvelopeBindingRequest request)
        => FixedEquals(state.EnvelopeId, request.EnvelopeId)
            && FixedEquals(state.Action, request.Action)
            && FixedEquals(state.RouteKey, request.RouteKey)
            && FixedEquals(state.SubjectHash, request.SubjectHash)
            && FixedEquals(state.ClientIpHash, request.ClientIpHash)
            && FixedEquals(state.DeviceFpHash, request.DeviceFpHash)
            && FixedEquals(state.PolicyVersion, request.PolicyVersion);

    private static SecurityChallengeProofPreparation ValidateProofPreparation(
        SecurityChallengeEnvelopeState state,
        SecurityChallengeProofPreparation? proofPreparation)
    {
        SecurityChallengeProofPreparation prepared = proofPreparation
            ?? throw new ArgumentException("Final member requires proof preparation.", nameof(proofPreparation));
        DateTimeOffset issuedAt = prepared.IssuedAt.ToUniversalTime();
        DateTimeOffset expiresAt = prepared.ExpiresAt.ToUniversalTime();
        DateTimeOffset envelopeExpiresAt = DateTimeOffset.FromUnixTimeMilliseconds(state.ExpiresAtUnixMs);
        if (expiresAt <= issuedAt || expiresAt > envelopeExpiresAt)
        {
            throw new ArgumentException("Prepared proof expiry is outside the envelope lifetime.", nameof(proofPreparation));
        }

        return new SecurityChallengeProofPreparation(issuedAt, expiresAt);
    }

    private static void ValidateNewState(SecurityChallengeEnvelopeState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (!IsUuidV7(state.EnvelopeId))
            throw new ArgumentException("EnvelopeId must be UUIDv7.", nameof(state));
        if (state.MemberCount is <= 0 or > 8
            || state.RequiredKinds.Length != state.MemberCount
            || state.MemberStatuses.Length != state.MemberCount
            || state.MemberStatuses.Any(static status =>
                !string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Issued, StringComparison.Ordinal))
            || state.ChallengeIds.Distinct(StringComparer.Ordinal).Count() != state.MemberCount)
            throw new ArgumentException("Envelope members are invalid.", nameof(state));
        if (state.IssuedAtUnixMs <= 0 || state.ExpiresAtUnixMs <= state.IssuedAtUnixMs)
            throw new ArgumentException("Envelope expiry is invalid.", nameof(state));
        if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
            || state.Version != 0 || state.HasPreparedProof)
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
            return state is not null
                && state.Version == version
                && state.ChallengeIds is not null
                && state.RequiredKinds is not null
                && state.MemberStatuses is not null
                && state.RequiredKinds.Length == state.ChallengeIds.Length
                && state.MemberStatuses.Length == state.ChallengeIds.Length
                ? state
                : null;
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

    private static bool IsTerminal(string status)
        => string.Equals(status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal)
            || string.Equals(status, SecurityChallengeEnvelopeStatuses.Failed, StringComparison.Ordinal)
            || string.Equals(status, SecurityChallengeEnvelopeStatuses.Expired, StringComparison.Ordinal)
            || string.Equals(status, SecurityChallengeEnvelopeStatuses.Revoked, StringComparison.Ordinal);

    private static string ResolveTerminalMemberStatus(string reason)
        => reason.Contains("replay", StringComparison.OrdinalIgnoreCase) ? SecurityChallengeEnvelopeMemberStatuses.Replayed
            : reason.Contains("expir", StringComparison.OrdinalIgnoreCase) ? SecurityChallengeEnvelopeMemberStatuses.Expired
            : reason.Contains("revok", StringComparison.OrdinalIgnoreCase) ? SecurityChallengeEnvelopeMemberStatuses.Revoked
            : SecurityChallengeEnvelopeMemberStatuses.Failed;

    private static string ResolveTerminalEnvelopeStatus(string memberStatus)
        => string.Equals(memberStatus, SecurityChallengeEnvelopeMemberStatuses.Expired, StringComparison.Ordinal)
            ? SecurityChallengeEnvelopeStatuses.Expired
            : string.Equals(memberStatus, SecurityChallengeEnvelopeMemberStatuses.Revoked, StringComparison.Ordinal)
                ? SecurityChallengeEnvelopeStatuses.Revoked
                : SecurityChallengeEnvelopeStatuses.Failed;

    private static TimeSpan ResolveRetentionTtl(SecurityChallengeEnvelopeState state, DateTimeOffset now)
        => DateTimeOffset.FromUnixTimeMilliseconds(state.ExpiresAtUnixMs).Add(s_terminalRetention) - now;

    private static string GenerateProofToken()
        => "fcp_" + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(ProofTokenRandomBytes));

    private static string GenerateProofNonce()
        => Convert.ToHexString(RandomNumberGenerator.GetBytes(ProofNonceRandomBytes)).ToLowerInvariant();

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
