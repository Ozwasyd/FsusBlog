using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeEnvelopeStateServiceTests
{
    private static readonly DateTimeOffset s_now = new(2026, 7, 19, 6, 0, 0, TimeSpan.Zero);
    private static readonly string s_envelopeId = Guid.CreateVersion7().ToString("D");
    private static readonly string s_challengeA = Guid.CreateVersion7().ToString("D");
    private static readonly string s_challengeB = Guid.CreateVersion7().ToString("D");
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Fact]
    public async Task CompleteMemberAsync_TwoOrderedMembers_CompletesOnlyAfterSecondMember()
    {
        Fixture fixture = CreateFixture();
        Assert.True(await fixture.Service.CreateAsync(CreateState()));

        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        Assert.True((await fixture.Service.ReserveMemberAsync(firstRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult first = await fixture.Service.CompleteMemberAsync(firstRequest);

        Assert.True(first.Accepted, first.Reason);
        Assert.Equal(1, first.CompletedCount);
        Assert.Equal(2, first.MemberCount);
        Assert.False(first.EnvelopeCompleted);

        SecurityChallengeEnvelopeMemberRequest finalRequest = CreateRequest(s_challengeB, "sha256PowV1");
        Assert.True((await fixture.Service.CompleteIssuanceAsync(finalRequest, 1)).Accepted);
        Assert.True((await fixture.Service.ReserveMemberAsync(finalRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult second = await fixture.Service.CompleteMemberAsync(finalRequest, CreateProofPreparation());

        Assert.True(second.Accepted, second.Reason);
        Assert.Equal(2, second.CompletedCount);
        Assert.False(second.EnvelopeCompleted);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.ProofMinting, second.State?.Status);
        Assert.All(second.State!.MemberStatuses, status => Assert.Equal(SecurityChallengeEnvelopeMemberStatuses.Verified, status));

        SecurityChallengeEnvelopeMemberResult completed = await fixture.Service.CompleteProofAsync(
            finalRequest,
            second.State.ProofToken!);

        Assert.True(completed.EnvelopeCompleted);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Completed, completed.State?.Status);
    }

    [Fact]
    public async Task ValidateMemberAsync_OutOfOrder_DoesNotConsumeEarlierProgress()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        SecurityChallengeEnvelopeMemberResult outOfOrder = await fixture.Service.ValidateMemberAsync(CreateRequest(s_challengeB, "sha256PowV1"));
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        Assert.True((await fixture.Service.ReserveMemberAsync(firstRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult first = await fixture.Service.CompleteMemberAsync(firstRequest);

        Assert.False(outOfOrder.Accepted);
        Assert.Equal("challenge_member_out_of_order", outOfOrder.Reason);
        Assert.True(first.Accepted, first.Reason);
        Assert.Equal(1, first.CompletedCount);
    }

    [Fact]
    public async Task CompleteMemberAsync_DuplicateEarlierMemberRejected_FinalMemberIsIdempotent()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        await fixture.Service.ReserveMemberAsync(firstRequest);
        await fixture.Service.CompleteMemberAsync(firstRequest);

        SecurityChallengeEnvelopeMemberResult duplicate = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "perceptionCharacterV3"));
        SecurityChallengeEnvelopeMemberRequest finalRequest = CreateRequest(s_challengeB, "sha256PowV1");
        Assert.True((await fixture.Service.CompleteIssuanceAsync(finalRequest, 1)).Accepted);
        Assert.True((await fixture.Service.ReserveMemberAsync(finalRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult prepared = await fixture.Service.CompleteMemberAsync(finalRequest, CreateProofPreparation());
        SecurityChallengeEnvelopeMemberResult retry = await fixture.Service.CompleteMemberAsync(finalRequest, CreateProofPreparation());
        await fixture.Service.CompleteProofAsync(finalRequest, prepared.State!.ProofToken!);
        SecurityChallengeEnvelopeMemberResult responseLossRetry = await fixture.Service.ValidateMemberAsync(finalRequest);

        Assert.False(duplicate.Accepted);
        Assert.Equal("challenge_member_replayed", duplicate.Reason);
        Assert.True(retry.Accepted, retry.Reason);
        Assert.Equal(prepared.State.ProofToken, retry.State?.ProofToken);
        Assert.True(responseLossRetry.Accepted, responseLossRetry.Reason);
        Assert.True(responseLossRetry.EnvelopeCompleted);
    }

    [Fact]
    public async Task ValidateMemberAsync_BindingMismatchAndUnknownMember_FailClosed()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        SecurityChallengeEnvelopeMemberResult binding = await fixture.Service.ValidateMemberAsync(
            CreateRequest(s_challengeA, "perceptionCharacterV3") with
            {
                RouteKey = "article:43"
            });
        SecurityChallengeEnvelopeMemberResult unknown = await fixture.Service.ValidateMemberAsync(
            CreateRequest(Guid.CreateVersion7().ToString("D"), "perceptionCharacterV3"));

        Assert.Equal("challenge_envelope_binding_mismatch", binding.Reason);
        Assert.Equal("challenge_envelope_member_mismatch", unknown.Reason);
    }

    [Fact]
    public async Task FailAsync_MakesEnvelopeTerminalAndPreservesNoAggregateCompletion()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        Assert.True(await fixture.Service.FailAsync(CreateRequest(s_challengeA, "perceptionCharacterV3"), "characterChallenge_invalid"));
        SecurityChallengeEnvelopeMemberResult next = await fixture.Service.ValidateMemberAsync(CreateRequest(s_challengeA, "perceptionCharacterV3"));

        Assert.False(next.Accepted);
        Assert.Equal("challenge_envelope_failed", next.Reason);
        Assert.False(next.EnvelopeCompleted);
        Assert.Equal(SecurityChallengeEnvelopeMemberStatuses.Failed, next.State?.MemberStatuses[0]);
    }

    [Fact]
    public async Task FailAsync_VerifiedMemberReplayTerminatesStillActiveEnvelope()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        await fixture.Service.ReserveMemberAsync(firstRequest);
        await fixture.Service.CompleteMemberAsync(firstRequest);

        bool failed = await fixture.Service.FailAsync(
            CreateRequest(s_challengeA, "perceptionCharacterV3"),
            "challenge_member_replayed");
        SecurityChallengeEnvelopeMemberResult next = await fixture.Service.ValidateMemberAsync(
            CreateRequest(s_challengeB, "sha256PowV1"));

        Assert.True(failed);
        Assert.False(next.Accepted);
        Assert.Equal("challenge_envelope_failed", next.Reason);
        Assert.Equal(SecurityChallengeEnvelopeMemberStatuses.Replayed, next.State?.MemberStatuses[0]);
    }

    [Fact]
    public async Task ValidateMemberAsync_ExpiredEnvelope_FailsClosed()
    {
        var clock = new MutableTimeProvider(s_now);
        var cache = new FakeVersionedCache();
        var service = new SecurityChallengeEnvelopeStateService(cache, cache, clock);
        await service.CreateAsync(CreateState());
        clock.UtcNow = s_now.AddMinutes(6);

        SecurityChallengeEnvelopeMemberResult result = await service.ValidateMemberAsync(CreateRequest(s_challengeA, "perceptionCharacterV3"));

        Assert.False(result.Accepted);
        Assert.Equal("challenge_envelope_expired", result.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Expired, result.State?.Status);
        Assert.All(result.State!.MemberStatuses, status => Assert.Equal(SecurityChallengeEnvelopeMemberStatuses.Expired, status));
    }

    [Fact]
    public async Task CompleteMemberAsync_ConcurrentAdvance_ReservesNextMemberOnce()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest request = CreateRequest(s_challengeA, "perceptionCharacterV3");

        SecurityChallengeEnvelopeMemberResult[] results = await Task.WhenAll(
            fixture.Service.ReserveMemberAsync(request),
            fixture.Service.ReserveMemberAsync(request));

        SecurityChallengeEnvelopeMemberResult winner = Assert.Single(results, static result => result.Accepted);
        Assert.Equal(0, winner.MemberIndex);
        SecurityChallengeEnvelopeMemberResult loser = Assert.Single(results, static result => !result.Accepted);
        Assert.Equal("challenge_envelope_transition_pending", loser.Reason);
        SecurityChallengeEnvelopeState? state = await fixture.Service.GetAsync(s_envelopeId);
        Assert.NotNull(state);
        Assert.Equal(
            [SecurityChallengeEnvelopeMemberStatuses.Verifying, SecurityChallengeEnvelopeMemberStatuses.Planned],
            state.MemberStatuses);
    }

    [Fact]
    public async Task CompleteIssuanceAsync_ExpiryBetweenMembers_ExpiresReservedMember()
    {
        var clock = new MutableTimeProvider(s_now);
        var cache = new FakeVersionedCache();
        var service = new SecurityChallengeEnvelopeStateService(cache, cache, clock);
        await service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        await service.ReserveMemberAsync(firstRequest);
        await service.CompleteMemberAsync(firstRequest);
        clock.UtcNow = s_now.AddMinutes(6);

        SecurityChallengeEnvelopeMemberResult result = await service.CompleteIssuanceAsync(
            CreateRequest(s_challengeB, "sha256PowV1"),
            1);

        Assert.False(result.Accepted);
        Assert.Equal("challenge_envelope_issuance_not_reserved", result.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Expired, result.State?.Status);
        Assert.NotNull(result.State);
        Assert.Equal(
            [SecurityChallengeEnvelopeMemberStatuses.Verified, SecurityChallengeEnvelopeMemberStatuses.Expired],
            result.State.MemberStatuses);
    }

    [Fact]
    public async Task CompleteMemberAsync_RedisReplyLossAfterReservation_FailsClosedWithoutSecondReservation()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        fixture.Cache.LoseReplyOnNextSuccessfulWrite = true;
        SecurityChallengeEnvelopeMemberRequest request = CreateRequest(s_challengeA, "perceptionCharacterV3");

        SecurityChallengeEnvelopeMemberResult result = await fixture.Service.ReserveMemberAsync(request);
        SecurityChallengeEnvelopeMemberResult retry = await fixture.Service.ReserveMemberAsync(request);

        Assert.False(result.Accepted);
        Assert.Equal("challenge_envelope_transition_pending", result.Reason);
        Assert.False(retry.Accepted);
        Assert.Equal("challenge_envelope_transition_pending", retry.Reason);
        SecurityChallengeEnvelopeState? state = await fixture.Service.GetAsync(s_envelopeId);
        Assert.NotNull(state);
        Assert.Equal(
            [SecurityChallengeEnvelopeMemberStatuses.Verifying, SecurityChallengeEnvelopeMemberStatuses.Planned],
            state.MemberStatuses);
    }

    [Fact]
    public async Task RevokeAsync_RevokesIncompleteMembersAndBlocksFinalCompletion()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        await fixture.Service.ReserveMemberAsync(firstRequest);
        await fixture.Service.CompleteMemberAsync(firstRequest);

        bool revoked = await fixture.Service.RevokeAsync(CreateBindingRequest(), "client_cancelled");
        SecurityChallengeEnvelopeMemberResult final = await fixture.Service.ValidateMemberAsync(
            CreateRequest(s_challengeB, "sha256PowV1"));

        Assert.True(revoked);
        Assert.False(final.Accepted);
        Assert.Equal("challenge_envelope_revoked", final.Reason);
        Assert.NotNull(final.State);
        Assert.Equal(
            [SecurityChallengeEnvelopeMemberStatuses.Revoked, SecurityChallengeEnvelopeMemberStatuses.Revoked],
            final.State.MemberStatuses);
    }

    [Fact]
    public async Task RevokeAsync_CompletedEnvelopeInvalidatesPreparedProofState()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        await fixture.Service.ReserveMemberAsync(firstRequest);
        await fixture.Service.CompleteMemberAsync(firstRequest);
        SecurityChallengeEnvelopeMemberRequest finalRequest = CreateRequest(s_challengeB, "sha256PowV1");
        Assert.True((await fixture.Service.CompleteIssuanceAsync(finalRequest, 1)).Accepted);
        Assert.True((await fixture.Service.ReserveMemberAsync(finalRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult prepared = await fixture.Service.CompleteMemberAsync(finalRequest, CreateProofPreparation());
        await fixture.Service.CompleteProofAsync(finalRequest, prepared.State!.ProofToken!);

        Assert.True(await fixture.Service.RevokeAsync(CreateBindingRequest(), "identity_replaced"));

        SecurityChallengeEnvelopeState? state = await fixture.Service.GetAsync(s_envelopeId);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Revoked, state?.Status);
        Assert.Equal(prepared.State.ProofToken, state?.ProofToken);
    }

    [Fact]
    public async Task ProofMinting_EarlierMemberReplayTerminatesBeforeProofCompletion()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        SecurityChallengeEnvelopeMemberRequest firstRequest = CreateRequest(s_challengeA, "perceptionCharacterV3");
        SecurityChallengeEnvelopeMemberRequest finalRequest = CreateRequest(s_challengeB, "sha256PowV1");
        await fixture.Service.ReserveMemberAsync(firstRequest);
        await fixture.Service.CompleteMemberAsync(firstRequest);
        Assert.True((await fixture.Service.CompleteIssuanceAsync(finalRequest, 1)).Accepted);
        Assert.True((await fixture.Service.ReserveMemberAsync(finalRequest)).Accepted);
        SecurityChallengeEnvelopeMemberResult prepared = await fixture.Service.CompleteMemberAsync(
            finalRequest,
            CreateProofPreparation());

        SecurityChallengeEnvelopeMemberResult replay = await fixture.Service.ValidateMemberAsync(firstRequest);
        Assert.Equal("challenge_member_replayed", replay.Reason);
        Assert.True(await fixture.Service.FailAsync(firstRequest, replay.Reason));
        SecurityChallengeEnvelopeMemberResult completed = await fixture.Service.CompleteProofAsync(
            finalRequest,
            prepared.State!.ProofToken!);

        Assert.False(completed.Accepted);
        Assert.Equal("challenge_envelope_failed", completed.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Failed, completed.State?.Status);
    }

    private static Fixture CreateFixture()
    {
        var cache = new FakeVersionedCache();
        return new Fixture(new SecurityChallengeEnvelopeStateService(cache, cache, new MutableTimeProvider(s_now)), cache);
    }

    private static SecurityChallengeEnvelopeState CreateState()
        => new(
            s_envelopeId,
            "comment.create",
            "article:42",
            HashA,
            HashB,
            HashC,
            "risk-v2",
            [s_challengeA, s_challengeB],
            ["perceptionCharacterV3", "sha256PowV1"],
            [SecurityChallengeEnvelopeMemberStatuses.Issued, SecurityChallengeEnvelopeMemberStatuses.Planned],
            s_now.ToUnixTimeMilliseconds(),
            s_now.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0);

    private static SecurityChallengeEnvelopeMemberRequest CreateRequest(string challengeId, string kind)
        => new(s_envelopeId, challengeId, kind, "comment.create", "article:42", HashA, HashB, HashC, "risk-v2");

    private static SecurityChallengeEnvelopeBindingRequest CreateBindingRequest()
        => new(s_envelopeId, "comment.create", "article:42", HashA, HashB, HashC, "risk-v2");

    private static SecurityChallengeProofPreparation CreateProofPreparation()
        => new(s_now, s_now.AddMinutes(4));

    private sealed class FakeVersionedCache : ICacheStringReader, ICacheCompareExchangeStore
    {
        private readonly Dictionary<string, string> _values = new(StringComparer.Ordinal);

        public bool LoseReplyOnNextSuccessfulWrite
        {
            get; set;
        }

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_values)
            {
                return Task.FromResult(_values.GetValueOrDefault(Key(policyId, identity)));
            }
        }

        public Task<bool> TrySetVersionedStringAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            string version,
            bool allowOverwrite = false,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string key = Key(policyId, identity);
            lock (_values)
            {
                if (_values.TryGetValue(key, out string? current) && !allowOverwrite)
                {
                    string[] parts = current.Split('|', 3, StringSplitOptions.None);
                    if (parts.Length != 3 || !string.Equals(parts[0], "v1", StringComparison.Ordinal)
                        || !string.Equals(parts[1], version, StringComparison.Ordinal))
                    {
                        return Task.FromResult(false);
                    }
                }

                _values[key] = value;
                if (LoseReplyOnNextSuccessfulWrite)
                {
                    LoseReplyOnNextSuccessfulWrite = false;
                    return Task.FromResult(false);
                }
                return Task.FromResult(true);
            }
        }

        private static string Key(CachePolicyId policyId, string identity) => $"{policyId}:{identity}";
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed record Fixture(SecurityChallengeEnvelopeStateService Service, FakeVersionedCache Cache);
}
