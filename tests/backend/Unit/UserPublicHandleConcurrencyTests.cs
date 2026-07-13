using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserPublicHandleConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task UpdatePublicHandleAsync_ConcurrentSameHandleAllowsOnlyOneUser()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User));
        int firstUserId = await InsertUserAsync(setupDb);
        int secondUserId = await InsertUserAsync(setupDb);
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        UserService firstService = CreateService(firstDb);
        UserService secondService = CreateService(secondDb);
        using var barrier = new Barrier(2);

        (bool Success, string Message)[] results = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => firstService.UpdatePublicHandleAsync(firstUserId, "QuietReader")),
                StartBarrierTaskAsync(barrier, () => secondService.UpdatePublicHandleAsync(secondUserId, "QuietReader")))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static result => result.Success);
        Assert.Single(results, static result => !result.Success && result.Message == "公开称呼已被占用");
        int owners = await setupDb.Queryable<User>()
            .CountAsync(user => user.PublicHandle == "quietreader");
        Assert.Equal(1, owners);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_UniqueConstraintConflictReturnsSpecificConflict()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int firstUserId = await InsertUserAsync(db, "quietreader");
        int secondUserId = await InsertUserAsync(db);
        Assert.NotEqual(firstUserId, secondUserId);
        UserService service = CreateService(db);

        (bool success, string message) = await service.UpdatePublicHandleAsync(secondUserId, "QuietReader");

        Assert.False(success);
        Assert.Equal("公开称呼已被占用", message);
    }

    private static async Task<int> InsertUserAsync(SqlSugarClient db, string? publicHandle = null)
        => await db.Insertable(new User
        {
            PublicHandle = publicHandle,
            Status = 0,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind
        }).ExecuteReturnIdentityAsync();

    private static UserService CreateService(SqlSugarClient db)
        => new(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: Substitute.For<IJwtHelper>(),
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>(),
            _userSessionValidationCache: Substitute.For<IUserSessionValidationCache>());

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent public handle updates.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}
