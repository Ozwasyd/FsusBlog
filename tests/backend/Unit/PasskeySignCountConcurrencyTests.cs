using System.Reflection;
using Fido2NetLib;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class PasskeySignCountConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly MethodInfo TryUpdatePasskeySignCount = typeof(PasskeyService)
        .GetMethod("TryUpdatePasskeySignCountAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("TryUpdatePasskeySignCountAsync should exist.");

    private static readonly MethodInfo LoadAdminPasskeyRowVersion = typeof(AdminPrincipalService)
        .GetMethod("LoadAdminPasskeyRowVersionAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("LoadAdminPasskeyRowVersionAsync should exist.");

    private static readonly MethodInfo TryUpdateAdminPasskeySignCount = typeof(AdminPrincipalService)
        .GetMethod("TryUpdateAdminPasskeySignCountAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("TryUpdateAdminPasskeySignCountAsync should exist.");

    private static readonly MethodInfo GetOrCreateStablePasskeyUserHandle = typeof(PasskeyService)
        .GetMethod("GetOrCreateStablePasskeyUserHandleAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("GetOrCreateStablePasskeyUserHandleAsync should exist.");

    [Fact]
    public async Task StablePasskeyUserHandle_ConcurrentFirstRegistrationReturnsOneFinalHandle()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User));
        int accountId = await setupDb.Insertable(new User
        {
            PublicHandle = "writer",
            PasskeyUserHandle = null,
            Status = 0
        }).ExecuteReturnIdentityAsync();
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        PasskeyService firstService = CreatePasskeyService(firstDb);
        PasskeyService secondService = CreatePasskeyService(secondDb);
        var firstStaleUser = new User { Id = accountId, PasskeyUserHandle = null };
        var secondStaleUser = new User { Id = accountId, PasskeyUserHandle = null };
        using var barrier = new Barrier(2);

        byte[][] handles = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => InvokeGetOrCreateStablePasskeyUserHandleAsync(firstService, firstStaleUser)),
                StartBarrierTaskAsync(barrier, () => InvokeGetOrCreateStablePasskeyUserHandleAsync(secondService, secondStaleUser)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.True(handles[0].AsSpan().SequenceEqual(handles[1]));
        User stored = await setupDb.Queryable<User>().SingleAsync(item => item.Id == accountId);
        Assert.False(string.IsNullOrWhiteSpace(stored.PasskeyUserHandle));
        Assert.Equal(stored.PasskeyUserHandle, firstStaleUser.PasskeyUserHandle);
        Assert.Equal(stored.PasskeyUserHandle, secondStaleUser.PasskeyUserHandle);
    }

    [Fact]
    public async Task RemoveCredentialAsync_ConcurrentDeletesKeepOnePasskeyWithoutRecovery()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(PasskeyCredential));
        int accountId = await setupDb.Insertable(new User
        {
            PublicHandle = "writer",
            PasskeyEnabled = true,
            RecoveryEnabled = false,
            Status = 0
        }).ExecuteReturnIdentityAsync();
        int firstCredentialId = await InsertCredentialAsync(setupDb, accountId, "first");
        int secondCredentialId = await InsertCredentialAsync(setupDb, accountId, "second");
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        PasskeyService firstService = CreatePasskeyService(firstDb);
        PasskeyService secondService = CreatePasskeyService(secondDb);
        using var barrier = new Barrier(2);

        PasskeyCredentialMutationResult[] results = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => firstService.RemoveCredentialAsync(accountId, firstCredentialId, CancellationToken.None)),
                StartBarrierTaskAsync(barrier, () => secondService.RemoveCredentialAsync(accountId, secondCredentialId, CancellationToken.None)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static result => result.Success);
        Assert.Single(results, static result => !result.Success && result.Message == PasskeyService.CannotRemoveLastCredentialWithoutRecovery);
        int remainingCredentials = await setupDb.Queryable<PasskeyCredential>()
            .CountAsync(item => item.AccountId == accountId);
        User stored = await setupDb.Queryable<User>().SingleAsync(item => item.Id == accountId);
        Assert.Equal(1, remainingCredentials);
        Assert.True(stored.PasskeyEnabled);
        Assert.False(stored.RecoveryEnabled);
    }

    [Fact]
    public async Task UserPasskeySignCount_ConcurrentStaleRowVersionAllowsOnlyOneUpdate()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(PasskeyCredential));
        int credentialId = await setupDb.Insertable(new PasskeyCredential
        {
            AccountId = 42,
            CredentialId = "credential",
            PublicKey = "public-key",
            SignCount = 7,
            AaGuid = Guid.Empty.ToString()
        }).ExecuteReturnIdentityAsync();
        string? loadedRowVersion = await LoadPasskeyRowVersionForTestAsync(setupDb, credentialId);
        Assert.NotNull(loadedRowVersion);
        string rowVersion = loadedRowVersion;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        PasskeyService firstService = CreatePasskeyService(firstDb);
        PasskeyService secondService = CreatePasskeyService(secondDb);
        using var barrier = new Barrier(2);

        bool[] results = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => InvokeTryUpdatePasskeySignCountAsync(firstService, credentialId, 7, rowVersion, 8)),
                StartBarrierTaskAsync(barrier, () => InvokeTryUpdatePasskeySignCountAsync(secondService, credentialId, 7, rowVersion, 8)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static result => result);
        PasskeyCredential stored = await setupDb.Queryable<PasskeyCredential>().SingleAsync(item => item.Id == credentialId);
        Assert.Equal(8, stored.SignCount);
    }

    [Fact]
    public async Task AdminPasskeySignCount_ConcurrentStaleRowVersionAllowsOnlyOneUpdate()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(AdminPasskeyCredential));
        long credentialId = await setupDb.Insertable(new AdminPasskeyCredential
        {
            AdminPrincipalId = 7,
            CredentialId = "admin-credential",
            UserHandle = "admin-handle",
            PublicKey = "public-key",
            SignCount = 11,
            AaGuid = Guid.Empty.ToString()
        }).ExecuteReturnBigIdentityAsync();
        AdminPrincipalService setupService = CreateAdminPrincipalService(setupDb);
        string? loadedRowVersion = await InvokeLoadAdminPasskeyRowVersionAsync(setupService, credentialId);
        Assert.NotNull(loadedRowVersion);
        string rowVersion = loadedRowVersion;
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        AdminPrincipalService firstService = CreateAdminPrincipalService(firstDb);
        AdminPrincipalService secondService = CreateAdminPrincipalService(secondDb);
        using var barrier = new Barrier(2);

        bool[] results = await Task.WhenAll(
                StartBarrierTaskAsync(barrier, () => InvokeTryUpdateAdminPasskeySignCountAsync(firstService, credentialId, 11, rowVersion, 12)),
                StartBarrierTaskAsync(barrier, () => InvokeTryUpdateAdminPasskeySignCountAsync(secondService, credentialId, 11, rowVersion, 12)))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Single(results, static result => result);
        AdminPasskeyCredential stored = await setupDb.Queryable<AdminPasskeyCredential>().SingleAsync(item => item.Id == credentialId);
        Assert.Equal(12, stored.SignCount);
    }

    private static PasskeyService CreatePasskeyService(SqlSugarClient db)
        => new(
            Substitute.For<IFido2>(),
            db,
            Substitute.For<IUnifiedCache>(),
            NullLogger<PasskeyService>.Instance);

    private static AdminPrincipalService CreateAdminPrincipalService(SqlSugarClient db)
        => new(
            Substitute.For<IFido2>(),
            db,
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IJwtHelper>(),
            new ConfigurationBuilder().Build(),
            NullLogger<AdminPrincipalService>.Instance,
            Substitute.For<IAdminAuditLogChannel>());

    private static async Task<int> InsertCredentialAsync(SqlSugarClient db, int accountId, string credentialId)
        => await db.Insertable(new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = credentialId,
            PublicKey = "public-key",
            SignCount = 0,
            AaGuid = Guid.Empty.ToString()
        }).ExecuteReturnIdentityAsync();

    private static async Task<string?> LoadPasskeyRowVersionForTestAsync(SqlSugarClient db, int id)
    {
        using var reader = (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT xmin::text
            FROM passkey_credential
            WHERE id = @id;
            """,
            new SugarParameter[] { new("@id", id) });
        return await reader.ReadAsync() ? reader.GetString(0) : null;
    }

    private static async Task<byte[]> InvokeGetOrCreateStablePasskeyUserHandleAsync(PasskeyService service, User user)
        => await (Task<byte[]>)GetOrCreateStablePasskeyUserHandle.Invoke(service, [user, CancellationToken.None])!;

    private static async Task<bool> InvokeTryUpdatePasskeySignCountAsync(
        PasskeyService service,
        int id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount)
        => await (Task<bool>)TryUpdatePasskeySignCount.Invoke(
            service,
            [id, expectedSignCount, rowVersion, newSignCount, DateTime.UtcNow, CancellationToken.None])!;

    private static async Task<string?> InvokeLoadAdminPasskeyRowVersionAsync(AdminPrincipalService service, long id)
        => await (Task<string?>)LoadAdminPasskeyRowVersion.Invoke(service, [id, CancellationToken.None])!;

    private static async Task<bool> InvokeTryUpdateAdminPasskeySignCountAsync(
        AdminPrincipalService service,
        long id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount)
        => await (Task<bool>)TryUpdateAdminPasskeySignCount.Invoke(
            service,
            [id, expectedSignCount, rowVersion, newSignCount, DateTime.UtcNow, CancellationToken.None])!;

    private static Task<T> StartBarrierTaskAsync<T>(Barrier barrier, Func<Task<T>> action)
        => Task.Factory.StartNew(
            async () =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent passkey sign_count updates.");
                return await action();
            },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();
}
