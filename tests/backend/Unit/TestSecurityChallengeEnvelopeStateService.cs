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

    public Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = GetOrCreate(request);
        return Task.FromResult(Validate(state, request));
    }

    public Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = GetOrCreate(request);
        SecurityChallengeEnvelopeMemberResult validation = Validate(state, request);
        if (!validation.Accepted || state is null)
        {
            return Task.FromResult(validation);
        }

        bool[] verified = (bool[])state.VerifiedMembers.Clone();
        verified[validation.MemberIndex] = true;
        var updated = state with
        {
            VerifiedMembers = verified,
            Status = verified.All(static value => value)
                ? SecurityChallengeEnvelopeStatuses.Completed
                : SecurityChallengeEnvelopeStatuses.Active,
            Version = state.Version + 1
        };
        _states[state.EnvelopeId] = updated;
        return Task.FromResult(SecurityChallengeEnvelopeMemberResult.Success(updated, validation.MemberIndex));
    }

    public Task<bool> FailAsync(SecurityChallengeEnvelopeMemberRequest request, string reason, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SecurityChallengeEnvelopeState? state = GetOrCreate(request);
        if (state is null)
        {
            return Task.FromResult(false);
        }
        _states[state.EnvelopeId] = state with
        {
            Status = SecurityChallengeEnvelopeStatuses.Failed,
            TerminalReason = reason,
            Version = state.Version + 1
        };
        return Task.FromResult(true);
    }

    public SecurityChallengeEnvelopeState? Get(string envelopeId) => _states.GetValueOrDefault(envelopeId);

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
            [false],
            now,
            now + 300_000,
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0);
        _states.TryAdd(request.EnvelopeId, state);
        return state;
    }

    private static SecurityChallengeEnvelopeMemberResult Validate(SecurityChallengeEnvelopeState? state, SecurityChallengeEnvelopeMemberRequest request)
    {
        if (state is null)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_missing");
        }
        if (!string.Equals(state.Status, SecurityChallengeEnvelopeStatuses.Active, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject($"challenge_envelope_{state.Status}", state);
        }
        if (!string.Equals(state.Action, request.Action, StringComparison.Ordinal)
            || !string.Equals(state.RouteKey, request.RouteKey, StringComparison.Ordinal)
            || !string.Equals(state.SubjectHash, request.SubjectHash, StringComparison.Ordinal)
            || !string.Equals(state.ClientIpHash, request.ClientIpHash, StringComparison.Ordinal)
            || !string.Equals(state.DeviceFpHash, request.DeviceFpHash, StringComparison.Ordinal)
            || !string.Equals(state.PolicyVersion, request.PolicyVersion, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_binding_mismatch", state);
        }
        int memberIndex = Array.IndexOf(state.ChallengeIds, request.ChallengeId);
        if (memberIndex < 0 || !string.Equals(state.RequiredKinds[memberIndex], request.Kind, StringComparison.Ordinal))
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_envelope_member_mismatch", state);
        }
        int next = Array.FindIndex(state.VerifiedMembers, static value => !value);
        if (memberIndex < next || state.VerifiedMembers[memberIndex])
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_replayed", state, memberIndex);
        }
        if (memberIndex != next)
        {
            return SecurityChallengeEnvelopeMemberResult.Reject("challenge_member_out_of_order", state, memberIndex);
        }
        return SecurityChallengeEnvelopeMemberResult.Success(state, memberIndex);
    }
}
