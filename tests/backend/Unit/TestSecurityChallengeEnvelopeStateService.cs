using System.Collections.Concurrent;

using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

internal sealed class TestSecurityChallengeEnvelopeStateService(bool autoCreateSingleMember = true) : ISecurityChallengeEnvelopeStateService
{
    private readonly ConcurrentDictionary<string, SecurityChallengeEnvelopeState> _states = new(StringComparer.Ordinal);

    public Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_states.TryAdd(state.EnvelopeId, state));
    }

    public Task<SecurityChallengeEnvelopeState?> GetAsync(string envelopeId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Get(envelopeId));
    }

    public Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = GetOrCreate(request);
        return Task.FromResult(Validate(state, request));
    }

    public Task<SecurityChallengeEnvelopeMemberResult> ReserveMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = GetOrCreate(request);
            SecurityChallengeEnvelopeMemberResult validation = Validate(state, request);
            if (!validation.Accepted || state is null)
                return Task.FromResult(validation);
            string[] statuses = (string[])state.MemberStatuses.Clone();
            statuses[validation.MemberIndex] = SecurityChallengeEnvelopeMemberStatuses.Verifying;
            SecurityChallengeEnvelopeState updated = state with
            {
                MemberStatuses = statuses,
                Version = state.Version + 1
            };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Success(updated, validation.MemberIndex));
        }
    }

    public Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        SecurityChallengeProofPreparation? proofPreparation = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = GetOrCreate(request);
            SecurityChallengeEnvelopeMemberResult validation = ValidateReserved(state, request);
            if (!validation.Accepted || state is null
                || !string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
            {
                return Task.FromResult(validation);
            }

            string[] memberStatuses = (string[])state.MemberStatuses.Clone();
            memberStatuses[validation.MemberIndex] = SecurityChallengeEnvelopeMemberStatuses.Verified;
            bool allVerified = memberStatuses.All(static status =>
                string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal));
            SecurityChallengeEnvelopeState updated = allVerified
                ? state with
                {
                    MemberStatuses = memberStatuses,
                    Status = SecurityChallengeEnvelopeStatuses.ProofMinting,
                    ProofToken = $"fcp_{state.EnvelopeId.Replace("-", string.Empty, StringComparison.Ordinal)}",
                    ProofNonce = "test-proof-nonce",
                    ProofIssuedAtUnixMs = (proofPreparation ?? throw new ArgumentException("proof preparation required", nameof(proofPreparation))).IssuedAt.ToUnixTimeMilliseconds(),
                    ProofExpiresAtUnixMs = proofPreparation.ExpiresAt.ToUnixTimeMilliseconds(),
                    Version = state.Version + 1
                }
                : state with
                {
                    MemberStatuses = ReserveNext(memberStatuses, validation.MemberIndex),
                    Version = state.Version + 1
                };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
            {
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Success(
                    updated, validation.MemberIndex, allVerified ? -1 : validation.MemberIndex + 1));
            }
        }
    }

    public Task<SecurityChallengeEnvelopeMemberResult> CompleteIssuanceAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        int memberIndex,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = GetOrCreate(request);
            if (state is null || memberIndex < 0 || memberIndex >= state.MemberCount
                || !string.Equals(state.MemberStatuses[memberIndex], SecurityChallengeEnvelopeMemberStatuses.Issuing, StringComparison.Ordinal))
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_issuance_not_reserved", state, memberIndex));
            string[] statuses = (string[])state.MemberStatuses.Clone();
            statuses[memberIndex] = SecurityChallengeEnvelopeMemberStatuses.Issued;
            SecurityChallengeEnvelopeState updated = state with
            {
                MemberStatuses = statuses,
                Version = state.Version + 1
            };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Success(updated, memberIndex));
        }
    }

    public Task<SecurityChallengeEnvelopeMemberResult> CompleteProofAsync(
        SecurityChallengeEnvelopeMemberRequest request,
        string proofToken,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = GetOrCreate(request);
            SecurityChallengeEnvelopeMemberResult validation = Validate(state, request);
            if (!validation.Accepted || state is null)
            {
                return Task.FromResult(validation);
            }
            if (string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
            {
                return Task.FromResult(validation);
            }
            if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
                || !string.Equals(state.ProofToken, proofToken, StringComparison.Ordinal))
            {
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_proof_not_ready", state));
            }

            SecurityChallengeEnvelopeState updated = state with
            {
                Status = SecurityChallengeEnvelopeStatuses.Completed,
                Version = state.Version + 1
            };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
            {
                return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Success(updated, validation.MemberIndex));
            }
        }
    }

    public Task<bool> FailAsync(SecurityChallengeEnvelopeMemberRequest request, string reason, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = GetOrCreate(request);
            if (state is null
                || (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal)
                    && !string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)))
            {
                return Task.FromResult(false);
            }
            int memberIndex = Array.IndexOf(state.ChallengeIds, request.ChallengeId);
            if (memberIndex < 0)
            {
                return Task.FromResult(false);
            }
            string[] memberStatuses = (string[])state.MemberStatuses.Clone();
            memberStatuses[memberIndex] = reason.Contains("replay", StringComparison.OrdinalIgnoreCase)
                ? SecurityChallengeEnvelopeMemberStatuses.Replayed
                : SecurityChallengeEnvelopeMemberStatuses.Failed;
            SecurityChallengeEnvelopeState updated = state with
            {
                MemberStatuses = memberStatuses,
                Status = SecurityChallengeEnvelopeStatuses.Failed,
                TerminalReason = reason,
                Version = state.Version + 1
            };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
            {
                return Task.FromResult(true);
            }
        }
    }

    public Task<bool> RevokeAsync(SecurityChallengeEnvelopeBindingRequest request, string reason, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        while (true)
        {
            SecurityChallengeEnvelopeState? state = Get(request.EnvelopeId);
            if (state is null || !HasBinding(state, request))
            {
                return Task.FromResult(false);
            }
            if (string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Revoked, StringComparison.Ordinal))
            {
                return Task.FromResult(true);
            }
            string[] memberStatuses = Enumerable.Repeat(
                SecurityChallengeEnvelopeMemberStatuses.Revoked,
                state.MemberCount).ToArray();
            SecurityChallengeEnvelopeState updated = state with
            {
                MemberStatuses = memberStatuses,
                Status = SecurityChallengeEnvelopeStatuses.Revoked,
                TerminalReason = reason,
                Version = state.Version + 1
            };
            if (_states.TryUpdate(state.EnvelopeId, updated, state))
            {
                return Task.FromResult(true);
            }
        }
    }

    public SecurityChallengeEnvelopeState? Get(string envelopeId) => _states.GetValueOrDefault(envelopeId);

    private static string[] ReserveNext(string[] statuses, int memberIndex)
    {
        statuses[memberIndex + 1] = SecurityChallengeEnvelopeMemberStatuses.Issuing;
        return statuses;
    }

    private SecurityChallengeEnvelopeState? GetOrCreate(SecurityChallengeEnvelopeMemberRequest request)
    {
        if (_states.TryGetValue(request.EnvelopeId, out SecurityChallengeEnvelopeState? state))
        {
            return state;
        }
        if (!autoCreateSingleMember)
        {
            return null;
        }

        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        state = new SecurityChallengeEnvelopeState(
            request.EnvelopeId,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion,
            [request.ChallengeId],
            [request.Kind],
            [SecurityChallengeEnvelopeMemberStatuses.Issued],
            now,
            now + 300_000,
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0);
        _states.TryAdd(request.EnvelopeId, state);
        return _states.GetValueOrDefault(request.EnvelopeId);
    }

    private static SecurityChallengeEnvelopeMemberResult Validate(SecurityChallengeEnvelopeState? state, SecurityChallengeEnvelopeMemberRequest request)
    {
        if (state is null)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_missing");
        }
        if (!HasBinding(state, request))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_binding_mismatch", state);
        }
        int memberIndex = Array.IndexOf(state.ChallengeIds, request.ChallengeId);
        if (memberIndex < 0 || !string.Equals(state.RequiredKinds[memberIndex], request.Kind, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_member_mismatch", state);
        }
        if (string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
            || string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
        {
            if (memberIndex == state.MemberCount - 1 && state.HasPreparedProof)
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
        int next = Array.FindIndex(state.MemberStatuses, static status =>
            string.Equals(status, SecurityChallengeEnvelopeMemberStatuses.Issued, StringComparison.Ordinal));
        if (memberIndex < next
            || string.Equals(state.MemberStatuses[memberIndex], SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_replayed", state, memberIndex);
        }
        if (memberIndex != next)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_out_of_order", state, memberIndex);
        }
        return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
    }

    private static SecurityChallengeEnvelopeMemberResult ValidateReserved(
        SecurityChallengeEnvelopeState? state,
        SecurityChallengeEnvelopeMemberRequest request)
    {
        if (state is null)
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_missing");
        if (!HasBinding(state, request))
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_binding_mismatch", state);
        int memberIndex = Array.IndexOf(state.ChallengeIds, request.ChallengeId);
        if (memberIndex < 0 || !string.Equals(state.RequiredKinds[memberIndex], request.Kind, StringComparison.Ordinal))
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_member_mismatch", state);
        if ((string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.ProofMinting, StringComparison.Ordinal)
                || string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Completed, StringComparison.Ordinal))
            && memberIndex == state.MemberCount - 1 && state.HasPreparedProof)
            return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
        if (string.Equals(state.MemberStatuses[memberIndex], SecurityChallengeEnvelopeMemberStatuses.Verified, StringComparison.Ordinal))
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_replayed", state, memberIndex);
        return string.Equals(state.MemberStatuses[memberIndex], SecurityChallengeEnvelopeMemberStatuses.Verifying, StringComparison.Ordinal)
            ? SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex)
            : SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_not_reserved", state, memberIndex);
    }

    private static bool HasBinding(SecurityChallengeEnvelopeState state, SecurityChallengeEnvelopeMemberRequest request)
        => string.Equals(state.Action, request.Action, StringComparison.Ordinal)
            && string.Equals(state.RouteKey, request.RouteKey, StringComparison.Ordinal)
            && string.Equals(state.SubjectHash, request.SubjectHash, StringComparison.Ordinal)
            && string.Equals(state.ClientIpHash, request.ClientIpHash, StringComparison.Ordinal)
            && string.Equals(state.DeviceFpHash, request.DeviceFpHash, StringComparison.Ordinal)
            && string.Equals(state.PolicyVersion, request.PolicyVersion, StringComparison.Ordinal);

    private static bool HasBinding(SecurityChallengeEnvelopeState state, SecurityChallengeEnvelopeBindingRequest request)
        => string.Equals(state.Action, request.Action, StringComparison.Ordinal)
            && string.Equals(state.RouteKey, request.RouteKey, StringComparison.Ordinal)
            && string.Equals(state.SubjectHash, request.SubjectHash, StringComparison.Ordinal)
            && string.Equals(state.ClientIpHash, request.ClientIpHash, StringComparison.Ordinal)
            && string.Equals(state.DeviceFpHash, request.DeviceFpHash, StringComparison.Ordinal)
            && string.Equals(state.PolicyVersion, request.PolicyVersion, StringComparison.Ordinal);
}
