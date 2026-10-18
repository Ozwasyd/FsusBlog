using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class UserSessionLoginConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    public async Task CompleteLoginAsync_TwoDeviceLoginsRemainActive()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserSession));
        UserLoginWorkflowService service = CreateService(db);
        User user = await SeedAccountAsync(db);

        var first = await service.CompleteLoginAsync(
            user,
            "203.0.113.10",
            deviceFingerprint: "device-a",
            userAgent: "agent-a",
            mfaVerified: true,
            rememberMe: false);
        var second = await service.CompleteLoginAsync(
            user,
            "203.0.113.11",
            deviceFingerprint: "device-b",
            userAgent: "agent-b",
            mfaVerified: true,
            rememberMe: false);

        Assert.True(first.Success, first.Message);
        Assert.True(second.Success, second.Message);

        List<UserSession> sessions = await db.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id)
            .OrderBy(session => session.CreatedAt)
            .ToListAsync();

        Assert.Equal(2, sessions.Count);
        Assert.All(sessions, static session => Assert.Null(session.RevokedAt));
        Assert.All(sessions, static session => Assert.NotNull(session.DeviceSignalHash));
        Assert.Equal(2, sessions.Select(static session => session.DeviceSignalHash).Distinct(StringComparer.Ordinal).Count());
        Assert.Contains(sessions, session => session.SessionId == first.Data?.SessionId);
        Assert.Contains(sessions, session => session.SessionId == second.Data?.SessionId);
    }

    [Fact]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Boundary)]
    public async Task CompleteLoginAsync_ActiveSessionLimitEvictsLeastRecentlyUsedSession()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserSession));
        User user = await SeedAccountAsync(db);
        UserLoginWorkflowService service = CreateService(db, maxActiveSessions: 2);

        var first = await service.CompleteLoginAsync(user, "203.0.113.10", "device-a", "agent-a", true, false);
        await Task.Delay(5);
        var second = await service.CompleteLoginAsync(user, "203.0.113.11", "device-b", "agent-b", true, false);
        await Task.Delay(5);
        var third = await service.CompleteLoginAsync(user, "203.0.113.12", "device-c", "agent-c", true, false);

        Assert.True(first.Success, first.Message);
        Assert.True(second.Success, second.Message);
        Assert.True(third.Success, third.Message);
        List<UserSession> sessions = await db.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id)
            .OrderBy(session => session.CreatedAt)
            .ToListAsync();

        Assert.Equal(3, sessions.Count);
        UserSession evicted = Assert.Single(sessions, static session => session.RevokedAt is not null);
        Assert.Equal(first.Data?.SessionId, evicted.SessionId);
        Assert.Equal("active_session_limit", evicted.RevokeReason);
        Assert.Equal(2, sessions.Count(static session => session.RevokedAt is null));
        Assert.Contains(sessions, session => session.SessionId == third.Data?.SessionId && session.RevokedAt is null);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CompleteLoginAsync_ConcurrentDevicesUnderLimitReturnActiveSessions()
    {
        using SqlSugarClient setupDb = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(UserSession));
        User user = await SeedAccountAsync(setupDb);
        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserLoginWorkflowService firstService = CreateService(firstDb);
        UserLoginWorkflowService secondService = CreateService(secondDb);

        var results = await RealConcurrencyHarness.RunAsync(
            () => firstService.CompleteLoginAsync(user, "203.0.113.20", "device-concurrent-a", "agent-a", true, false),
            () => secondService.CompleteLoginAsync(user, "203.0.113.21", "device-concurrent-b", "agent-b", true, false));

        Assert.All(results, result => Assert.True(result.Success, result.Message));
        string[] issuedSessionIds = results.Select(result => result.Data?.SessionId).OfType<string>().ToArray();
        Assert.Equal(2, issuedSessionIds.Length);
        List<UserSession> active = await setupDb.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id && session.RevokedAt == null)
            .ToListAsync();
        Assert.Equal(2, active.Count);
        Assert.All(issuedSessionIds, sessionId => Assert.Contains(active, session => session.SessionId == sessionId));
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CompleteLoginAsync_ConcurrentSameDeviceCreatesIndependentSessions()
    {
        using SqlSugarClient setupDb = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(UserSession));
        User user = await SeedAccountAsync(setupDb);
        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);

        var results = await RealConcurrencyHarness.RunAsync(
            () => CreateService(firstDb).CompleteLoginAsync(user, "203.0.113.25", "same-device", "agent", true, false),
            () => CreateService(secondDb).CompleteLoginAsync(user, "203.0.113.25", "same-device", "agent", true, false));

        Assert.All(results, result => Assert.True(result.Success, result.Message));
        string[] issuedSessionIds = results.Select(result => result.Data?.SessionId).OfType<string>().ToArray();
        Assert.Equal(2, issuedSessionIds.Distinct(StringComparer.Ordinal).Count());
        List<UserSession> active = await setupDb.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id && session.RevokedAt == null)
            .ToListAsync();
        Assert.All(issuedSessionIds, sessionId => Assert.Contains(active, session => session.SessionId == sessionId));
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CompleteLoginAsync_ConcurrentAdmissionsNeverExceedActiveSessionLimit()
    {
        using SqlSugarClient setupDb = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(UserSession));
        User user = await SeedAccountAsync(setupDb);
        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient thirdDb = PostgresSqlSugarTestClient.Create(connectionString);

        var results = await RealConcurrencyHarness.RunAsync(
            () => CreateService(firstDb, 2).CompleteLoginAsync(user, "203.0.113.26", "limit-a", "agent-a", true, false),
            () => CreateService(secondDb, 2).CompleteLoginAsync(user, "203.0.113.27", "limit-b", "agent-b", true, false),
            () => CreateService(thirdDb, 2).CompleteLoginAsync(user, "203.0.113.28", "limit-c", "agent-c", true, false));

        Assert.All(results, result => Assert.True(result.Success, result.Message));
        List<UserSession> sessions = await setupDb.Queryable<UserSession>()
            .Where(session => session.UserId == user.Id)
            .ToListAsync();
        Assert.Equal(2, sessions.Count(static session => session.RevokedAt is null));
        Assert.Single(sessions, static session => session.RevokeReason == "active_session_limit");
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CompleteLoginAsync_ConcurrentRevokeOthersDoesNotRevokeNewSession()
    {
        using SqlSugarClient setupDb = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(UserSession));
        User user = await SeedAccountAsync(setupDb);
        var current = await CreateService(setupDb).CompleteLoginAsync(
            user,
            "203.0.113.30",
            "device-current",
            "agent-current",
            true,
            false);
        Assert.True(current.Success, current.Message);
        SessionTokenResponseDto currentData = Assert.NotNull(current.Data);

        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient revokeDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient loginDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserSessionCommandService commandService = CreateSessionCommandService(revokeDb);
        UserLoginWorkflowService loginService = CreateService(loginDb);

        await RealConcurrencyHarness.RunInterleavedAsync(
            () => commandService.RevokeOtherSessionsAsync(user.Id, currentData.SessionId),
            async revokeTask =>
            {
                var loginTask = loginService.CompleteLoginAsync(
                    user,
                    "203.0.113.31",
                    "device-new",
                    "agent-new",
                    true,
                    false);
                await Task.WhenAll(revokeTask, loginTask);

                var login = await loginTask;
                Assert.True(login.Success, login.Message);
                List<UserSession> active = await setupDb.Queryable<UserSession>()
                    .Where(session => session.UserId == user.Id && session.RevokedAt == null)
                    .ToListAsync();
                Assert.Contains(active, session => session.SessionId == currentData.SessionId);
                Assert.Contains(active, session => session.SessionId == login.Data!.Value.SessionId);
            },
            static () => { });
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task CompleteLoginAsync_ConcurrentAccountDeletionLeavesNoActiveSession()
    {
        using SqlSugarClient setupDb = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            setupDb,
            typeof(User),
            typeof(UserSession),
            typeof(PasskeyCredential),
            typeof(RecoveryKeyCredential),
            typeof(AnonymousCredential),
            typeof(UserMfaProfile));
        User user = await SeedAccountAsync(setupDb);
        string connectionString = setupDb.CurrentConnectionConfig.ConnectionString;
        using SqlSugarClient deleteDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient loginDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserProfileCommandService profileService = CreateProfileCommandService(deleteDb);
        UserLoginWorkflowService loginService = CreateService(loginDb);

        await RealConcurrencyHarness.RunInterleavedAsync(
            () => profileService.DeleteAccountAsync(
            user.Id,
            new DeleteAccountRequestDto { ConfirmText = "DELETE" }),
            async deleteTask =>
            {
                var loginTask = loginService.CompleteLoginAsync(
                    user,
                    "203.0.113.40",
                    "device-delete-race",
                    "agent-delete-race",
                    true,
                    false);
                await Task.WhenAll(deleteTask, loginTask);

                Assert.True((await deleteTask).Success);
                User deleted = await setupDb.Queryable<User>().InSingleAsync(user.Id);
                Assert.Equal(2, deleted.Status);
                Assert.NotNull(deleted.DeletedAt);
                Assert.Empty(await setupDb.Queryable<UserSession>()
                    .Where(session => session.UserId == user.Id && session.RevokedAt == null)
                    .ToListAsync());
            },
            static () => { });
    }

    private static async Task<User> SeedAccountAsync(SqlSugarClient db)
    {
        var user = new User
        {
            PublicHandle = $"multi-{Guid.NewGuid():N}"[..20],
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = 0,
            PrivacyInitializedAt = DateTime.UtcNow
        };
        user.AccountSubjectHash = AccountSubjectHasher.Create(user);
        user.Id = await db.Insertable(user).ExecuteReturnIdentityAsync();
        return user;
    }

    private static UserLoginWorkflowService CreateService(ISqlSugarClient db, int maxActiveSessions = 10)
    {
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns(_ => $"refresh-token-{Guid.NewGuid():N}");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns(
            new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<UserSessionAuthenticationContext>()).Returns(
            new IssuedAccessToken("access-token", DateTimeOffset.UtcNow.AddMinutes(15)));

        return new UserLoginWorkflowService(
            db,
            NullLogger<UserLoginWorkflowService>.Instance,
            jwt,
            Substitute.For<IUserSessionValidationCache>(),
            Substitute.For<IAuthRiskService>(),
            new UserSessionMetadataProtector(
                new SecurityRiskPseudonymizer(1, Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray())),
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [UserSessionPolicy.MaxActiveSessionsConfigurationKey] = maxActiveSessions.ToString(System.Globalization.CultureInfo.InvariantCulture)
                })
                .Build());
    }

    private static UserSessionCommandService CreateSessionCommandService(ISqlSugarClient db)
        => new(
            db,
            NullLogger<UserSessionCommandService>.Instance,
            Substitute.For<IJwtHelper>(),
            Substitute.For<IUserSessionValidationCache>());

    private static UserProfileCommandService CreateProfileCommandService(ISqlSugarClient db)
        => new(
            db,
            NullLogger<UserProfileCommandService>.Instance,
            Substitute.For<IBanStateProjectionObligationCoordinator>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<IAccountStateProjectionMutationPublisher>(),
            Substitute.For<IUserSessionValidationCache>());
}
