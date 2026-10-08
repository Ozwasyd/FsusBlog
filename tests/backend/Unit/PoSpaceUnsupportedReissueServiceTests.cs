using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PoSpaceUnsupportedReissueServiceTests
{
    private const string ChallengeId = "01900000-0000-7000-8000-000000000000";
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-19T00:00:00Z");

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task ReissueAsync_ValidAssignmentWithoutPolicyReplacement_RevokesAndFailsClosed()
    {
        Fixture fixture = CreateFixture();

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            CreateRequest(),
            CreateDecision(Argon2idPoSpaceV1ChallengeProvider.WireKind),
            CreatePolicy(characterChallengeMode: SecuritySystemModes.Enforce));

        Assert.False(result.Accepted);
        Assert.Equal(RiskDecisionKind.Block, result.Decision.Kind);
        Assert.Empty(result.Decision.RequiredChallenges);
        await fixture.Cache.Received(1).RemoveAsync(CachePolicyId.SecurityPoSpaceChallenge, ChallengeId, Arg.Any<CancellationToken>());
        await fixture.Store.Received(1).TryRevokeIssuedAsync(ChallengeId, s_now.UtcDateTime, Arg.Any<CancellationToken>());
        await fixture.Persistence.Received(1).RecordAttemptAsync(
            Arg.Is<SecurityChallengeAttemptRequest>(item => item.Reason == "pospace_unsupported:memory_tier_cap:1"),
            Arg.Any<CancellationToken>());
        await fixture.RiskSink.Received(1).AddRiskAsync(
            Arg.Is<SecurityRiskSignal>(item => item.Detail == "pospace_unsupported_rejected:memory_tier_cap"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task ReissueAsync_NoAllowedFallback_FailsClosedAfterRevokingOldProof()
    {
        Fixture fixture = CreateFixture(fallback: "reject");

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            CreateRequest(),
            CreateDecision(Argon2idPoSpaceV1ChallengeProvider.WireKind),
            CreatePolicy(characterChallengeMode: SecuritySystemModes.Disabled));

        Assert.False(result.Accepted);
        Assert.Equal(RiskDecisionKind.Block, result.Decision.Kind);
        Assert.Empty(result.Decision.RequiredChallenges);
        await fixture.Store.Received(1).TryRevokeIssuedAsync(ChallengeId, s_now.UtcDateTime, Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pospace-reissue-binding-required")]
    public async Task ReissueAsync_MismatchedBinding_IsRejectedWithoutMutation()
    {
        Fixture fixture = CreateFixture();
        PoSpaceUnsupportedReissueRequest request = CreateRequest() with
        {
            Binding = new RiskControlProofBinding(HashA, HashB, new string('d', 64))
        };

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            request,
            CreateDecision(Argon2idPoSpaceV1ChallengeProvider.WireKind),
            CreatePolicy(SecuritySystemModes.Enforce));

        Assert.False(result.Accepted);
        Assert.Equal(RiskDecisionKind.Block, result.Decision.Kind);
        await fixture.Store.DidNotReceiveWithAnyArgs().TryRevokeIssuedAsync(default!, default, default);
        await fixture.Cache.DidNotReceive().RemoveAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pospace-reissue-counter-monotonic")]
    public async Task ReissueAsync_ReissueCounterMismatch_StopsLoopAndRevokesOldProof()
    {
        Fixture fixture = CreateFixture(priorUnsupportedAttempts: 1);

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            CreateRequest(reissueCount: 1),
            CreateDecision(Argon2idPoSpaceV1ChallengeProvider.WireKind),
            CreatePolicy(SecuritySystemModes.Enforce));

        Assert.False(result.Accepted);
        Assert.Equal("pospace_reissue_loop_blocked", result.Reason);
        await fixture.Store.Received(1).TryRevokeIssuedAsync(ChallengeId, s_now.UtcDateTime, Arg.Any<CancellationToken>());
        await fixture.Persistence.Received(1).RecordAttemptAsync(
            Arg.Is<SecurityChallengeAttemptRequest>(item => item.Reason == "pospace_reissue_loop_blocked"),
            Arg.Any<CancellationToken>());
        await fixture.RiskSink.Received(1).AddRiskAsync(
            Arg.Is<SecurityRiskSignal>(item => item.Detail == "pospace_reissue_loop_blocked"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task ReissueAsync_CurrentPolicyNoLongerRequiresPoSpace_PreservesServerDecision()
    {
        Fixture fixture = CreateFixture();
        RiskDecision current = CreateDecision("perceptionCharacterV3");

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            CreateRequest(),
            current,
            CreatePolicy(SecuritySystemModes.Enforce));

        Assert.True(result.Accepted);
        Assert.Equal(["perceptionCharacterV3"], result.Decision.RequiredChallenges);
        Assert.Contains("pospace_unsupported_current_policy", result.Decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pospace-reissue-single-replacement")]
    public async Task ReissueAsync_ConcurrentReplacement_FailsClosedWithoutSecondAudit()
    {
        Fixture fixture = CreateFixture(revokeSucceeds: false);

        PoSpaceUnsupportedReissueResult result = await fixture.Service.ReissueAsync(
            CreateRequest(),
            CreateDecision(Argon2idPoSpaceV1ChallengeProvider.WireKind),
            CreatePolicy(SecuritySystemModes.Enforce));

        Assert.False(result.Accepted);
        Assert.Equal("pospace_reissue_concurrent_rejected", result.Reason);
        await fixture.Persistence.DidNotReceiveWithAnyArgs().RecordAttemptAsync(default!, default);
        await fixture.Cache.Received(1).RemoveAsync(
            CachePolicyId.SecurityPoSpaceChallenge,
            ChallengeId,
            Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("unknown_reason", 1)]
    [InlineData("memory_tier_cap", 0)]
    [InlineData("memory_tier_cap", 3)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pospace-unsupported-metadata-closed")]
    public void Parser_RejectsUnboundedOrUnknownUnsupportedMetadata(string reason, int count)
    {
        string json = JsonSerializer.Serialize(new
        {
            unsupportedAssignment = new
            {
                challengeId = ChallengeId,
                kind = Argon2idPoSpaceV1ChallengeProvider.WireKind,
                action = "public.read",
                routeKey = "article:42",
                reason,
                reissueCount = count
            }
        });

        bool accepted = PoSpaceUnsupportedReissueParser.TryParse(
            json,
            "public.read",
            "article:42",
            new RiskControlProofBinding(HashA, HashB, HashC),
            new DefaultHttpContext(),
            out _,
            out bool malformed);

        Assert.False(accepted);
        Assert.True(malformed);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "pospace-unsupported-capability-data-minimized")]
    public void Parser_RejectsHighEntropyCapabilityFields()
    {
        string json = JsonSerializer.Serialize(new
        {
            unsupportedAssignment = new
            {
                challengeId = ChallengeId,
                kind = Argon2idPoSpaceV1ChallengeProvider.WireKind,
                action = "public.read",
                routeKey = "article:42",
                reason = "memory_tier_cap",
                reissueCount = 1,
                exactDeviceMemoryGb = 3.742
            }
        });

        bool accepted = PoSpaceUnsupportedReissueParser.TryParse(
            json,
            "public.read",
            "article:42",
            new RiskControlProofBinding(HashA, HashB, HashC),
            new DefaultHttpContext(),
            out _,
            out bool malformed);

        Assert.False(accepted);
        Assert.True(malformed);
    }

    private static Fixture CreateFixture(
        string? fallback = null,
        int priorUnsupportedAttempts = 0,
        bool revokeSucceeds = true)
    {
        IPoSpaceUnsupportedAssignmentStore store = Substitute.For<IPoSpaceUnsupportedAssignmentStore>();
        store.FindAsync(ChallengeId, Arg.Any<CancellationToken>()).Returns(CreateAssignment());
        store.CountUnsupportedAttemptsAsync(ChallengeId, Arg.Any<CancellationToken>()).Returns(priorUnsupportedAttempts);
        store.TryRevokeIssuedAsync(ChallengeId, Arg.Any<DateTime>(), Arg.Any<CancellationToken>()).Returns(revokeSucceeds);
        ISecurityChallengePersistenceService persistence = Substitute.For<ISecurityChallengePersistenceService>();
        persistence.RecordAttemptAsync(Arg.Any<SecurityChallengeAttemptRequest>(), Arg.Any<CancellationToken>())
            .Returns(call => new SecurityChallengeAttempt { ChallengeId = call.Arg<SecurityChallengeAttemptRequest>().ChallengeId });
        persistence.RevokeAsync(Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>()).Returns(true);
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ISecurityRiskSignalSink riskSink = Substitute.For<ISecurityRiskSignalSink>();
        var service = new PoSpaceUnsupportedReissueService(
            store,
            persistence,
            cache,
            riskSink,
            new FixedTimeProvider(s_now));
        return new Fixture(service, store, persistence, cache, riskSink);
    }

    private static PoSpaceUnsupportedReissueRequest CreateRequest(int reissueCount = 1)
        => new(
            new DefaultHttpContext(),
            ChallengeId,
            Argon2idPoSpaceV1ChallengeProvider.WireKind,
            "public.read",
            "article:42",
            "memory_tier_cap",
            reissueCount,
            new RiskControlProofBinding(HashA, HashB, HashC));

    private static SecurityChallenge CreateAssignment()
        => new()
        {
            ChallengeId = ChallengeId,
            Status = SecurityChallengeStatuses.Issued,
            Kind = Argon2idPoSpaceV1ChallengeProvider.WireKind,
            Action = "public.read",
            RouteKey = "article:42",
            SubjectHash = HashA,
            ClientIpHash = HashB,
            DeviceFpHash = HashC,
            ExpiresAtUtc = s_now.AddMinutes(5).UtcDateTime
        };

    private static RiskDecision CreateDecision(params string[] kinds)
        => new(
            RiskDecisionKind.Challenge,
            "public.read",
            "article:42",
            50,
            50,
            1,
            kinds,
            "risk-policy-v2",
            ["risk_threshold"]);

    private static SecurityRiskPolicy CreatePolicy(string characterChallengeMode)
    {
        var action = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            Argon2idPoSpaceV1ChallengeProvider.WireKind,
            1,
            null,
            false);
        return new SecurityRiskPolicy(
            "risk:test",
            "risk-policy-v2",
            s_now,
            SecuritySystemModes.Enforce,
            200,
            125,
            null,
            action,
            new Dictionary<string, SecurityRiskActionPolicy>(),
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.PerceptionMicroInteraction] = characterChallengeMode
            });
    }

    private sealed record Fixture(
        PoSpaceUnsupportedReissueService Service,
        IPoSpaceUnsupportedAssignmentStore Store,
        ISecurityChallengePersistenceService Persistence,
        ICacheInvalidationStore Cache,
        ISecurityRiskSignalSink RiskSink);

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
