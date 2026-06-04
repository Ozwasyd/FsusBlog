using System.Reflection;
using Microsoft.AspNetCore.DataProtection;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class ServiceCollectionExtensionsTests
{
    [Fact]
    public void AddFsusApiFoundation_PersistsDataProtectionKeysToConfiguredDirectory()
    {
        string keyRingPath = Path.Combine(Path.GetTempPath(), "fsusblog-data-protection-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var services = new ServiceCollection();
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ASPNETCORE_ENVIRONMENT"] = "Development",
                    ["ConnectionStrings:Redis"] = "localhost:6379",
                    ["Jwt:SecretKey"] = "unit-test-secret-key-with-at-least-32-chars",
                    ["Jwt:Issuer"] = "FsusBlog.Tests",
                    ["Jwt:Audience"] = "FsusBlog.Tests",
                    ["DataProtection:KeyRingPath"] = keyRingPath,
                    ["DataProtection:ApplicationName"] = "FsusBlog.Tests"
                })
                .Build();

            services.AddFsusApiFoundation(configuration);

            using ServiceProvider provider = services.BuildServiceProvider();
            var dataProtectionProvider = provider.GetRequiredService<IDataProtectionProvider>();
            IDataProtector protector = dataProtectionProvider.CreateProtector("unit-test");

            string protectedValue = protector.Protect("persistent-key-ring");

            Assert.Equal("persistent-key-ring", protector.Unprotect(protectedValue));
            Assert.NotEmpty(Directory.EnumerateFiles(keyRingPath, "*.xml"));
        }
        finally
        {
            if (Directory.Exists(keyRingPath))
            {
                Directory.Delete(keyRingPath, recursive: true);
            }
        }
    }

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

    [Fact]
    public void AddFsusRuntimeServices_StartsLifecycleBootstrapBeforeSchemaDependentWorkers()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(CreateConfiguration());

        int lifecycleIndex = HostedServiceIndex<LifecycleHostedBootstrapService>(services);
        int auditWorkerIndex = HostedServiceIndex<AuditLogWriterWorker>(services);
        int cleanupWorkerIndex = HostedServiceIndex<LogCleanupService>(services);

        Assert.True(lifecycleIndex >= 0, "Lifecycle bootstrap hosted service is not registered.");
        Assert.True(lifecycleIndex < auditWorkerIndex);
        Assert.True(lifecycleIndex < cleanupWorkerIndex);
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

    private static int HostedServiceIndex<TImplementation>(IList<ServiceDescriptor> services)
        where TImplementation : IHostedService
    {
        for (int i = 0; i < services.Count; i++)
        {
            ServiceDescriptor descriptor = services[i];
            if (descriptor.ServiceType == typeof(IHostedService)
                && descriptor.ImplementationType == typeof(TImplementation))
            {
                return i;
            }
        }

        return -1;
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection()
            .Build();
}
