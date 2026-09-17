using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class CommentModerationQueueStoreTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-07-20T04:00:00Z");
    private const string FirstToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private const string SecondToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    [Fact]
    public void SqlContracts_UseStableKeysetAtomicClaimAndExactCasPreconditions()
    {
        Assert.Contains(
            "ORDER BY appeal_priority DESC, risk_score DESC, waiting_since_utc, comment_id",
            CommentModerationQueueStore.ListSql,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("OFFSET", CommentModerationQueueStore.ListSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ON CONFLICT (comment_id) DO UPDATE", CommentModerationQueueStore.ClaimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("lease_expires_at_utc <= @NowUtc", CommentModerationQueueStore.ClaimSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("claim_generation + 1", CommentModerationQueueStore.ClaimSql, StringComparison.OrdinalIgnoreCase);

        foreach (string sql in new[] { CommentModerationQueueStore.RenewSql, CommentModerationQueueStore.FinishSql })
        {
            Assert.Contains("state = 'active'", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("lease_expires_at_utc > @NowUtc", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("claim_generation = @ClaimGeneration", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("xmin::text = @RowVersion", sql, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("claim_token_hash = @ClaimTokenHash", sql, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task ConcurrentClaimAndStaleCas_AllowOneOwnerAndReturnExplicitConflicts()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        using SqlSugarClient firstDb = PostgresSqlSugarTestClient.Create(connectionString);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(firstDb, typeof(CommentModerationQueueClaim));
        SeedEligibleComments(firstDb, 101);

        var clock = new MutableTimeProvider(s_now);
        var firstStore = Store(firstDb, clock, FirstToken);
        var secondStore = Store(secondDb, clock, SecondToken);

        Task<CommentModerationClaimCommandResult> firstTask = firstStore.ClaimAsync(
            101,
            11,
            TimeSpan.FromMinutes(2),
            TimeSpan.FromMinutes(30));
        Task<CommentModerationClaimCommandResult> secondTask = secondStore.ClaimAsync(
            101,
            12,
            TimeSpan.FromMinutes(2),
            TimeSpan.FromMinutes(30));
        CommentModerationClaimCommandResult[] results = await Task.WhenAll(firstTask, secondTask);

        CommentModerationClaimCommandResult winner = Assert.Single(results, static result => result.Success);
        CommentModerationClaimCommandResult loser = Assert.Single(results, static result => !result.Success);
        Assert.Equal("comment_moderation_claim_conflict", loser.Code);
        Assert.NotNull(winner.Claim!.RowVersion);
        Assert.NotNull(winner.CommentRowVersion);
        Assert.NotEqual(winner.ClaimToken, winner.Claim.ClaimTokenHash);

        CommentModerationQueueStore winnerStore = winner.Claim.OwnerAdminPrincipalId == 11 ? firstStore : secondStore;
        string winnerToken = winner.ClaimToken!;
        string firstRowVersion = winner.Claim.RowVersion!;
        clock.Advance(TimeSpan.FromSeconds(30));
        CommentModerationClaimCommandResult renewed = await winnerStore.RenewAsync(
            101,
            winner.Claim.OwnerAdminPrincipalId,
            winnerToken,
            winner.Claim.ClaimGeneration,
            firstRowVersion,
            TimeSpan.FromMinutes(3));
        Assert.True(renewed.Success);
        Assert.NotEqual(firstRowVersion, renewed.Claim!.RowVersion);

        CommentModerationClaimCommandResult staleRetry = await winnerStore.RenewAsync(
            101,
            winner.Claim.OwnerAdminPrincipalId,
            winnerToken,
            winner.Claim.ClaimGeneration,
            firstRowVersion,
            TimeSpan.FromMinutes(3));
        Assert.False(staleRetry.Success);
        Assert.Equal("comment_moderation_claim_conflict", staleRetry.Code);

        CommentModerationClaimCommandResult released = await winnerStore.ReleaseAsync(
            101,
            winner.Claim.OwnerAdminPrincipalId,
            winnerToken,
            renewed.Claim.ClaimGeneration,
            renewed.Claim.RowVersion!);
        Assert.True(released.Success);
        Assert.Equal(CommentModerationClaimStates.Released, released.Claim!.State);

        CommentModerationQueueStore takeoverStore = winner.Claim.OwnerAdminPrincipalId == 11 ? secondStore : firstStore;
        CommentModerationClaimCommandResult takeover = await takeoverStore.ClaimAsync(
            101,
            winner.Claim.OwnerAdminPrincipalId == 11 ? 12 : 11,
            TimeSpan.FromMinutes(2),
            TimeSpan.FromMinutes(30));
        Assert.True(takeover.Success);
        Assert.Equal(2, takeover.Claim!.ClaimGeneration);
    }

    [Fact]
    public async Task ExactLeaseBoundary_ExpiresBeforeRecoveryOrTakeover()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(CommentModerationQueueClaim));
        SeedEligibleComments(db, 201);
        var clock = new MutableTimeProvider(s_now);
        CommentModerationQueueStore firstStore = Store(db, clock, FirstToken);

        CommentModerationClaimCommandResult first = await firstStore.ClaimAsync(
            201,
            21,
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(30));
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1, await firstStore.RecoverExpiredAsync());

        CommentModerationQueueStore secondStore = Store(db, clock, SecondToken);
        CommentModerationClaimCommandResult takeover = await secondStore.ClaimAsync(
            201,
            22,
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(30));
        Assert.True(takeover.Success);
        Assert.Equal(2, takeover.Claim!.ClaimGeneration);
    }

    [Fact]
    public async Task KeysetList_MergesBoundedPriorityTiersWithoutDuplicatesOrFalseFinalCursor()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(CommentModerationQueueClaim));
        SeedEligibleComments(db, 301, 302, 303, 304, 305);
        db.Ado.ExecuteCommand(
            """
            INSERT INTO comment_report(id, comment_id, status, risk_score, created_at_utc)
            VALUES (1, 303, 'open', 900, @CreatedAtUtc);
            INSERT INTO comment_author_appeal(id, comment_id, status, created_at_utc)
            VALUES (1, 305, 'pending', @CreatedAtUtc);
            """,
            new SugarParameter("@CreatedAtUtc", s_now.AddHours(-1).UtcDateTime));

        CommentModerationQueueStore store = Store(db, new MutableTimeProvider(s_now), FirstToken);
        CommentModerationQueueStorePage first = await store.ListAsync(null, 2);
        CommentModerationQueueStorePage second = await store.ListAsync(first.NextCursor, 2);
        CommentModerationQueueStorePage third = await store.ListAsync(second.NextCursor, 2);

        Assert.Equal([305L, 303L], first.Items.Select(static item => item.CommentId));
        Assert.Equal([301L, 302L], second.Items.Select(static item => item.CommentId));
        Assert.Equal([304L], third.Items.Select(static item => item.CommentId));
        Assert.NotNull(first.NextCursor);
        Assert.NotNull(second.NextCursor);
        Assert.Null(third.NextCursor);
        Assert.Equal(5, first.Items.Concat(second.Items).Concat(third.Items).Select(static item => item.CommentId).Distinct().Count());
    }

    private static CommentModerationQueueStore Store(
        ISqlSugarClient db,
        TimeProvider timeProvider,
        string token)
        => new(db, new CommentModerationQueueService(timeProvider, () => token), timeProvider);

    private static void SeedEligibleComments(ISqlSugarClient db, params long[] commentIds)
    {
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS comment (
                id bigint PRIMARY KEY,
                is_deleted boolean NOT NULL,
                moderation_status integer NOT NULL,
                moderation_reason varchar(256) NULL,
                create_time timestamp without time zone NOT NULL);
            CREATE TABLE IF NOT EXISTS comment_report (
                id bigint PRIMARY KEY,
                comment_id bigint NOT NULL,
                status varchar(16) NOT NULL,
                risk_score integer NOT NULL DEFAULT 0,
                created_at_utc timestamp without time zone NOT NULL);
            CREATE TABLE IF NOT EXISTS comment_author_appeal (
                id bigint PRIMARY KEY,
                comment_id bigint NOT NULL,
                status varchar(16) NOT NULL,
                created_at_utc timestamp without time zone NOT NULL);
            """);
        foreach (long commentId in commentIds)
        {
            db.Ado.ExecuteCommand(
                """
                INSERT INTO comment(id, is_deleted, moderation_status, moderation_reason, create_time)
                VALUES (@CommentId, false, 0, NULL, @CreateTime)
                ON CONFLICT (id) DO UPDATE SET is_deleted = false, moderation_status = 0;
                """,
                new SugarParameter("@CommentId", commentId),
                new SugarParameter("@CreateTime", s_now.UtcDateTime));
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan value) => _now = _now.Add(value);
    }
}
