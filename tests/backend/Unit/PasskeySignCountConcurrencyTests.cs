using System.Buffers.Binary;
using System.Buffers.Text;
using System.Reflection;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
using FsusBlog.Shared.Contracts.Governance;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Trait("Category", "Concurrency")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class PasskeySignCountConcurrencyTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly MethodInfo s_tryUpdatePasskeyAssertionMetadata = typeof(PasskeyService)
        .GetMethod("TryUpdatePasskeyAssertionMetadataAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("TryUpdatePasskeyAssertionMetadataAsync should exist.");

    private static readonly MethodInfo s_loadAdminPasskeyRowVersion = typeof(AdminPrincipalService)
        .GetMethod("LoadAdminPasskeyRowVersionAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("LoadAdminPasskeyRowVersionAsync should exist.");

    private static readonly MethodInfo s_tryUpdateAdminPasskeySignCount = typeof(AdminPrincipalService)
        .GetMethod("TryUpdateAdminPasskeySignCountAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("TryUpdateAdminPasskeySignCountAsync should exist.");

    private static readonly MethodInfo s_getOrCreateStablePasskeyUserHandle = typeof(PasskeyService)
        .GetMethod("GetOrCreateStablePasskeyUserHandleAsync", BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("GetOrCreateStablePasskeyUserHandleAsync should exist.");

    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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

    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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
            PasskeyUserHandle = Base64Url.EncodeToString(Enumerable.Repeat((byte)2, 32).ToArray()),
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
        Assert.Single(results, static result => result.SignalState is not null);
        Assert.Single(results, static result => !result.Success && result.Message == PasskeyService.CannotRemoveLastCredentialWithoutRecovery);
        int remainingCredentials = await setupDb.Queryable<PasskeyCredential>()
            .CountAsync(item => item.AccountId == accountId);
        User stored = await setupDb.Queryable<User>().SingleAsync(item => item.Id == accountId);
        Assert.Equal(1, remainingCredentials);
        Assert.True(stored.PasskeyEnabled);
        Assert.Equal(1, stored.PasskeySignalVersion);
        Assert.False(stored.RecoveryEnabled);
    }

    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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

    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
    [Fact]
    public async Task UserPasskeyAssertion_ConcurrentCasConflictReloadsWithoutCloneResponse()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient setupDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(setupDb, typeof(User), typeof(PasskeyCredential));
        int accountId = await setupDb.Insertable(new User
        {
            PublicHandle = "concurrent-passkey",
            IdentityKind = "anonymous_account",
            PasskeyEnabled = true,
            Status = 0
        }).ExecuteReturnIdentityAsync();
        string credentialId = $"concurrent-{Guid.NewGuid():N}";
        await setupDb.Insertable(new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = credentialId,
            PublicKey = Base64Url.EncodeToString(new byte[] { 1, 2, 3, 4 }),
            SignCount = 10,
            AaGuid = Guid.Empty.ToString()
        }).ExecuteCommandAsync();

        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        using var barrier = new Barrier(2);
        IUserSessionCommandService sessions = Substitute.For<IUserSessionCommandService>();
        PasskeyService firstService = CreateAssertionService(
            firstDb,
            CreateConcurrentFido(barrier, actualSignCount: 11),
            CreateAssertionCache(),
            sessions);
        PasskeyService secondService = CreateAssertionService(
            secondDb,
            CreateConcurrentFido(barrier, actualSignCount: 12),
            CreateAssertionCache(),
            sessions);

        var results = await Task.WhenAll(
                firstService.CompleteAssertionAsync(
                    CreateAssertionRequest(credentialId, actualSignCount: 11, backupEligible: false, backupState: false),
                    CancellationToken.None),
                secondService.CompleteAssertionAsync(
                    CreateAssertionRequest(credentialId, actualSignCount: 12, backupEligible: true, backupState: true),
                    CancellationToken.None))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.All(results, static result => Assert.True(result.Success));
        PasskeyCredential stored = await setupDb.Queryable<PasskeyCredential>()
            .SingleAsync(item => item.CredentialId == credentialId);
        Assert.All(results, result => Assert.Equal(stored.Id, result.CredentialRowId));
        Assert.Equal(12, stored.SignCount);
        Assert.True(stored.BackupEligible);
        Assert.True(stored.BackupState);
        await sessions.DidNotReceiveWithAnyArgs().RevokeAllSessionsAsync(default, default!, default);
    }

    [CoversBehavior("authentication-session-permission", BehaviorTestKind.Positive)]
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
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IUserSessionCommandService>(),
            Substitute.For<IMessageNotificationStreamPort>(),
            Substitute.For<IAuditEventService>(),
            NullLogger<PasskeyService>.Instance);

    private static PasskeyService CreateAssertionService(
        SqlSugarClient db,
        IFido2 fido,
        IUnifiedCache cache,
        IUserSessionCommandService sessions)
        => new(
            fido,
            db,
            cache,
            cache,
            cache,
            cache,
            cache,
            cache,
            sessions,
            Substitute.For<IMessageNotificationStreamPort>(),
            Substitute.For<IAuditEventService>(),
            NullLogger<PasskeyService>.Instance);

    private static IFido2 CreateConcurrentFido(Barrier barrier, uint actualSignCount)
    {
        IFido2 fido = Substitute.For<IFido2>();
        fido.MakeAssertionAsync(Arg.Any<MakeAssertionParams>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                Assert.True(
                    barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                    "Timed out waiting for concurrent passkey assertions.");
                return Task.FromResult(new VerifyAssertionResult
                {
                    CredentialId = [1, 2, 3],
                    SignCount = actualSignCount,
                    IsBackedUp = true
                });
            });
        return fido;
    }

    private static IUnifiedCache CreateAssertionCache()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.TryGetAsync<PasskeyLoginBeginCoreModel>(
                CachePolicyId.SecurityPasskeyAuthChallenge,
                "challenge-token",
                Arg.Any<Func<ReadOnlyMemory<byte>, (bool Success, PasskeyLoginBeginCoreModel? Value)>>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new CacheReadResult<PasskeyLoginBeginCoreModel>(
                true,
                new PasskeyLoginBeginCoreModel
                {
                    ChallengeToken = "challenge-token",
                    RpId = "localhost",
                    UserVerification = (int)UserVerificationRequirement.Required,
                    Challenge = [1, 2, 3]
                })));
        cache.RemoveAsync(
                CachePolicyId.SecurityPasskeyAuthChallenge,
                "challenge-token",
                Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        return cache;
    }

    private static PasskeyLoginCompleteCoreModel CreateAssertionRequest(
        string credentialId,
        uint actualSignCount,
        bool backupEligible = false,
        bool backupState = false)
    {
        byte[] authenticatorData = new byte[37];
        authenticatorData[32] = (byte)((backupEligible ? (byte)AuthenticatorFlags.BE : 0)
            | (backupState ? (byte)AuthenticatorFlags.BS : 0));
        BinaryPrimitives.WriteUInt32BigEndian(
            authenticatorData.AsSpan(33, sizeof(uint)),
            actualSignCount);
        return new PasskeyLoginCompleteCoreModel
        {
            ChallengeToken = "challenge-token",
            Id = credentialId,
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AuthenticatorData = authenticatorData,
            Signature = [7, 8, 9]
        };
    }

    private static AdminPrincipalService CreateAdminPrincipalService(SqlSugarClient db)
        => new(
            Substitute.For<IFido2>(),
            db,
            Substitute.For<IUnifiedCache>(),
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
        => await (Task<byte[]>)s_getOrCreateStablePasskeyUserHandle.Invoke(service, [user, CancellationToken.None])!;

    private static async Task<bool> InvokeTryUpdatePasskeySignCountAsync(
        PasskeyService service,
        int id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount)
        => await (Task<bool>)s_tryUpdatePasskeyAssertionMetadata.Invoke(
            service,
            [
                id,
                expectedSignCount,
                rowVersion,
                newSignCount,
                DateTime.UtcNow,
                new PasskeyAssertionMetadata(false, false, 1),
                CancellationToken.None
            ])!;

    private static async Task<string?> InvokeLoadAdminPasskeyRowVersionAsync(AdminPrincipalService service, long id)
        => await (Task<string?>)s_loadAdminPasskeyRowVersion.Invoke(service, [id, CancellationToken.None])!;

    private static async Task<bool> InvokeTryUpdateAdminPasskeySignCountAsync(
        AdminPrincipalService service,
        long id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount)
        => await (Task<bool>)s_tryUpdateAdminPasskeySignCount.Invoke(
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
