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

        SecurityChallengeEnvelopeMemberResult first = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        Assert.True(first.Accepted, first.Reason);
        Assert.Equal(1, first.CompletedCount);
        Assert.Equal(2, first.MemberCount);
        Assert.False(first.EnvelopeCompleted);

        SecurityChallengeEnvelopeMemberResult second = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeB, "sha256PowV1"));

        Assert.True(second.Accepted, second.Reason);
        Assert.Equal(2, second.CompletedCount);
        Assert.True(second.EnvelopeCompleted);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Completed, second.State?.Status);
    }

    [Fact]
    public async Task ValidateMemberAsync_OutOfOrder_DoesNotConsumeEarlierProgress()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        SecurityChallengeEnvelopeMemberResult outOfOrder = await fixture.Service.ValidateMemberAsync(CreateRequest(s_challengeB, "sha256PowV1"));
        SecurityChallengeEnvelopeMemberResult first = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        Assert.False(outOfOrder.Accepted);
        Assert.Equal("challenge_member_out_of_order", outOfOrder.Reason);
        Assert.True(first.Accepted, first.Reason);
        Assert.Equal(1, first.CompletedCount);
    }

    [Fact]
    public async Task CompleteMemberAsync_DuplicateAndCompletedReplay_AreRejected()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        SecurityChallengeEnvelopeMemberResult duplicate = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "captchaV1"));
        await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeB, "sha256PowV1"));
        SecurityChallengeEnvelopeMemberResult replay = await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeB, "sha256PowV1"));

        Assert.False(duplicate.Accepted);
        Assert.Equal("challenge_member_replayed", duplicate.Reason);
        Assert.False(replay.Accepted);
        Assert.Equal("challenge_envelope_replayed", replay.Reason);
    }

    [Fact]
    public async Task ValidateMemberAsync_BindingMismatchAndUnknownMember_FailClosed()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        SecurityChallengeEnvelopeMemberResult binding = await fixture.Service.ValidateMemberAsync(
            CreateRequest(s_challengeA, "captchaV1") with
            {
                RouteKey = "article:43"
            });
        SecurityChallengeEnvelopeMemberResult unknown = await fixture.Service.ValidateMemberAsync(
            CreateRequest(Guid.CreateVersion7().ToString("D"), "captchaV1"));

        Assert.Equal("challenge_envelope_binding_mismatch", binding.Reason);
        Assert.Equal("challenge_envelope_member_mismatch", unknown.Reason);
    }

    [Fact]
    public async Task FailAsync_MakesEnvelopeTerminalAndPreservesNoAggregateCompletion()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());

        Assert.True(await fixture.Service.FailAsync(CreateRequest(s_challengeA, "captchaV1"), "captcha_invalid"));
        SecurityChallengeEnvelopeMemberResult next = await fixture.Service.ValidateMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        Assert.False(next.Accepted);
        Assert.Equal("challenge_envelope_failed", next.Reason);
        Assert.False(next.EnvelopeCompleted);
    }

    [Fact]
    public async Task FailAsync_VerifiedMemberReplayTerminatesStillActiveEnvelope()
    {
        Fixture fixture = CreateFixture();
        await fixture.Service.CreateAsync(CreateState());
        await fixture.Service.CompleteMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        bool failed = await fixture.Service.FailAsync(
            CreateRequest(s_challengeA, "captchaV1"),
            "challenge_member_replayed");
        SecurityChallengeEnvelopeMemberResult next = await fixture.Service.ValidateMemberAsync(
            CreateRequest(s_challengeB, "sha256PowV1"));

        Assert.True(failed);
        Assert.False(next.Accepted);
        Assert.Equal("challenge_envelope_failed", next.Reason);
    }

    [Fact]
    public async Task ValidateMemberAsync_ExpiredEnvelope_FailsClosed()
    {
        var clock = new MutableTimeProvider(s_now);
        var cache = new FakeVersionedCache();
        var service = new SecurityChallengeEnvelopeStateService(cache, cache, clock);
        await service.CreateAsync(CreateState());
        clock.UtcNow = s_now.AddMinutes(6);

        SecurityChallengeEnvelopeMemberResult result = await service.ValidateMemberAsync(CreateRequest(s_challengeA, "captchaV1"));

        Assert.False(result.Accepted);
        Assert.Equal("challenge_envelope_expired", result.Reason);
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
            ["captchaV1", "sha256PowV1"],
            [false, false],
            s_now.ToUnixTimeMilliseconds(),
            s_now.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0);

    private static SecurityChallengeEnvelopeMemberRequest CreateRequest(string challengeId, string kind)
        => new(s_envelopeId, challengeId, kind, "comment.create", "article:42", HashA, HashB, HashC, "risk-v2");

    private sealed class FakeVersionedCache : ICacheStringReader, ICacheCompareExchangeStore
    {
        private readonly Dictionary<string, string> _values = new(StringComparer.Ordinal);

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.GetValueOrDefault(Key(policyId, identity)));
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
            return Task.FromResult(true);
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
