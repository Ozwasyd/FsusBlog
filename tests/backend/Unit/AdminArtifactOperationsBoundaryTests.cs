using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminArtifactOperationsBoundaryTests
{
    [Fact]
    public async Task SearchRebuild_NormalizesActionAndUsesOnlySearchPort()
    {
        var search = Substitute.For<ISearchIndexService>();
        var operations = new AdminArtifactOperations(search, null!, null!, null!, null!);

        AdminCacheActionResponse response = await operations.RunCacheActionAsync(
            new AdminCacheActionRequest(" SEARCH-REBUILD "),
            CancellationToken.None);

        Assert.Equal("search-rebuild", response.Action);
        Assert.Equal("ok", response.Status);
        await search.Received(1).BuildIndexAsync(
            Arg.Is<List<FsusBlog.Server.Entities.Article>>(static articles => articles.Count == 0));
    }

    [Fact]
    public void DependencyGraph_MovesArtifactPortsOutOfAdminOperationsWithoutCallback()
    {
        Type[] aggregateDependencies = Assert.Single(typeof(AdminIntegrityOperations).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.DoesNotContain(typeof(ISearchIndexService), aggregateDependencies);
        Assert.DoesNotContain(typeof(PublicHotArtifactUpdateQueue), aggregateDependencies);
        Assert.DoesNotContain(typeof(IPublicAotInvalidationService), aggregateDependencies);
        Assert.DoesNotContain(typeof(IArticleDetailAedsArtifactMaintenanceService), aggregateDependencies);
        Assert.DoesNotContain(typeof(ICacheInvalidationDispatcher), aggregateDependencies);
        Assert.DoesNotContain(
            typeof(AdminIntegrityOperations).GetMethods(),
            static method => method.Name == nameof(IAdminArtifactOperations.RunCacheActionAsync));

        ParameterInfo[] boundaryDependencies = Assert.Single(typeof(AdminArtifactOperations).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Equal(
            [
                typeof(ISearchIndexService),
                typeof(PublicHotArtifactUpdateQueue),
                typeof(IPublicAotInvalidationService),
                typeof(IArticleDetailAedsArtifactMaintenanceService),
                typeof(ICacheInvalidationDispatcher)
            ],
            boundaryDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            boundaryDependencies,
            static parameter => parameter.ParameterType == typeof(AdminIntegrityOperations));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IAdminArtifactOperations));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(AdminArtifactOperations), descriptor.ImplementationType);
    }
}
