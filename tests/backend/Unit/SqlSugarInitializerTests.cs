using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class SqlSugarInitializerTests
{
    [Fact]
    public void NormalizeConnectionString_UsesNpgsqlProviderDefaultsWhenSettingsAreMissing()
    {
        string normalized = SqlSugarInitializer.NormalizeConnectionString("Host=localhost;Database=fsus;Username=dev;Password=pwd");
        var actual = new NpgsqlConnectionStringBuilder(normalized);
        var providerDefaults = new NpgsqlConnectionStringBuilder();

        Assert.Equal(providerDefaults.MaxPoolSize, actual.MaxPoolSize);
        Assert.Equal(providerDefaults.MinPoolSize, actual.MinPoolSize);
        Assert.Equal(providerDefaults.Timeout, actual.Timeout);
        Assert.Equal(providerDefaults.CommandTimeout, actual.CommandTimeout);
    }

    [Fact]
    public void NormalizeConnectionString_RespectsExplicitPoolSettings()
    {
        string normalized = SqlSugarInitializer.NormalizeConnectionString(
            "Host=localhost;Database=fsus;Username=dev;Password=pwd;Maximum Pool Size=77;Minimum Pool Size=3;Timeout=9;Command Timeout=45");

        Assert.Contains("Maximum Pool Size=77", normalized, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Minimum Pool Size=3", normalized, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Timeout=9", normalized, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Command Timeout=45", normalized, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AddSqlSugar_RegistersScopedRuntimeClientLeaseWhenNoTestSession()
    {
        ServiceProvider provider = BuildProvider();

        await using AsyncServiceScope scope1 = provider.CreateAsyncScope();
        ISqlSugarClient db1a = scope1.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        ISqlSugarClient db1b = scope1.ServiceProvider.GetRequiredService<ISqlSugarClient>();

        await using AsyncServiceScope scope2 = provider.CreateAsyncScope();
        ISqlSugarClient db2 = scope2.ServiceProvider.GetRequiredService<ISqlSugarClient>();

        Assert.Same(db1a, db1b);
        Assert.NotSame(db1a, db2);
    }

    [Fact]
    public async Task AddSqlSugar_ResolvesDistinctRuntimeLeasesAcrossAsyncScopes()
    {
        ServiceProvider provider = BuildProvider();

        Task<ISqlSugarClient>[] tasks = Enumerable.Range(0, 6)
            .Select(_ => ResolveClientAsync(provider))
            .ToArray();

        ISqlSugarClient[] clients = await Task.WhenAll(tasks);
        int distinctByReference = clients.Distinct(ReferenceEqualityComparer.Instance).Count();

        Assert.Equal(clients.Length, distinctByReference);
    }

    [Fact]
    public async Task AddSqlSugar_UsesScopedClientLeaseForTestSchema()
    {
        ServiceProvider provider = BuildProvider(new FixedTestSessionContext("unit-session"));

        await using AsyncServiceScope scope1 = provider.CreateAsyncScope();
        ISqlSugarClient db1a = scope1.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        ISqlSugarClient db1b = scope1.ServiceProvider.GetRequiredService<ISqlSugarClient>();

        await using AsyncServiceScope scope2 = provider.CreateAsyncScope();
        ISqlSugarClient db2 = scope2.ServiceProvider.GetRequiredService<ISqlSugarClient>();

        Assert.Same(db1a, db1b);
        Assert.NotSame(db1a, db2);
    }

    private static async Task<ISqlSugarClient> ResolveClientAsync(ServiceProvider provider)
    {
        await using AsyncServiceScope scope = provider.CreateAsyncScope();
        return scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
    }

    private static ServiceProvider BuildProvider(ITestSessionContext? testSessionContext = null)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
            .AddInMemoryCollection(
            [
                KeyValuePair.Create<string, string?>("ConnectionStrings:DefaultConnection", "Host=localhost;Database=fsus;Username=dev;Password=pwd")
            ])
            .Build());
        if (testSessionContext is not null)
        {
            services.AddScoped<ITestSessionContext>(_ => testSessionContext);
        }

        services.AddSqlSugar();
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }

    private sealed class FixedTestSessionContext(string sessionId) : ITestSessionContext
    {
        public bool IsActive => true;
        public string SessionId => sessionId;
        public string SchemaName => $"fsus_e2e_{sessionId.Replace('-', '_')}";
        public string PrefixKey(string key) => $"e2e:{sessionId}:{key}";
    }
}
