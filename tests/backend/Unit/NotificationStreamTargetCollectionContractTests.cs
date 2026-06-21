using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamTargetCollectionContractTests
{
    [Fact]
    public void NotificationStreamTargets_DoNotExposeLegacyGroupConstants()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/NotificationStream/NotificationStreamTargets.cs");

        Assert.DoesNotContain("NotificationStreamGroups", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthenticatedUsers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthenticatedUsersGroup", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ContentGovernanceGroup", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminUsersGroup", source, StringComparison.Ordinal);
    }

    [Fact]
    public void AudienceResolver_OnlyAssignsExplicitNotificationTargets()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/NotificationStream/NotificationStreamAudienceResolver.cs");

        Assert.Contains("NotificationStreamTargetCollections.ContentFeed", source, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamTargetCollections.AdminUsers", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthenticatedUsers", source, StringComparison.Ordinal);
    }

    [Fact]
    public void DrillEndpoint_DoesNotParseLegacyNotificationGroups()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Modules/Endpoints/NotificationStreamDrillEndpoints.cs");

        Assert.DoesNotContain("NotificationStreamGroups", source, StringComparison.Ordinal);
        Assert.DoesNotContain("authenticated-users", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthenticatedUsersGroup", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ContentGovernanceGroup", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AdminUsersGroup", source, StringComparison.Ordinal);
    }
}
