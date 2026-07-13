using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class SystemServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ConfigLoadQueries_UseServerSideKeySetsWithoutReadingPrivateConfigRows()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(SystemConfig));
        db.Insertable(new[]
        {
            new SystemConfig { Key = "Seo_Title", Value = "Runtime title" },
            new SystemConfig { Key = "Compliance_Enabled", Value = "true" },
            new SystemConfig { Key = "Jwt_PrivateKey", Value = "must-not-project" }
        }).ExecuteCommand();
        var executed = new List<(string Sql, object?[] Values)>();
        db.Aop.OnLogExecuting = (sql, parameters) => executed.Add((
            sql,
            parameters.Select(static parameter => parameter.Value).ToArray()));
        var service = new SystemService(
            db,
            Substitute.For<IUnifiedCache>(),
            Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(),
            NullLogger<SystemService>.Instance,
            Substitute.For<IPublicAotInvalidationService>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<ICacheInvalidationDispatcher>());

        SeoConfigReadModel seo = await InvokeLoaderAsync<SeoConfigReadModel>(service, "LoadSeoConfigFromDbAsync");
        SiteComplianceConfigReadModel compliance = await InvokeLoaderAsync<SiteComplianceConfigReadModel>(service, "LoadComplianceConfigFromDbAsync");

        Assert.Equal("Runtime title", seo.Title);
        Assert.True(compliance.Enabled);
        Assert.Equal(2, executed.Count);
        Assert.All(executed, static command => Assert.Contains(" IN ", command.Sql, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(executed.SelectMany(static command => command.Values), static value =>
            string.Equals(value?.ToString(), "Jwt_PrivateKey", StringComparison.Ordinal)
            || string.Equals(value?.ToString(), "must-not-project", StringComparison.Ordinal));
    }

    private static async Task<T> InvokeLoaderAsync<T>(SystemService service, string methodName)
    {
        MethodInfo method = typeof(SystemService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"System config loader was not found: {methodName}");
        var task = Assert.IsAssignableFrom<Task<T>>(method.Invoke(service, [CancellationToken.None]));
        return await task;
    }
}
