using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Distribution;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminCacheDiagnosticsBoundaryTests
{
    [Fact]
    public void SearchIndexDiagnostics_MissingManifestPreservesMissingStatus()
    {
        string webRoot = Path.Combine(Path.GetTempPath(), $"fsusblog-cache-diagnostics-{Guid.NewGuid():N}");
        Directory.CreateDirectory(webRoot);
        try
        {
            var environment = Substitute.For<IWebHostEnvironment>();
            environment.WebRootPath.Returns(webRoot);
            var reader = new AdminCacheDiagnosticsReader(
                null!,
                environment,
                null!,
                null!,
                null!,
                null!,
                null!,
                null!,
                null!,
                Substitute.For<ILogger<AdminCacheDiagnosticsReader>>());

            SearchIndexDiagnosticsResponse response = reader.GetSearchIndexDiagnostics();

            Assert.Equal("missing", response.Status);
            Assert.False(response.ManifestExists);
            Assert.Equal("manifest_missing", response.LastError);
            Assert.Equal(Path.Combine(webRoot, "search", "index.manifest.aeds"), response.ManifestPath);
        }
        finally
        {
            Directory.Delete(webRoot, recursive: true);
        }
    }

    [Fact]
    public void DependencyGraph_MovesCacheDiagnosticPortsOutOfAdminOperationsWithoutCallback()
    {
        Type[] aggregateDependencies = Assert.Single(typeof(AdminOperationsService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IAdminCacheDiagnosticsReader), aggregateDependencies);
        Assert.DoesNotContain(typeof(PublicHotReadCounters), aggregateDependencies);
        Assert.DoesNotContain(typeof(PublicAotInvalidationTracker), aggregateDependencies);
        Assert.DoesNotContain(typeof(CacheInvalidationRuntimeState), aggregateDependencies);
        Assert.DoesNotContain(typeof(IHotStatsInvalidationCoalescer), aggregateDependencies);
        Assert.DoesNotContain(typeof(BlogDistributionService), aggregateDependencies);
        Assert.DoesNotContain(typeof(ICacheDiagnostics), aggregateDependencies);
        Assert.DoesNotContain(
            typeof(AdminOperationsService).GetMethods(),
            static method => method.Name == "GetCacheDiagnosticsAsync");

        ParameterInfo[] boundaryDependencies = Assert.Single(typeof(AdminCacheDiagnosticsReader).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(IWebHostEnvironment),
                typeof(PublicHotReadStore),
                typeof(PublicHotReadCounters),
                typeof(PublicAotInvalidationTracker),
                typeof(CacheInvalidationRuntimeState),
                typeof(IHotStatsInvalidationCoalescer),
                typeof(BlogDistributionService),
                typeof(ICacheDiagnostics),
                typeof(ILogger<AdminCacheDiagnosticsReader>)
            ],
            boundaryDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            boundaryDependencies,
            static parameter => parameter.ParameterType == typeof(AdminOperationsService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IAdminCacheDiagnosticsReader));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(AdminCacheDiagnosticsReader), descriptor.ImplementationType);
    }
}
