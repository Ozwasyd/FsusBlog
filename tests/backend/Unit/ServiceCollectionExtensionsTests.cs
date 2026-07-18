using System.IO.Compression;
using System.Reflection;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class ServiceCollectionExtensionsTests
{
    [Fact]
    public void AddFsusApiFoundation_ConfiguresEndpointAwarePublicResponseCompression()
    {
        var services = new ServiceCollection();
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = Environments.Development,
                ["ConnectionStrings:Redis"] = "localhost:6379,connectTimeout=50",
                ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
                ["Jwt:Issuer"] = "FsusBlog.Tests",
                ["Jwt:Audience"] = "FsusBlog.Tests"
            })
            .Build();

        services.AddFsusApiFoundation(configuration);
        using ServiceProvider provider = services.BuildServiceProvider();

        ResponseCompressionOptions responseOptions = provider
            .GetRequiredService<IOptions<ResponseCompressionOptions>>()
            .Value;
        BrotliCompressionProviderOptions brotliOptions = provider
            .GetRequiredService<IOptions<BrotliCompressionProviderOptions>>()
            .Value;
        GzipCompressionProviderOptions gzipOptions = provider
            .GetRequiredService<IOptions<GzipCompressionProviderOptions>>()
            .Value;
        PublicResponseCompressionPolicyOptions policyOptions = provider
            .GetRequiredService<IOptions<PublicResponseCompressionPolicyOptions>>()
            .Value;

        Assert.True(responseOptions.EnableForHttps);
        Assert.True(policyOptions.Enabled);
        Assert.IsType<EndpointAwareResponseCompressionProvider>(
            provider.GetRequiredService<IResponseCompressionProvider>());
        Type[] compressionProviderTypes = responseOptions.Providers
            .Select(static provider => provider.GetType()
                .GetProperty("ProviderType", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
                .GetValue(provider) as Type
                ?? throw new InvalidOperationException("Response compression provider type metadata was missing."))
            .ToArray();
        Assert.Contains(typeof(BrotliCompressionProvider), compressionProviderTypes);
        Assert.Contains(typeof(GzipCompressionProvider), compressionProviderTypes);
        Assert.Equal(CompressionLevel.Fastest, brotliOptions.Level);
        Assert.Equal(CompressionLevel.Fastest, gzipOptions.Level);
        Assert.Contains("application/json", responseOptions.MimeTypes);
        Assert.Contains("application/rss+xml", responseOptions.MimeTypes);
        Assert.DoesNotContain("application/octet-stream", responseOptions.MimeTypes);
        Assert.DoesNotContain("application/vnd.fsus.aeds", responseOptions.MimeTypes);
        Assert.DoesNotContain("text/html", responseOptions.MimeTypes);
    }

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
                    ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
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
    public void AddFsusApiFoundation_ProductionRejectsDifferentDataProtectionApplicationName()
    {
        string keyRingPath = Path.Combine(Path.GetTempPath(), "fsusblog-data-protection-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var services = new ServiceCollection();
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ASPNETCORE_ENVIRONMENT"] = Environments.Production,
                    ["CORS_ALLOWED_HOSTS"] = "https://fsusblog.test",
                    ["ConnectionStrings:Redis"] = "localhost:6379,connectTimeout=50",
                    ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
                    ["Jwt:Issuer"] = "FsusBlog.Tests",
                    ["Jwt:Audience"] = "FsusBlog.Tests",
                    ["DataProtection:KeyRingPath"] = keyRingPath,
                    ["DataProtection:ApplicationName"] = "FsusBlog.Candidate"
                })
                .Build();

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => services.AddFsusApiFoundation(configuration));

            Assert.Contains("FsusBlog", exception.Message, StringComparison.Ordinal);
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
