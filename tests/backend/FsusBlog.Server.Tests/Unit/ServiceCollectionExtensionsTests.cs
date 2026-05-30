using System.Reflection;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class ServiceCollectionExtensionsTests
{
    [Fact]
    public void AddFsusRuntimeServices_RegistersBlacklistServiceAsScoped()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(CreateConfiguration());

        ServiceDescriptor? descriptor = services.LastOrDefault(static it => it.ServiceType == typeof(IBlacklistService));

        Assert.NotNull(descriptor);
        Assert.Equal(ServiceLifetime.Scoped, descriptor!.Lifetime);
    }

    [Fact]
    public void AddFsusRuntimeServices_HasNoSingletonImplementationDirectlyDependingOnSqlSugarClient()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(CreateConfiguration());

        Type[] offenders = services
            .Where(static descriptor => descriptor.Lifetime == ServiceLifetime.Singleton && descriptor.ImplementationType is not null)
            .Select(static descriptor => descriptor.ImplementationType!)
            .Where(HasDirectSqlSugarDependency)
            .Distinct()
            .ToArray();

        Assert.Empty(offenders);
    }

    [Fact]
    public void AddFsusRuntimeServices_RegistersAuditPipelineWithExpectedLifetimes()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(CreateConfiguration());

        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(AuditLogChannel)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(AuditSerilogEnricher)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(AuditSerilogSink)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IAuditLogStore)
            && descriptor.Lifetime == ServiceLifetime.Scoped);
    }

    private static bool HasDirectSqlSugarDependency(Type implementationType)
    {
        ConstructorInfo[] constructors = implementationType.GetConstructors(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
        for (int i = 0; i < constructors.Length; i++)
        {
            ParameterInfo[] parameters = constructors[i].GetParameters();
            for (int j = 0; j < parameters.Length; j++)
            {
                if (parameters[j].ParameterType == typeof(ISqlSugarClient))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection()
            .Build();
}
