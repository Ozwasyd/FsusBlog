using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Collection(nameof(SchemaMigrationPostgresCollectionB))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class AdminSessionProjectionTouchIntegrationTests(PostgresSchemaMigrationFixture postgres)
{
    [Fact]
    public async Task TouchCasConflict_PerformsOneAuthorityRefreshOutsideRequestPath()
    {
        string connection = await CreateDatabaseAsync();
        DateTime now = DateTime.UtcNow;
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection))
        {
            await SeedAsync(db, now, validationVersion: 2);
        }
        AdminSessionProjection projection = ReadyProjection(now, validationVersion: 1);
        using ServiceProvider services = CreateServices(connection, projection);
        AdminSessionTouchScheduler scheduler = services.GetRequiredService<AdminSessionTouchScheduler>();
        await scheduler.StartAsync(CancellationToken.None);

        Assert.True(scheduler.TrySchedule(Request(now, validationVersion: 1)));
        await EventuallyAsync(() => scheduler.Snapshot().AuthorityRefreshCount == 1);
        await scheduler.StopAsync(CancellationToken.None);

        AdminSessionTouchRuntimeSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(1, snapshot.DbCommandCount);
        Assert.Equal(1, snapshot.ConflictCount);
        Assert.Equal(1, snapshot.AuthorityRefreshCount);
        Assert.Equal(2, projection.Validate("sid-1", 1, Hash("token")).SessionVersion);
    }

    [Fact]
    public async Task DatabaseFailure_IsBoundedAndRecordedWithoutBlockingValidation()
    {
        DateTime now = DateTime.UtcNow;
        AdminSessionProjection projection = ReadyProjection(now, validationVersion: 1);
        const string Unreachable = "Host=127.0.0.1;Port=1;Database=missing;Username=missing;Password=missing;Timeout=1;Command Timeout=1";
        using ServiceProvider services = CreateServices(Unreachable, projection, retryDelay: TimeSpan.FromMilliseconds(1));
        AdminSessionTouchScheduler scheduler = services.GetRequiredService<AdminSessionTouchScheduler>();
        await scheduler.StartAsync(CancellationToken.None);

        Assert.True(scheduler.TrySchedule(Request(now, validationVersion: 1)));
        Assert.True(projection.Validate("sid-1", 1, Hash("token")).IsValid);
        await EventuallyAsync(() => scheduler.Snapshot().FailureCount == 1);
        await scheduler.StopAsync(CancellationToken.None);

        AdminSessionTouchRuntimeSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(1, snapshot.EnqueuedCount);
        Assert.Equal(1, snapshot.FailureCount);
        Assert.Equal(0, snapshot.QueueEntries);
    }

    [Fact]
    public async Task ShutdownFlush_DrainsQueuedTouchBeforeWorkerStops()
    {
        string connection = await CreateDatabaseAsync();
        DateTime now = DateTime.UtcNow;
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection))
        {
            await SeedAsync(db, now, validationVersion: 1);
        }
        AdminSessionProjection projection = ReadyProjection(now, validationVersion: 1);
        using ServiceProvider services = CreateServices(connection, projection);
        AdminSessionTouchScheduler scheduler = services.GetRequiredService<AdminSessionTouchScheduler>();
        await scheduler.StartAsync(CancellationToken.None);

        Assert.True(scheduler.TrySchedule(Request(now, validationVersion: 1)));
        await scheduler.StopAsync(CancellationToken.None);

        Assert.Equal(0, scheduler.Snapshot().QueueEntries);
        using SqlSugarClient verify = PostgresSqlSugarTestClient.Create(connection);
        DateTime lastSeen = verify.Queryable<AdminSession>().Single().LastSeenAtUtc!.Value;
        Assert.True(lastSeen > now.AddMinutes(-5));
    }

    private async Task<string> CreateDatabaseAsync()
    {
        string connection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        using SqlSugarClient db = PostgresSqlSugarTestClient.Create(connection);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
        return connection;
    }

    private static async Task SeedAsync(SqlSugarClient db, DateTime now, long validationVersion)
    {
        await db.Insertable(new AdminPrincipal
        {
            Id = 1,
            Handle = "admin",
            Status = AdminPrincipalStatus.Active,
            ValidationVersion = 1,
            Permissions = string.Empty,
            CreatedAtUtc = now.AddHours(-1)
        }).ExecuteCommandAsync();
        await db.Insertable(new AdminSession
        {
            SessionId = "sid-1",
            AdminPrincipalId = 1,
            AccessTokenHash = Convert.ToHexString(Hash("token")),
            ValidationVersion = validationVersion,
            CreatedAtUtc = now.AddHours(-1),
            LastSeenAtUtc = now.AddHours(-1),
            IdleExpiresAtUtc = now.AddHours(1),
            AbsoluteExpiresAtUtc = now.AddHours(2)
        }).ExecuteCommandAsync();
    }

    private static ServiceProvider CreateServices(
        string connection,
        AdminSessionProjection projection,
        TimeSpan? retryDelay = null)
    {
        var options = new AdminSessionProjectionRuntimeOptions(
            new AdminSessionProjectionLimits(16, 16, 1024 * 1024),
            8,
            8,
            8,
            TimeSpan.FromSeconds(45),
            retryDelay ?? TimeSpan.FromMilliseconds(10),
            TimeSpan.FromSeconds(5));
        return new ServiceCollection()
            .AddSingleton(TimeProvider.System)
            .AddSingleton(options)
            .AddSingleton(projection)
            .AddScoped<ISqlSugarClient>(_ => PostgresSqlSugarTestClient.Create(connection))
            .AddScoped<IAdminSessionProjectionAuthorityReader, AdminSessionProjectionAuthorityReader>()
            .AddSingleton<AdminSessionTouchScheduler>()
            .AddSingleton<ILogger<AdminSessionTouchScheduler>>(NullLogger<AdminSessionTouchScheduler>.Instance)
            .BuildServiceProvider();
    }

    private static AdminSessionProjection ReadyProjection(DateTime now, long validationVersion)
    {
        var projection = new AdminSessionProjection(
            new AdminSessionProjectionLimits(16, 16, 1024 * 1024));
        Assert.True(projection.Apply(new AdminSessionProjectionSessionUpdate(
            "sid-1",
            1,
            Hash("token"),
            null,
            new DateTimeOffset(now.AddHours(1), TimeSpan.Zero),
            new DateTimeOffset(now.AddHours(2), TimeSpan.Zero),
            validationVersion,
            validationVersion,
            new AdminSessionProjectionPrincipalUpdate(
                1,
                AdminSessionProjectionPrincipalStatus.Active,
                1,
                1))).Accepted);
        Assert.True(projection.MarkReady(validationVersion));
        return projection;
    }

    private static AdminSessionTouchRequest Request(DateTime now, long validationVersion)
        => new(
            "sid-1",
            validationVersion,
            Hash("token"),
            new DateTimeOffset(now.AddHours(1), TimeSpan.Zero),
            new DateTimeOffset(now.AddHours(2), TimeSpan.Zero));

    private static byte[] Hash(string value)
        => SHA256.HashData(Encoding.UTF8.GetBytes(value));

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate())
        {
            await Task.Delay(25, timeout.Token);
        }
    }
}
