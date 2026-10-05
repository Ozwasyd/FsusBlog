using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class BlacklistServiceMutationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string SubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task BanUserAsync_PersistsNormalizedReasonAndPublishesCommittedVersion()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int userId = SeedUser(db, status: 0, reason: null, generation: 7);
        var accountStates = Substitute.For<IAccountStateProjectionMutationPublisher>();
        var (projection, obligations) = TestBanStateProjectionRuntime.Create(db);
        var service = new BlacklistService(db, accountStates, projection, obligations);

        await service.BanUserAsync(userId, "  spam  ");

        User stored = await db.Queryable<User>().InSingleAsync(userId);
        Assert.Equal(1, stored.Status);
        Assert.Equal("spam", stored.BanReason);
        Assert.Equal(8, stored.BanStateGeneration);
        BanStateProjectionLookup cached = projection.Read(SubjectHash);
        Assert.Equal(BanStateProjectionStatus.Banned, cached.Status);
        Assert.Equal(BanStateProjectionFacts.ManualReasonCode, cached.ReasonCode);
        Assert.Equal(stored.BanStateGeneration, cached.Generation);
        await accountStates.Received(1).ProjectCommittedMutationAsync(userId, Arg.Any<CancellationToken>());

        int reads = 0;
        db.Aop.OnLogExecuting = (_, _) => reads++;
        var snapshot = await service.GetBanStateAsync(userId, SubjectHash);
        Assert.True(snapshot.IsBanned);
        Assert.Equal(BanStateProjectionFacts.ManualReasonCode, snapshot.ReasonCode);
        Assert.Equal(0, reads);
    }

    [Fact]
    public async Task UnbanUserAsync_PreservesVersionedNormalProjectionAgainstStaleBan()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        int userId = SeedUser(db, status: 1, reason: "spam", generation: 7);
        var accountStates = Substitute.For<IAccountStateProjectionMutationPublisher>();
        var (projection, obligations) = TestBanStateProjectionRuntime.Create(db);
        var oldBan = new BanStateProjectionUpdate(
            SubjectHash, BanStateProjectionStatus.Banned, BanStateProjectionFacts.ManualReasonCode, 7);
        Assert.Equal(BanStateProjectionApplyResult.Applied, projection.Apply(oldBan));
        var service = new BlacklistService(db, accountStates, projection, obligations);

        await service.UnbanUserAsync(userId);

        User stored = await db.Queryable<User>().InSingleAsync(userId);
        Assert.Equal(0, stored.Status);
        Assert.Null(stored.BanReason);
        Assert.Equal(8, stored.BanStateGeneration);
        BanStateProjectionLookup cached = projection.Read(SubjectHash);
        Assert.Equal(BanStateProjectionStatus.Normal, cached.Status);
        Assert.Null(cached.ReasonCode);
        Assert.Equal(stored.BanStateGeneration, cached.Generation);
        Assert.Equal(BanStateProjectionApplyResult.RejectedStale, projection.Apply(oldBan));
        Assert.Equal(cached, projection.Read(SubjectHash));
        await accountStates.Received(1).ProjectCommittedMutationAsync(userId, Arg.Any<CancellationToken>());
    }

    private static int SeedUser(SqlSugarClient db, int status, string? reason, long generation)
        => db.Insertable(new User
        {
            PublicHandle = "ban-mutation-account",
            AccountSubjectHash = SubjectHash,
            Status = status,
            BanReason = reason,
            BanStateGeneration = generation,
            CreateTime = TestTemporalContext.CanonicalBusinessEpochUtc.UtcDateTime,
            PrivacyInitializedAt = TestTemporalContext.CanonicalBusinessEpochUtc.UtcDateTime
        }).ExecuteReturnIdentity();
}
