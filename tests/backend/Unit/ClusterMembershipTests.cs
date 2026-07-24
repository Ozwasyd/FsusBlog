using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ClusterMembershipTests
{
    [Fact]
    public void CapabilityCatalog_RejectsUnknownBusinessStrings()
    {
        Assert.True(CapabilityId.TryParse("web.api", out CapabilityId capability));
        Assert.Equal(ClusterCapabilities.WebApi, capability);
        Assert.False(CapabilityId.TryParse("business.random", out _));
    }

    [Fact]
    public void IdentityFactory_KeepsConfiguredNodeIdButRotatesInstanceId()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Runtime:Mode"] = "adaptive",
                ["Runtime:Cluster:NodeId"] = "fsusblog-node-001",
                ["Runtime:Cluster:Capabilities:0"] = "web.api"
            })
            .Build();

        ClusterMembershipOptions first = ClusterMembershipOptions.FromConfiguration(configuration);
        ClusterMembershipOptions second = ClusterMembershipOptions.FromConfiguration(configuration);

        Assert.Equal("fsusblog-node-001", first.NodeId.Value);
        Assert.Equal(first.NodeId, second.NodeId);
        Assert.NotEqual(first.InstanceId, second.InstanceId);
        Assert.Equal(ClusterRuntimeMode.Adaptive, first.Mode);
    }

    [Fact]
    public void SingleMode_DisablesRegistration()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Runtime:Mode"] = "single"
            })
            .Build();

        ClusterMembershipOptions options = ClusterMembershipOptions.FromConfiguration(configuration);

        Assert.False(options.Enabled);
        Assert.Empty(options.Capabilities);
    }

    [Fact]
    public void Registration_SingleSkipsHostedServiceWhileAdaptiveUsesRedisStore()
    {
        var singleServices = new ServiceCollection();
        singleServices.AddFsusClusterMembership(Configuration(("RuntimeMode:Mode", "single")));
        Assert.Contains(singleServices, descriptor =>
            descriptor.ServiceType == typeof(IClusterMembershipStore)
            && descriptor.ImplementationType == typeof(InMemoryClusterMembershipStore));
        Assert.DoesNotContain(singleServices, descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationType == typeof(ClusterMembershipHostedService));

        var adaptiveServices = new ServiceCollection();
        adaptiveServices.AddFsusClusterMembership(Configuration(
            ("RuntimeMode:Mode", "adaptive"),
            ("Runtime:Cluster:Capabilities:0", "web.api")));
        Assert.Contains(adaptiveServices, descriptor =>
            descriptor.ServiceType == typeof(IClusterMembershipStore)
            && descriptor.ImplementationType == typeof(RedisClusterMembershipStore));
        Assert.Contains(adaptiveServices, descriptor =>
            descriptor.ServiceType == typeof(IHostedService)
            && descriptor.ImplementationType == typeof(ClusterMembershipHostedService));
    }

    [Fact]
    public void Descriptor_RoundTripsThroughSharedStorePayload()
    {
        NodeDescriptor expected = NodeDescriptor.Create(
            new NodeId("node-a"),
            Guid.NewGuid(),
            "1.3.0",
            DateTimeOffset.Parse("2026-07-24T01:00:00Z"),
            ClusterRuntimeMode.Adaptive,
            [ClusterCapabilities.WebApi, ClusterCapabilities.SearchQuery]);

        string payload = JsonSerializer.Serialize(expected, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        NodeDescriptor actual = Assert.IsType<NodeDescriptor>(
            JsonSerializer.Deserialize<NodeDescriptor>(
                payload,
                new JsonSerializerOptions(JsonSerializerDefaults.Web)));

        Assert.Equal(expected.NodeId, actual.NodeId);
        Assert.Equal(expected.InstanceId, actual.InstanceId);
        Assert.Equal(expected.Capabilities, actual.Capabilities);
        Assert.Equal("adaptive", ClusterMembershipWireNames.Mode(actual.Mode));
        Assert.Equal("alive", ClusterMembershipWireNames.Status(actual.Status));
    }

    [Fact]
    public async Task FailureDetector_TransitionsAliveToSuspectThenDead()
    {
        DateTimeOffset now = new(2026, 7, 24, 1, 0, 0, TimeSpan.Zero);
        var store = new InMemoryClusterMembershipStore();
        NodeDescriptor descriptor = NodeDescriptor.Create(
            new NodeId("node-a"),
            Guid.NewGuid(),
            "1.3.0",
            now,
            ClusterRuntimeMode.Adaptive,
            [ClusterCapabilities.WebApi]);
        await store.UpsertNodeAsync(descriptor, CancellationToken.None);
        await store.MarkHeartbeatAsync(
            NodeHeartbeat.Healthy(descriptor.NodeId, descriptor.InstanceId, now),
            CancellationToken.None);

        await store.DetectFailuresAsync(
            now.AddSeconds(11),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);
        Assert.Equal(
            ClusterMemberStatus.Suspect,
            Assert.Single(await store.ListNodesAsync(CancellationToken.None)).Status);

        await store.DetectFailuresAsync(
            now.AddSeconds(31),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);
        Assert.Equal(
            ClusterMemberStatus.Dead,
            Assert.Single(await store.ListNodesAsync(CancellationToken.None)).Status);
    }

    [Theory]
    [InlineData(ClusterMemberStatus.Draining)]
    [InlineData(ClusterMemberStatus.Maintenance)]
    public async Task FailureDetector_DoesNotOverwriteOperatorStates(ClusterMemberStatus state)
    {
        DateTimeOffset now = new(2026, 7, 24, 1, 0, 0, TimeSpan.Zero);
        var store = new InMemoryClusterMembershipStore();
        NodeDescriptor descriptor = NodeDescriptor.Create(
            new NodeId("node-a"),
            Guid.NewGuid(),
            "1.3.0",
            now,
            ClusterRuntimeMode.StaticRole,
            [ClusterCapabilities.WebApi]) with
        {
            Status = state
        };
        await store.UpsertNodeAsync(descriptor, CancellationToken.None);

        await store.DetectFailuresAsync(
            now.AddHours(1),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);

        Assert.Equal(
            state,
            Assert.Single(await store.ListNodesAsync(CancellationToken.None)).Status);
    }

    [Fact]
    public async Task OldInstanceCannotMarkReplacementDraining()
    {
        DateTimeOffset now = new(2026, 7, 24, 1, 0, 0, TimeSpan.Zero);
        var store = new InMemoryClusterMembershipStore();
        Guid replacementInstance = Guid.NewGuid();
        NodeDescriptor replacement = NodeDescriptor.Create(
            new NodeId("node-a"),
            replacementInstance,
            "1.3.0",
            now,
            ClusterRuntimeMode.Adaptive,
            [ClusterCapabilities.WebApi]);
        await store.UpsertNodeAsync(replacement, CancellationToken.None);

        await store.SetNodeStatusAsync(
            replacement.NodeId,
            Guid.NewGuid(),
            ClusterMemberStatus.Draining,
            CancellationToken.None);

        Assert.Equal(
            ClusterMemberStatus.Alive,
            Assert.Single(await store.ListNodesAsync(CancellationToken.None)).Status);
    }

    [Fact]
    public void DiagnosticEndpoint_RequiresIndependentAdminPermissionAndFixedIp()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        WebApplication application = builder.Build();
        application.MapClusterMembershipEndpoints();

        RouteEndpoint endpoint = Assert.Single(((IEndpointRouteBuilder)application).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>());
        Assert.Equal("/api/ops/cluster/nodes", endpoint.RoutePattern.RawText);
        AuthorizationPolicy policy = Assert.IsType<AuthorizationPolicy>(
            endpoint.Metadata.GetMetadata<AuthorizationPolicy>());
        ClaimsAuthorizationRequirement[] claims = policy.Requirements
            .OfType<ClaimsAuthorizationRequirement>()
            .ToArray();
        Assert.Contains(claims, requirement =>
            requirement.ClaimType == "identity_kind"
            && requirement.AllowedValues!.Contains("admin_principal"));
        Assert.Contains(claims, requirement =>
            requirement.ClaimType == AdminPermissions.PermissionClaimType
            && requirement.AllowedValues!.Contains(AdminPermissions.SystemConfig));
        Assert.Equal(
            "fixed_ip",
            endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()?.PolicyName);
        Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());
    }

    [Fact]
    public async Task DiagnosticEndpoint_RejectsAnonymousAndNormalAccountsButAllowsExactAdmin()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        WebApplication application = builder.Build();
        application.MapClusterMembershipEndpoints();
        RouteEndpoint endpoint = Assert.Single(((IEndpointRouteBuilder)application).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>());
        AuthorizationPolicy policy = Assert.IsType<AuthorizationPolicy>(
            endpoint.Metadata.GetMetadata<AuthorizationPolicy>());

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddAuthorizationCore();
        await using ServiceProvider provider = services.BuildServiceProvider();
        IAuthorizationService authorization = provider.GetRequiredService<IAuthorizationService>();

        Assert.False((await authorization.AuthorizeAsync(
            new ClaimsPrincipal(new ClaimsIdentity()),
            null,
            policy)).Succeeded);
        Assert.False((await authorization.AuthorizeAsync(
            Principal(("sub", "account-1"), ("identity_kind", "account")),
            null,
            policy)).Succeeded);
        Assert.False((await authorization.AuthorizeAsync(
            Principal(("identity_kind", "admin_principal"), ("admin_id", "7")),
            null,
            policy)).Succeeded);
        Assert.True((await authorization.AuthorizeAsync(
            Principal(
                ("identity_kind", "admin_principal"),
                ("admin_id", "7"),
                (AdminPermissions.PermissionClaimType, AdminPermissions.SystemConfig)),
            null,
            policy)).Succeeded);
    }

    private static ClaimsPrincipal Principal(params (string Type, string Value)[] claims)
        => new(new ClaimsIdentity(
            claims.Select(static claim => new Claim(claim.Type, claim.Value)),
            authenticationType: "test"));

    private static IConfiguration Configuration(params (string Key, string Value)[] values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(
                static item => item.Key,
                static item => (string?)item.Value))
            .Build();
}
