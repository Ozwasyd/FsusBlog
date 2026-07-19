using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Tests.Unit;

public sealed class SecurityChallengeCapabilityCatalogTests
{
    [Fact]
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

        SecurityChallengeCapabilityResolution captcha = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.CaptchaV1,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui);
        Assert.True(captcha.Capability.KindKnown);
        Assert.True(captcha.ProviderAvailable);
        Assert.True(captcha.ExecutorAvailable);
        Assert.True(captcha.HostAvailable);
        Assert.True(captcha.PolicyEligible);

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
    public void Resolve_AllowsShaPowAcrossUiAndHeadlessButRejectsOldManifest()
    {
        SecurityChallengeCapabilityResolution ui = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Sha256PowV1,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Ui);
        Assert.True(ui.PolicyEligible);

        SecurityChallengeCapabilityResolution incompatible = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.CaptchaV1,
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
    public void PolicyService_AllowsPoSpaceAfterExecutorAndHostsAreRegistered()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var request = new RiskControlPolicyUpdateRequest(
            null,
            CaptchaV1Enabled: null,
            PoSpaceV1Enabled: true,
            PublicReadChallengeEnabled: null,
            CommentRiskControlEnabled: null,
            AuthRiskControlEnabled: null,
            StrictRiskMultiplierPercent: null,
            Reason: "test");

        SecurityRiskPolicySnapshotV2 updated = service.UpdateRiskControlPolicy(request, "test");
        Assert.Equal(SecuritySystemModes.Enforce, updated.SubsystemModes[SecurityRiskSources.PoSpace]);
    }

    [Fact]
    public void PolicyService_AcceptsOrderedTwoMemberAndSingleMemberSnapshots()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        string captcha = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.CaptchaV1);
        string poSpace = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1);

        service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([captcha, poSpace]));

        Assert.Equal([captcha, poSpace], service.CurrentRiskPolicyV2.DefaultAction.HardChallengeKinds);

        service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([captcha]));

        Assert.Equal([captcha], service.CurrentRiskPolicyV2.DefaultAction.HardChallengeKinds);
    }

    [Fact]
    public void PolicyService_RejectsSnapshotWhenAnyOrderedMemberIsUnavailable()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        string captcha = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.CaptchaV1);
        string unavailable = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1);

        ArgumentException error = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([captcha, unavailable])));

        Assert.Contains("challenge_capability_unavailable", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PolicyService_RejectsDuplicateOverLimitAndNoncanonicalSets()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        string captcha = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.CaptchaV1);

        ArgumentException duplicate = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy([captcha, captcha])));
        ArgumentException overLimit = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy(
                Enumerable.Repeat(captcha, SecurityChallengeContracts.MaxAssignmentsPerEnvelope + 1).ToArray())));
        ArgumentException noncanonical = Assert.Throws<ArgumentException>(() =>
            service.ApplyRiskControlPolicySnapshot(CreateRiskPolicy(["security.pow"], SecurityChallengeCapabilityCatalog.NotificationSubscribeAction)));

        Assert.Contains("challenge_set_duplicate", duplicate.Message, StringComparison.Ordinal);
        Assert.Contains("challenge_set_count_invalid", overLimit.Message, StringComparison.Ordinal);
        Assert.Contains("challenge_kind_noncanonical", noncanonical.Message, StringComparison.Ordinal);
    }

    private static SecurityRiskPolicySnapshotV2 CreateRiskPolicy(
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
