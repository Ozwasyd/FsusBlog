using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AdminSessionTouchPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    private const string AccessToken = "admin-touch-fixture-token";

    [Fact]
    public async Task ValidatedSession_QueuesThenPersistsLastSeenUsingInjectedClock()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSession session = SeedSession(db, temporal.BusinessEpochUtc);
        var authority = Substitute.For<IAdminSessionProjectionAuthorityReader>();
        await using ServiceProvider services = CreateServices(connectionString, authority);
        using AdminSessionTouchScheduler scheduler = CreateScheduler(services, temporal.BusinessClock);
        var service = new AdminSessionValidationService(CreateProjection(session, temporal.BusinessClock), scheduler);

        AdminSessionValidationResult result = await service.ValidateAsync(Principal(session), AccessToken, default);

        Assert.True(result.IsValid, result.Reason);
        Assert.Equal(1, scheduler.Snapshot().QueueEntries);
        AdminSession beforeDrain = await db.Queryable<AdminSession>().InSingleAsync(session.SessionId);
        Assert.Equal(session.LastSeenAtUtc, beforeDrain.LastSeenAtUtc);

        temporal.Advance(TimeSpan.FromSeconds(2));
        await scheduler.StartAsync(default);
        await scheduler.StopAsync(default);

        AdminSession stored = await db.Queryable<AdminSession>().InSingleAsync(session.SessionId);
        Assert.Equal(temporal.BusinessEpochUtc.UtcDateTime, stored.LastSeenAtUtc);
        Assert.Equal(session.ValidationVersion, stored.ValidationVersion);
        Assert.Equal(session.IdleExpiresAtUtc, stored.IdleExpiresAtUtc);
        Assert.Equal(session.AbsoluteExpiresAtUtc, stored.AbsoluteExpiresAtUtc);
        AdminSessionTouchRuntimeSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(1, snapshot.DbCommandCount);
        Assert.Equal(0, snapshot.QueueEntries);
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(0, snapshot.ConflictCount);
        Assert.Equal(0, snapshot.FailureCount);
        await authority.DidNotReceive().RefreshSessionAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("version")]
    [InlineData("token")]
    [InlineData("revoked")]
    [InlineData("idle-expiry")]
    [InlineData("absolute-expiry")]
    public async Task QueuedTouch_RejectsChangedAuthorityAndRequestsRefresh(string changedField)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminSession));
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSession session = SeedSession(db, temporal.BusinessEpochUtc);
        var authority = Substitute.For<IAdminSessionProjectionAuthorityReader>();
        authority.RefreshSessionAsync(session.SessionId, Arg.Any<CancellationToken>()).Returns(Task.FromResult(true));
        await using ServiceProvider services = CreateServices(connectionString, authority);
        using AdminSessionTouchScheduler scheduler = CreateScheduler(services, temporal.BusinessClock);
        var service = new AdminSessionValidationService(CreateProjection(session, temporal.BusinessClock), scheduler);
        Assert.True((await service.ValidateAsync(Principal(session), AccessToken, default)).IsValid);
        Assert.Equal(1, scheduler.Snapshot().QueueEntries);

        switch (changedField)
        {
            case "version":
                session.ValidationVersion++;
                break;
            case "token":
                session.AccessTokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("rotated-token")));
                break;
            case "revoked":
                session.RevokedAtUtc = temporal.BusinessEpochUtc.UtcDateTime;
                break;
            case "idle-expiry":
                session.IdleExpiresAtUtc = session.IdleExpiresAtUtc.AddMinutes(1);
                break;
            case "absolute-expiry":
                session.AbsoluteExpiresAtUtc = session.AbsoluteExpiresAtUtc.AddHours(1);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(changedField));
        }
        Assert.Equal(1, await db.Updateable(session).ExecuteCommandAsync());

        await scheduler.StartAsync(default);
        await scheduler.StopAsync(default);

        AdminSession stored = await db.Queryable<AdminSession>().InSingleAsync(session.SessionId);
        Assert.Equal(session.LastSeenAtUtc, stored.LastSeenAtUtc);
        Assert.Equal(session.ValidationVersion, stored.ValidationVersion);
        Assert.Equal(session.AccessTokenHash, stored.AccessTokenHash);
        Assert.Equal(session.RevokedAtUtc, stored.RevokedAtUtc);
        AdminSessionTouchRuntimeSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(1, snapshot.DbCommandCount);
        Assert.Equal(1, snapshot.ConflictCount);
        Assert.Equal(1, snapshot.AuthorityRefreshCount);
        Assert.Equal(0, snapshot.FailureCount);
        Assert.Equal(0, snapshot.QueueEntries);
        Assert.Equal(0, snapshot.InFlightCount);
        await authority.Received(1).RefreshSessionAsync(session.SessionId, Arg.Any<CancellationToken>());
    }

    private static AdminSession SeedSession(SqlSugarClient db, DateTimeOffset now)
    {
        var session = new AdminSession
        {
            SessionId = "admin-touch-session",
            AdminPrincipalId = 7,
            AccessTokenHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AccessToken))),
            ValidationVersion = 1,
            CreatedAtUtc = now.UtcDateTime.AddMinutes(-10),
            LastSeenAtUtc = now.UtcDateTime.AddMinutes(-5),
            IdleExpiresAtUtc = now.UtcDateTime.AddMinutes(10),
            AbsoluteExpiresAtUtc = now.UtcDateTime.AddHours(1)
        };
        Assert.Equal(1, db.Insertable(session).ExecuteCommand());
        return session;
    }

    private static ServiceProvider CreateServices(
        string connectionString,
        IAdminSessionProjectionAuthorityReader authority)
        => new ServiceCollection()
            .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connectionString))
            .AddSingleton(authority)
            .BuildServiceProvider();

    private static AdminSessionTouchScheduler CreateScheduler(IServiceProvider services, TimeProvider clock)
        => new(
            services.GetRequiredService<IServiceScopeFactory>(),
            AdminSessionProjectionRuntimeOptions.FromConfiguration(new ConfigurationBuilder().Build()),
            clock,
            NullLogger<AdminSessionTouchScheduler>.Instance);

    private static AdminSessionProjection CreateProjection(AdminSession session, TimeProvider clock)
    {
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(32, 32, 1024 * 1024), clock);
        var update = new AdminSessionProjectionSessionUpdate(
            session.SessionId,
            session.AdminPrincipalId,
            Convert.FromHexString(session.AccessTokenHash),
            null,
            new DateTimeOffset(session.IdleExpiresAtUtc),
            new DateTimeOffset(session.AbsoluteExpiresAtUtc),
            session.ValidationVersion,
            1,
            new AdminSessionProjectionPrincipalUpdate(session.AdminPrincipalId, AdminSessionProjectionPrincipalStatus.Active, 1, 1));
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(update).Status);
        Assert.True(projection.MarkReady(1));
        return projection;
    }

    private static ClaimsPrincipal Principal(AdminSession session)
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", session.AdminPrincipalId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("admin_sid", session.SessionId)
        ], "test"));
}
