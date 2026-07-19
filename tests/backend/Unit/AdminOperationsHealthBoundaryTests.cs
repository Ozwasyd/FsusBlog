using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminOperationsHealthBoundaryTests
{
    [Fact]
    public void DependencyGraph_SeparatesHealthCompositionFromIntegrityOperationsWithoutCallback()
    {
        Type[] integrityDependencies = Assert.Single(typeof(AdminOperationsService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Equal([typeof(ISqlSugarClient), typeof(IWebHostEnvironment)], integrityDependencies);
        Assert.DoesNotContain(
            typeof(AdminOperationsService).GetMethods(),
            static method => method.Name == "GetOpsHealthAsync");

        ParameterInfo[] healthDependencies = Assert.Single(typeof(AdminOperationsHealthReader).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Contains(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(IAdminBackupStatusReader));
        Assert.Contains(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(IAdminCacheDiagnosticsReader));
        Assert.DoesNotContain(
            healthDependencies,
            static parameter => parameter.ParameterType == typeof(AdminOperationsService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IAdminOperationsHealthReader));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(AdminOperationsHealthReader), descriptor.ImplementationType);
    }
}
