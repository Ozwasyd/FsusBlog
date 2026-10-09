using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using Fido2NetLib;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminFixtureSessionIssuanceTests
{
    [Theory]
    [InlineData("missing")]
    [InlineData("wrong-id")]
    [InlineData("foreign-handle")]
    [InlineData("disabled")]
    [InlineData("root")]
    public void InternalIssuance_RejectsForeignOrInactivePrincipalBeforeWriter(string change)
    {
        var row = new AdminPrincipal { Id = 7, Handle = "fxauth-owned", Status = AdminPrincipalStatus.Active };
        AdminPrincipalService.RequireOwnedIssuancePrincipal(row, 7, "fxauth-owned");
        if (change == "wrong-id")
            row.Id = 8;
        if (change == "foreign-handle")
            row.Handle = "unowned";
        if (change == "disabled")
            row.Status = AdminPrincipalStatus.Disabled;
        if (change == "root")
            row.IsRoot = true;
        Assert.Throws<InvalidOperationException>(() => AdminPrincipalService.RequireOwnedIssuancePrincipal(
            change == "missing" ? null : row, 7, "fxauth-owned"));
    }

    [Fact]
    public void ProductionRegistration_AliasesBothInterfacesToOneScopedOwner()
    {
        var config = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(config);
        services.AddLogging();
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddScoped<ISqlSugarClient>(_ => Substitute.For<ISqlSugarClient>());
        services.AddScoped<ICacheStringWriter>(_ => Substitute.For<ICacheStringWriter>());
        services.AddScoped<ICacheOneTimeStore>(_ => Substitute.For<ICacheOneTimeStore>());
        services.AddScoped<IJwtHelper>(_ => Substitute.For<IJwtHelper>());
        services.AddScoped<IAdminAuditLogChannel>(_ => Substitute.For<IAdminAuditLogChannel>());
        services.AddFsusRuntimeSecurityAndLifecycleServices(config);
        services.AddScoped<IAdminSessionProjectionMutationCoordinator>(_ => Substitute.For<IAdminSessionProjectionMutationCoordinator>());
        using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        var owner = scope.ServiceProvider.GetRequiredService<AdminPrincipalService>();
        Assert.Same(owner, scope.ServiceProvider.GetRequiredService<IAdminPrincipalService>());
        Assert.Same(owner, scope.ServiceProvider.GetRequiredService<IAdminSessionIssuancePort>());
        using var nextScope = provider.CreateScope();
        Assert.NotSame(owner, nextScope.ServiceProvider.GetRequiredService<IAdminSessionIssuancePort>());
    }

    [Theory]
    [InlineData("Production", true, "accepted", true, "run", 404)]
    [InlineData("Development", false, "accepted", true, "run", 404)]
    [InlineData("Development", true, "", true, "run", 401)]
    [InlineData("Development", true, "wrong", true, "run", 401)]
    [InlineData("Development", true, "accepted", false, "run", 404)]
    [InlineData("Development", true, "accepted", true, "foreign", 400)]
    public async Task PrivateRoutes_RejectBeforeAuthorityPort(string environment, bool enabled, string secret,
        bool loopback, string runHeader, int expectedStatus)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AllowedHosts"] = "*",
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = enabled.ToString(),
            [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = "accepted"
        });
        var seeder = Substitute.For<IAuthFixtureSeeder>();
        builder.Services.AddSingleton(seeder);
        builder.Services.AddSingleton(Substitute.For<ILocalAuthFixtureRefreshRunner>());
        builder.Services.AddSingleton(Substitute.For<IAdminPrincipalService>());
        await using WebApplication app = builder.Build();
        app.Use((context, next) =>
        {
            context.Connection.RemoteIpAddress = loopback ? IPAddress.Loopback : IPAddress.Parse("192.0.2.15");
            return next(context);
        });
        app.MapLocalAuthFixtureEndpoints();
        await app.StartAsync();
        AuthFixturePrivatePayload payload = AuthFixturePrivateProjectionTests.Payload();
        foreach (string action in new[] { "verify", "cleanup" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/local/auth-fixture/private/" + action)
            {
                Content = JsonContent.Create(new AuthFixturePrivateVerificationRequest(payload.Identity, "not-an-issued-carrier", payload.PublicFact))
            };
            request.Headers.Add("X-Fsus-Local-Auth-Fixture-Secret", secret);
            request.Headers.Add("X-Fsus-Test-Run-Id", runHeader);
            request.Headers.Add("X-Fsus-Test-Namespace", "ns");
            using var response = await app.GetTestClient().SendAsync(request);
            Assert.Equal(expectedStatus, (int)response.StatusCode);
        }
        await seeder.DidNotReceiveWithAnyArgs().VerifyPrivateAsync(default!, default);
        await seeder.DidNotReceiveWithAnyArgs().CleanupPrivateAsync(default!, default);
    }
}

// Real PostgreSQL production-writer contracts with controlled publication/audit
// failures. These are not Kestrel/Redis fixture or runtime-cache qualification.
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class TypedAdminSessionWriterDatabaseTests(PostgresSchemaMigrationFixture postgres)
{
    [Theory]
    [InlineData("prepare")]
    [InlineData("publish")]
    [InlineData("audit")]
    [InlineData("recovery")]
    [InlineData("success")]
    public async Task SoleWriter_PreservesTransactionPublishAuditAndExactRecovery(string scenario)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
        db.CodeFirst.InitTables<AdminPrincipal, AdminSession>();
        var principal = new AdminPrincipal
        {
            Handle = "fxauth-writer-owned",
            Status = AdminPrincipalStatus.Active,
            Permissions = JsonSerializer.Serialize(AdminPermissions.All)
        };
        principal.Id = await db.Insertable(principal).ExecuteReturnBigIdentityAsync();
        var clock = TestTemporalContext.FromEnvironment().BusinessClock;
        var jwt = new JwtHelper(Options.Create(new JwtSettings
        {
            KeyVersion = "test-v1",
            SecretKey = TestSecrets.JwtSigningKey,
            Issuer = "writer-test",
            Audience = "writer-test",
            AccessTokenExpiresMinutes = 15
        }), timeProvider: clock);
        var coordinator = Substitute.For<IAdminSessionProjectionMutationCoordinator>();
        var audit = Substitute.For<IAdminAuditLogChannel>();
        var ordering = new List<string>();
        int publications = 0;
        bool failRecovery = scenario == "recovery";
        coordinator.PrepareSessionsAsync(Arg.Any<IReadOnlyCollection<string>>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                ordering.Add("prepare");
                if (scenario == "prepare")
                    throw new InvalidOperationException("controlled prepare failure");
                return Task.FromResult(new PreparedAdminSessionProjectionMutation([], [], null));
            });
        coordinator.PublishPreparedAsync(Arg.Any<PreparedAdminSessionProjectionMutation>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                ordering.Add("publish");
                publications++;
                Assert.Null(db.Ado.Transaction);
                if ((scenario == "publish" && publications == 1) || failRecovery)
                    throw new InvalidOperationException("controlled publish failure");
                return Task.CompletedTask;
            });
        audit.EnqueueAsync(Arg.Any<AdminAuditLog>(), Arg.Any<CancellationToken>()).Returns(call =>
        {
            var item = call.Arg<AdminAuditLog>();
            ordering.Add(item.Action);
            if (scenario == "audit" && item.Action == "admin.login.completed")
                throw new InvalidOperationException("controlled audit enqueue failure");
            return ValueTask.CompletedTask;
        });
        IAdminSessionIssuancePort port = new AdminPrincipalService(Substitute.For<IFido2>(), db,
            Substitute.For<ICacheStringWriter>(), Substitute.For<ICacheOneTimeStore>(), jwt,
            new ConfigurationBuilder().Build(), NullLogger<AdminPrincipalService>.Instance, audit, coordinator, clock);
        var context = new AdminAuthClientContext("127.0.0.1", null, "writer regression");
        if (scenario == "prepare")
        {
            Assert.Null(await port.IssueAsync(principal.Id, principal.Handle, context, default));
            Assert.Equal(0, await db.Queryable<AdminSession>().CountAsync());
            Assert.Null((await db.Queryable<AdminPrincipal>().FirstAsync()).LastLoginAtUtc);
            Assert.Equal(new[] { "prepare" }, ordering);
            return;
        }
        if (scenario == "success")
        {
            AdminSessionTokens first = (await port.IssueAsync(principal.Id, principal.Handle, context, default))!;
            AdminSessionTokens second = (await port.IssueAsync(principal.Id, principal.Handle, context, default))!;
            Assert.NotEqual(first.SessionId, second.SessionId);
            var sessions = await db.Queryable<AdminSession>().ToListAsync();
            Assert.Equal(2, sessions.Count);
            Assert.All(sessions, row =>
            {
                Assert.Null(row.RevokedAtUtc);
                Assert.False(row.StepUpVerified);
                Assert.Equal(TimeSpan.FromHours(8), row.IdleExpiresAtUtc - row.CreatedAtUtc);
                Assert.Equal(TimeSpan.FromHours(12), row.AbsoluteExpiresAtUtc - row.CreatedAtUtc);
            });
            Assert.Equal(new[] { "prepare", "publish", "admin.login.completed", "prepare", "publish", "admin.login.completed" }, ordering);
            await port.CleanupAsync(principal.Id, first.SessionId, default);
            await port.CleanupAsync(principal.Id, first.SessionId, default);
            Assert.Null((await db.Queryable<AdminSession>().Where(row => row.SessionId == second.SessionId).FirstAsync()).RevokedAtUtc);
            return;
        }
        if (scenario == "recovery")
        {
            var failure = await Assert.ThrowsAsync<AdminSessionIssuanceRecoveryException>(() => port.IssueAsync(principal.Id, principal.Handle, context, default));
            AdminSessionTokens recovery = failure.RecoveryCredentials();
            Assert.False(failure.ToString().Contains(recovery.AccessToken, StringComparison.Ordinal), "failure must not disclose private credentials");
            failRecovery = false;
            await port.CleanupAsync(principal.Id, recovery.SessionId, default);
            await port.CleanupAsync(principal.Id, recovery.SessionId, default);
        }
        else
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => port.IssueAsync(principal.Id, principal.Handle, context, default));
        }
        AdminSession row = await db.Queryable<AdminSession>().SingleAsync();
        Assert.NotNull(row.RevokedAtUtc);
        Assert.Equal(2, row.ValidationVersion);
        Assert.Equal("prepare", ordering[0]);
        Assert.Equal("publish", ordering[1]);
    }
}
