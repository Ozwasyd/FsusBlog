using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Trait("Category", "SecurityStateMachine")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class PasskeyProjectionConsistencyIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CheckAndRepair_RebuildProjectionFromCredentialFactsAndInvalidateSnapshots()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int missingProjectionAccount = await InsertUserAsync(db, passkeyEnabled: false, "missing-projection");
        int staleProjectionAccount = await InsertUserAsync(db, passkeyEnabled: true, "stale-projection");
        int consistentAccount = await InsertUserAsync(db, passkeyEnabled: true, "consistent-projection");
        await InsertCredentialAsync(db, missingProjectionAccount, "missing-projection-credential");
        await InsertCredentialAsync(db, consistentAccount, "consistent-projection-credential");
        IUnifiedCache cache = CreateCache();
        var service = new PasskeyProjectionConsistencyService(
            db,
            cache,
            NullLogger<PasskeyProjectionConsistencyService>.Instance);

        PasskeyProjectionConsistencyReport before = await service.CheckAsync();
        InvalidOperationException gateFailure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.EnsureAsync());
        PasskeyProjectionConsistencyReport repaired = await service.RepairAsync();
        PasskeyProjectionConsistencyReport after = await service.CheckAsync();

        Assert.Equal(2, before.DriftedAccounts);
        Assert.Equal("passkey_projection_inconsistent:2", gateFailure.Message);
        Assert.Equal(2, repaired.DriftedAccounts);
        Assert.Equal(2, repaired.RepairedAccounts);
        Assert.True(repaired.IsConsistent);
        Assert.True(after.IsConsistent);
        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == missingProjectionAccount)).PasskeyEnabled);
        Assert.False((await db.Queryable<User>().SingleAsync(item => item.Id == staleProjectionAccount)).PasskeyEnabled);
        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == consistentAccount)).PasskeyEnabled);
        await cache.Received(1).IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            missingProjectionAccount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            1,
            Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            staleProjectionAccount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            1,
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            consistentAccount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            1,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Repair_CacheInvalidationFailureRollsBackProjectionMutation()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertUserAsync(db, passkeyEnabled: false, "cache-failure");
        await InsertCredentialAsync(db, accountId, "cache-failure-credential");
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.AccountSnapshotVersion,
                Arg.Any<string>(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(Task.FromException<long>(new InvalidOperationException("cache unavailable")));
        var service = new PasskeyProjectionConsistencyService(
            db,
            cache,
            NullLogger<PasskeyProjectionConsistencyService>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RepairAsync());

        Assert.False((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
        Assert.False((await service.CheckAsync()).IsConsistent);
    }

    private static IUnifiedCache CreateCache()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(
                CachePolicyId.AccountSnapshotVersion,
                Arg.Any<string>(),
                1,
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));
        return cache;
    }

    private static async Task<int> InsertUserAsync(
        SqlSugarClient db,
        bool passkeyEnabled,
        string publicHandle)
        => await db.Insertable(new User
        {
            PublicHandle = publicHandle,
            IdentityKind = "anonymous_account",
            PasskeyEnabled = passkeyEnabled,
            Status = 0
        }).ExecuteReturnIdentityAsync();

    private static Task<int> InsertCredentialAsync(
        SqlSugarClient db,
        int accountId,
        string credentialId)
        => db.Insertable(new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = credentialId,
            PublicKey = "public-key",
            SignCount = 0,
            AaGuid = Guid.Empty.ToString()
        }).ExecuteCommandAsync();
}
