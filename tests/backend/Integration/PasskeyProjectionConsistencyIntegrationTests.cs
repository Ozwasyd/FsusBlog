using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
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
        IAccountStateProjectionMutationPublisher accountStates = CreatePublisher();
        var service = new PasskeyProjectionConsistencyService(
            db,
            accountStates,
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
        await accountStates.Received(1).ProjectCommittedMutationAsync(
            missingProjectionAccount,
            Arg.Any<CancellationToken>());
        await accountStates.Received(1).ProjectCommittedMutationAsync(
            staleProjectionAccount,
            Arg.Any<CancellationToken>());
        await accountStates.DidNotReceive().ProjectCommittedMutationAsync(
            consistentAccount,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Repair_CacheInvalidationFailureRollsBackProjectionMutation()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(PasskeyCredential));
        int accountId = await InsertUserAsync(db, passkeyEnabled: false, "cache-failure");
        await InsertCredentialAsync(db, accountId, "cache-failure-credential");
        IAccountStateProjectionMutationPublisher accountStates = Substitute.For<IAccountStateProjectionMutationPublisher>();
        accountStates.ProjectCommittedMutationAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new InvalidOperationException("projection unavailable")));
        var service = new PasskeyProjectionConsistencyService(
            db,
            accountStates,
            NullLogger<PasskeyProjectionConsistencyService>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.RepairAsync());

        Assert.True((await db.Queryable<User>().SingleAsync(item => item.Id == accountId)).PasskeyEnabled);
        Assert.True((await service.CheckAsync()).IsConsistent);
    }

    private static IAccountStateProjectionMutationPublisher CreatePublisher()
    {
        IAccountStateProjectionMutationPublisher publisher = Substitute.For<IAccountStateProjectionMutationPublisher>();
        publisher.ProjectCommittedMutationAsync(Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        return publisher;
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
