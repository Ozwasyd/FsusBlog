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
    public void Resolve_RejectsMissingHostAndVersionButAllowsNotificationPow()
    {
        SecurityChallengeCapabilityResolution missingHost = SecurityChallengeCapabilityCatalog.Resolve(
            SecurityChallengeKind.Sha256PowV1,
            RiskActionNames.CommentCreate,
            SecurityChallengeExecutionMode.Headless);
        Assert.Equal("host_unavailable", missingHost.UnavailableReason);

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
}
