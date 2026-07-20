using FsusBlog.Server.Infrastructure.RuntimeModes;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeModeOptionsTests
{
    [Fact]
    public void FromConfiguration_DefaultsToSingleAndDisablesDistributedFeatures()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();

        RuntimeModePlan plan = RuntimeModePlan.FromConfiguration(configuration);

        Assert.Equal(FsusRuntimeModes.Single, plan.Mode);
        Assert.False(plan.ClusterMembershipEnabled);
        Assert.False(plan.AdaptiveSchedulerEnabled);
        Assert.False(plan.DistributedInvalidationEnabled);
        Assert.True(plan.LocalInvocationOnly);
    }

    [Fact]
    public void FromConfiguration_BindsStaticRolesAndRejectsUnknownRole()
    {
        IConfiguration valid = Configuration(
            ("RuntimeMode:Mode", "static-role"),
            ("RuntimeMode:StaticRoles:0", "web"),
            ("RuntimeMode:StaticRoles:1", "audit"));
        IConfiguration invalid = Configuration(
            ("RuntimeMode:Mode", "static-role"),
            ("RuntimeMode:StaticRoles:0", "fixed-search-service"));

        RuntimeModePlan plan = RuntimeModePlan.FromConfiguration(valid);

        Assert.Equal(FsusRuntimeModes.StaticRole, plan.Mode);
        Assert.Equal([FsusRuntimeRoles.Audit, FsusRuntimeRoles.Web], plan.StaticRoles.Order(StringComparer.Ordinal));
        Assert.True(plan.ClusterMembershipEnabled);
        Assert.False(plan.AdaptiveSchedulerEnabled);
        Assert.Throws<InvalidOperationException>(() => RuntimeModePlan.FromConfiguration(invalid));
    }

    [Fact]
    public void FromConfiguration_AdaptiveEnablesClusterFoundationGates()
    {
        RuntimeModePlan plan = RuntimeModePlan.FromConfiguration(Configuration(("RuntimeMode:Mode", "adaptive")));

        Assert.True(plan.ClusterMembershipEnabled);
        Assert.True(plan.AdaptiveSchedulerEnabled);
        Assert.True(plan.DistributedInvalidationEnabled);
        Assert.True(plan.LocalInvocationOnly);
    }

    [Fact]
    public void FromConfiguration_RejectsUnknownModeAndEmptyStaticRoleSet()
    {
        Assert.Throws<InvalidOperationException>(() => RuntimeModePlan.FromConfiguration(
            Configuration(("RuntimeMode:Mode", "split-services"))));
        Assert.Throws<InvalidOperationException>(() => RuntimeModePlan.FromConfiguration(
            Configuration(("RuntimeMode:Mode", "static-role"))));
    }

    private static IConfiguration Configuration(params (string Key, string Value)[] values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(static item => item.Key, static item => (string?)item.Value))
            .Build();
}
