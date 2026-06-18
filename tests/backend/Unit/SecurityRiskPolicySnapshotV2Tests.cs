using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskPolicySnapshotV2Tests
{
    [Fact]
    public void LegacyAdapter_PreservesDefaultPublicReadChallengeAndBlockBehavior()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.PublicRead, 49).Outcome);
        SecurityRiskPolicyDecision challenge = snapshot.Evaluate(RiskActionNames.PublicRead, 50);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, challenge.Outcome);
        Assert.True(challenge.Enforced);
        Assert.Equal("security.pow", challenge.ChallengeKind);
        Assert.Equal(["security.pow"], challenge.RequiredChallengeKinds);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.PublicRead, 99).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.PublicRead, 100).Outcome);

        SecurityRiskPolicySnapshot legacy = SecurityRiskPolicySnapshotV2Adapter.ToLegacy(snapshot);
        Assert.Equal(50, legacy.RequireChallengeScore);
        Assert.Equal(100, legacy.BlockScore);
        Assert.True(legacy.PublicReadChallengeEnabled);
    }

    [Fact]
    public void DisabledMode_AllowsWithoutEnforcement()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Disabled);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 200);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, decision.Outcome);
        Assert.False(decision.Enforced);
        Assert.Equal("mode_disabled", decision.Reason);
    }

    [Fact]
    public void ObserveMode_RecordsOnlyWithoutChallengeOrBlock()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Observe);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 150);

        Assert.Equal(SecurityRiskPolicyOutcomes.Observe, decision.Outcome);
        Assert.False(decision.Enforced);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, decision.Reason);
        Assert.Equal(string.Empty, decision.ChallengeKind);
        Assert.Empty(decision.RequiredChallengeKinds);
    }

    [Fact]
    public void EnforceMode_UsesActionThresholdsForChallengeQueueAndBlock()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Enforce);

        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.PublicRead, 50).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, snapshot.Evaluate(RiskActionNames.PublicRead, 70).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Queue, snapshot.Evaluate(RiskActionNames.PublicRead, 85).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.PublicRead, 100).Outcome);
    }

    [Fact]
    public void StrictMode_AppliesRiskWeightBeforeThresholds()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Strict);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 40);

        Assert.Equal(50, decision.EffectiveRiskScore);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, decision.Outcome);
        Assert.True(decision.Enforced);
    }

    [Fact]
    public void LockdownMode_BlocksAnonymousWritesBeforeScoreThresholds()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Lockdown);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.CommentCreate, 0, isAnonymousWrite: true);

        Assert.Equal(SecurityRiskPolicyOutcomes.LockdownBlock, decision.Outcome);
        Assert.True(decision.Enforced);
        Assert.Equal("anonymous_write_lockdown", decision.Reason);
    }

    [Fact]
    public void ActionOverride_ReplacesDefaultThresholds()
    {
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = CreateActionPolicy(RiskActionNames.AuthLogin, 10, 20, 40, 60)
        };
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Enforce, overrides);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.PublicRead, 10).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.AuthLogin, 10).Outcome);
        Assert.Equal(RiskActionNames.AuthLogin, snapshot.ResolveActionPolicy(RiskActionNames.AuthLogin).ActionName);
    }

    [Fact]
    public void LegacyAdapter_MapsAuthAndCommentMediumRiskToCaptchaAndHighRiskToCombo()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.AuthLogin, 49).Outcome);

        SecurityRiskPolicyDecision mediumLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 50);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, mediumLogin.Outcome);
        Assert.Equal("captchaV1", mediumLogin.ChallengeKind);
        Assert.Equal(["captchaV1"], mediumLogin.RequiredChallengeKinds);
        Assert.Equal(1, mediumLogin.EscalationLevel);

        SecurityRiskPolicyDecision highLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 75);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, highLogin.Outcome);
        Assert.Equal("captchaV1", highLogin.ChallengeKind);
        Assert.Equal(["captchaV1", "sha256PowV1"], highLogin.RequiredChallengeKinds);
        Assert.Equal(2, highLogin.EscalationLevel);

        SecurityRiskPolicyDecision mediumComment = snapshot.Evaluate(RiskActionNames.CommentCreate, 50);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, mediumComment.Outcome);
        Assert.Equal(["captchaV1"], mediumComment.RequiredChallengeKinds);

        SecurityRiskPolicyDecision highReply = snapshot.Evaluate(RiskActionNames.CommentReply, 99);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, highReply.Outcome);
        Assert.Equal(["captchaV1", "sha256PowV1"], highReply.RequiredChallengeKinds);

        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.AuthLogin, 100).Outcome);
    }

    [Fact]
    public void LegacyAdapter_DisabledPublicReadChallengeDisablesOnlyPublicReadOverride()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(
            CreateLegacySnapshot(publicReadChallengeEnabled: false));

        SecurityRiskPolicyDecision publicRead = snapshot.Evaluate(RiskActionNames.PublicRead, 100);
        SecurityRiskPolicyDecision authLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 100);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, publicRead.Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, authLogin.Outcome);
        Assert.False(SecurityRiskPolicySnapshotV2Adapter.ToLegacy(snapshot).PublicReadChallengeEnabled);
    }

    private static SecurityRiskPolicySnapshotV2 CreateSnapshot(
        string mode,
        IReadOnlyDictionary<string, SecurityRiskActionPolicy>? overrides = null)
    {
        SecurityRiskActionPolicy defaultAction = CreateActionPolicy("*", 50, 70, 85, 100);
        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.PublicRead] = defaultAction with
            {
                ActionName = RiskActionNames.PublicRead,
                AnonymousWriteAllowed = true
            },
            [RiskActionNames.CommentCreate] = defaultAction with { ActionName = RiskActionNames.CommentCreate }
        };

        if (overrides is not null)
        {
            foreach (KeyValuePair<string, SecurityRiskActionPolicy> item in overrides)
            {
                actionOverrides[item.Key] = item.Value;
            }
        }

        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            mode,
            200,
            125,
            "risk:lkg",
            defaultAction,
            actionOverrides,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.AntiCrawler] = mode,
                [SecurityRiskSources.Pow] = SecuritySystemModes.Enforce
            });
    }

    private static SecurityRiskActionPolicy CreateActionPolicy(
        string actionName,
        int challengeScore,
        int hardChallengeScore,
        int queueScore,
        int blockScore)
        => new(
            actionName,
            new SecurityRiskActionThresholds(Math.Max(0, challengeScore - 1), challengeScore, hardChallengeScore, queueScore, blockScore),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: false);

    private static AntiCrawlerPolicySnapshot CreateLegacySnapshot(
        string mode = SecuritySystemModes.Enforce,
        bool publicReadChallengeEnabled = true)
        => new(
            "anti:test",
            DateTimeOffset.UnixEpoch,
            "test",
            "unit",
            new AntiCrawlerPolicyOptions(
                mode,
                publicReadChallengeEnabled,
                SearchCrawlerVerificationEnabled: true,
                SocialPreviewGuardEnabled: true,
                RiskScoringEnabled: true,
                EventPersistenceEnabled: true,
                DashboardAggregationEnabled: true,
                CidrAutoUpdateEnabled: true,
                IllegalPathHardAbortEnabled: true,
                RequireChallengeScore: 50,
                BlockScore: 100,
                MaxRiskScore: 200,
                DefaultRiskTtlSeconds: 600,
                ZeroRiskCacheTtlSeconds: 3,
                FixedIpPermitLimit: 100,
                FixedIpQueueLimit: 2,
                VerifiedCrawlerFixedIpPermitLimit: 1000,
                PublicReadPermitLimit: 120,
                PublicReadQueueLimit: 2,
                VerifiedCrawlerPublicReadPermitLimit: 1000,
                SocialPreviewPublicReadPermitLimit: 30,
                ReadProofPermitLimit: 30,
                CidrUpdateIntervalMinutes: 1440,
                CidrInitialDelaySeconds: 0,
                CidrMinUpdateIntervalMinutes: 30,
                GoogleCrawlerRangesUrl: "https://example.invalid/googlebot.json",
                BingCrawlerRangesUrl: "https://example.invalid/bingbot.json",
                SnapshotPath: null,
                SocialPreviewAllowedPathPrefixes: ["/"],
                BlockedUserAgentKeywords: [],
                SecurityChallengeReference: "security.pow"));
}
