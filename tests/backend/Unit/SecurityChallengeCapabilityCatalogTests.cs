using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Tests.Unit;

public sealed class SecurityChallengeCapabilityCatalogTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Catalog_CoversEveryEnumAndKeepsFiveStatesIndependent()
    {
        SecurityChallengeKind[] kinds = Enum.GetValues<SecurityChallengeKind>();

        Assert.Equal(kinds.Length, SecurityChallengeCapabilityCatalog.All.Count);
        foreach (SecurityChallengeKind kind in kinds)
        {
            SecurityChallengeCapability item = SecurityChallengeCapabilityCatalog.Get(kind);
            Assert.Equal(kind, item.Kind);
            Assert.Equal(SecurityChallengeContracts.ToWireName(kind), item.WireName);
        }

        SecurityChallengeCapabilityResolution characterChallenge = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.PerceptionCharacterV3,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui);
        Assert.True(characterChallenge.Capability.KindKnown);
        Assert.True(characterChallenge.ProviderAvailable);
        Assert.True(characterChallenge.ExecutorAvailable);
        Assert.True(characterChallenge.HostAvailable);
        Assert.True(characterChallenge.PolicyEligible);

        SecurityChallengeCapabilityResolution poSpace = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Argon2IdPoSpaceV1,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui);
        Assert.True(poSpace.Capability.KindKnown);
        Assert.True(poSpace.ProviderAvailable);
        Assert.True(poSpace.ExecutorAvailable);
        Assert.True(poSpace.HostAvailable);
        Assert.True(poSpace.PolicyEligible);
        Assert.Null(poSpace.UnavailableReason);

        SecurityChallengeCapabilityResolution headlessPoSpace = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Argon2IdPoSpaceV1,
            SecurityChallengeCapabilityCatalog.NotificationSubscribeAction,
            SecurityChallengeExecutionMode.Headless);
        Assert.True(headlessPoSpace.PolicyEligible);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-old-manifest-reject")]
    public void Resolve_AllowsShaPowAcrossUiAndHeadlessButRejectsOldManifest()
    {
        SecurityChallengeCapabilityResolution ui = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Sha256PowV1,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui);
        Assert.True(ui.PolicyEligible);

        SecurityChallengeCapabilityResolution incompatible = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.PerceptionCharacterV3,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui,
            "older-build");
        Assert.Equal("version_incompatible", incompatible.UnavailableReason);

        SecurityChallengeCapabilityResolution notification = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Sha256PowV1,
            SecurityChallengeCapabilityCatalog.NotificationSubscribeAction,
            SecurityChallengeExecutionMode.Headless);
        Assert.True(notification.PolicyEligible);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void PolicyService_AllowsPoSpaceAfterExecutorAndHostsAreRegistered()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));
        var request = new RiskControlPolicyUpdateRequest(
            null,
            PoSpaceV1Enabled: true,
            PublicReadChallengeEnabled: null,
            CommentRiskControlEnabled: null,
            AuthRiskControlEnabled: null,
            StrictRiskMultiplierPercent: null,
            Reason: "test");

        SecurityRiskPolicy updated = service.UpdateRiskControlPolicy(request, "test");
        Assert.Equal(SecuritySystemModes.Enforce, updated.SubsystemModes[SecurityRiskSources.PoSpace]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void PolicyService_AcceptsOrderedTwoMemberAndSingleMemberSnapshots()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateCharacterProviderEnabledConfiguration()));
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);
        string poSpace = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1);

        service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([characterChallenge, poSpace]));

        Assert.Equal([characterChallenge, poSpace], service.CurrentRiskPolicy.DefaultAction.HardChallengeKinds);

        service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([characterChallenge]));

        Assert.Equal([characterChallenge], service.CurrentRiskPolicy.DefaultAction.HardChallengeKinds);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-ordered-member-unavailable-reject")]
    public void PolicyService_RejectsSnapshotWhenAnyOrderedMemberIsUnavailable()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateCharacterProviderEnabledConfiguration()));
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);
        string unavailable = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1);

        ArgumentException error = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([characterChallenge, unavailable])));

        Assert.Contains("challenge_capability_unavailable", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-duplicate-overlimit-noncanonical-reject")]
    public void PolicyService_RejectsDuplicateOverLimitAndNoncanonicalSets()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateCharacterProviderEnabledConfiguration()));
        string characterChallenge = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);

        ArgumentException duplicate = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([characterChallenge, characterChallenge])));
        ArgumentException overLimit = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy(
                Enumerable.Repeat(characterChallenge, SecurityChallengeContracts.MaxAssignmentsPerEnvelope + 1).ToArray())));
        ArgumentException noncanonical = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy(["security.pow"], SecurityChallengeCapabilityCatalog.NotificationSubscribeAction)));

        Assert.Contains("challenge_set_duplicate", duplicate.Message, StringComparison.Ordinal);
        Assert.Contains("challenge_set_count_invalid", overLimit.Message, StringComparison.Ordinal);
        Assert.Contains("challenge_kind_noncanonical", noncanonical.Message, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-character-provider-disabled-reject")]
    public void PolicyService_RejectsCharacterSnapshotWhenRuntimeProviderIsDisabled()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));
        string characterChallenge = SecurityChallengeContracts.ToWireName(
            SecurityChallengeKind.PerceptionCharacterV3);

        ArgumentException error = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([characterChallenge])));

        Assert.Contains("challenge_provider_disabled", error.Message, StringComparison.Ordinal);
    }

    private static IConfiguration CreateCharacterProviderEnabledConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PerceptionCharacterV3:Enabled"] = SecuritySystemModes.Enforce
            })
            .Build();

    private static SecurityRiskPolicy CreateRiskPolicy(
        IReadOnlyList<string> challengeKinds,
        string actionName = RiskActionNames.CommentCreate)
        => new(
            "risk-policy-snapshot-test",
            "risk-policy-v2-test",
            DateTimeOffset.UtcNow,
            SecuritySystemModes.Enforce,
            100,
            125,
            "risk-policy-snapshot-test",
            new SecurityRiskActionPolicy(
                actionName,
                new SecurityRiskActionThresholds(10, 25, 50, 75, 90),
                challengeKinds[0],
                1,
                null,
                AnonymousWriteAllowed: true)
            {
                HardChallengeKinds = challengeKinds
            },
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));
}
