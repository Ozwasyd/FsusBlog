using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class UserLocaleSourceEnrollmentIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 18, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task OriginalReleasedSavepointUpdateAndCompensationRollBackWithTheirOwnerGroup()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        var original = db.Ado.Transaction;
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        await db.Ado.ExecuteCommandAsync("SAVEPOINT mutation_group; SAVEPOINT update_step;");
        UserLocalePreferenceUpdateResult result = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.True(result.Success);
        await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT update_step; SAVEPOINT compensation_step;");
        Assert.True(await Service(db).CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        await db.Ado.ExecuteCommandAsync("RELEASE SAVEPOINT compensation_step;");
        Assert.Same(original, db.Ado.Transaction);
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT mutation_group; RELEASE SAVEPOINT mutation_group;");
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        db.Ado.CommitTran();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(0, await observer.Queryable<ArticleSourceObservation>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.True((await Service(observer).UpdateAsync(1, new("fixed", "ja-JP", 0))).Success);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task BorrowedUpdateAndCompensationStayInOriginalGroupAndRollbackAllReceipts()
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        var original = db.Ado.Transaction;
        UserLocalePreferenceUpdateResult result = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.True(result.Success);
        Assert.Same(original, db.Ado.Transaction);
        Assert.True(await Service(db).CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        Assert.Same(original, db.Ado.Transaction);
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(2, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        db.Ado.RollbackTran();
        Assert.Equal(0, await observer.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Equal(0, await observer.Queryable<ArticleSourceObservation>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BorrowedEnrollmentFailureEscapesToOriginalGroupOwner(bool compensate)
    {
        using SqlSugarClient db = await DatabaseAsync();
        UserLocalePreferenceUpdateResult? result = compensate
            ? await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0)) : null;
        await FailEnrollmentAsync(db);
        db.Ado.BeginTran();
        var original = db.Ado.Transaction;
        if (compensate)
            await Assert.ThrowsAnyAsync<Exception>(() => Service(db).CompensateAsync(1, result!.Value.Preference!.Value,
                result.Value.PreviousPreference!.Value, result.Value.PreviousPreferenceExisted));
        else
            await Assert.ThrowsAnyAsync<Exception>(() => Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0)));
        Assert.Same(original, db.Ado.Transaction);
        db.Ado.RollbackTran();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(compensate ? 1 : 0, await observer.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(compensate ? 1 : 0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Equal(compensate ? 1L : (long?)null, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalUpdateAndCompensation_EnrollActualReceiptsAcrossDifferentServiceInstances(bool previouslyExisted)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var service = Service(db);
        if (previouslyExisted)
            Assert.True((await service.UpdateAsync(1, new("auto", null, 0))).Success);
        long before = await ArticleSourceGenerationAuthority.ReadGenerationAsync(db) ?? 0;
        long revision = previouslyExisted ? 1 : 0;
        UserLocalePreferenceUpdateResult result = await service.UpdateAsync(1, new("fixed", "ja-JP", revision));
        Assert.True(result.Success);
        Assert.Equal(before + 1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.True(await Service(observer).CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        Assert.Equal(before + 2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(previouslyExisted ? 1 : 0, await observer.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(before + 2, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Equal(0, await observer.Queryable<ArticleSourceSequence>().CountAsync());
        Assert.Equal(0, await observer.Queryable<ArticleSourceMutation>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("""
            SELECT count(*) FROM user_locale_mutation_receipt receipt
            FULL JOIN article_source_observation observation
                ON observation.origin_kind = 'display-locale' AND observation.origin_key = receipt.receipt_id::text
            WHERE receipt.receipt_id IS NULL OR observation.origin_key IS NULL
                OR observation.article_id IS NOT NULL OR observation.source_sequence IS NOT NULL;
            """));
    }

    [Fact]
    public async Task OriginalUpdate_EnrollmentFailureRollsBackPreferenceReceiptAndClock_ThenFreshClientRetries()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await FailEnrollmentAsync(db);
        UserLocalePreferenceUpdateResult failed = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.Unavailable, failed.Outcome);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        await observer.Ado.ExecuteCommandAsync("DROP TRIGGER fail_locale_enrollment ON article_source_observation;");
        Assert.True((await Service(observer).UpdateAsync(1, new("fixed", "ja-JP", 0))).Success);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task OriginalCompensation_EnrollmentFailureRetainsCommittedPreferenceAndUnconsumedReceipt()
    {
        using SqlSugarClient db = await DatabaseAsync();
        UserLocalePreferenceUpdateResult result = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.True(result.Success);
        await FailEnrollmentAsync(db);
        Assert.False(await Service(db).CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(result.Preference, await Service(observer).GetAsync(1));
        Assert.Equal(1, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        await observer.Ado.ExecuteCommandAsync("DROP TRIGGER fail_locale_enrollment ON article_source_observation;");
        Assert.True(await Service(observer).CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task RepeatedSameTimestampRevisionCycles_CompensateOnlyTheActualUnconsumedReceipt()
    {
        using SqlSugarClient db = await DatabaseAsync();
        for (int cycle = 0; cycle < 2; cycle++)
        {
            UserLocalePreferenceUpdateResult result = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
            Assert.True(result.Success);
            using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
            Assert.True(await Service(observer).CompensateAsync(1, result.Preference!.Value,
                result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        }
        Assert.Equal(4, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(2, await db.Ado.GetIntAsync("""
            SELECT COUNT(DISTINCT compensates_receipt_id) FROM user_locale_mutation_receipt
            WHERE mutation_kind = 'compensation';
            """));
    }

    [Fact]
    public async Task StaleCasAndWrongCompensationFacts_DoNotMintReceiptsOrAdvanceClock()
    {
        using SqlSugarClient db = await DatabaseAsync();
        UserLocalePreferenceUpdateResult result = await Service(db).UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.True(result.Success);
        Assert.Equal(UserLocalePreferenceUpdateOutcome.RevisionConflict,
            (await Service(db).UpdateAsync(1, new("fixed", "de-DE", 0))).Outcome);
        UserLocalePreferenceDto wrong = result.Preference!.Value with
        {
            FixedLocale = "de-DE"
        };
        Assert.False(await Service(db).CompensateAsync(1, wrong,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM user_locale_mutation_receipt;"));
    }

    [Fact]
    public async Task UpdateReturnsActualPersistedTimestamp_ForReceiptBoundCompensation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var service = new UserLocalePreferenceService(db, NullLogger<UserLocalePreferenceService>.Instance,
            new FixedTime(s_now.AddTicks(7)));
        UserLocalePreferenceUpdateResult result = await service.UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.True(result.Success);
        Assert.Equal(await service.GetAsync(1), result.Preference!.Value);
        Assert.True(await service.CompensateAsync(1, result.Preference.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
    }

    [Fact]
    public async Task OriginalUpdateWaitsForFamilyBeforePreferenceRowLocks()
    {
        using SqlSugarClient blocker = await DatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(blocker.CurrentConnectionConfig.ConnectionString);
        writer.Ado.Open();
        int pid = ((NpgsqlConnection)writer.Ado.Connection).ProcessID;
        blocker.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(blocker);
        Task<UserLocalePreferenceUpdateResult> waiting = Service(writer).UpdateAsync(1, new("fixed", "ja-JP", 0));
        try
        {
            await using var monitor = new NpgsqlConnection(blocker.CurrentConnectionConfig.ConnectionString);
            await monitor.OpenAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            await using var query = new NpgsqlCommand("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = @Pid AND locktype = 'advisory' AND NOT granted);", monitor);
            query.Parameters.AddWithValue("Pid", pid);
            while (!(bool)(await query.ExecuteScalarAsync(deadline.Token))!)
                await Task.Delay(20, deadline.Token);
            query.CommandText = "SELECT count(*) FROM pg_locks WHERE pid = @Pid AND granted AND (locktype = 'advisory' OR relation = 'user_locale_preference'::regclass);";
            Assert.Equal(0L, (long)(await query.ExecuteScalarAsync(deadline.Token))!);
            blocker.Ado.RollbackTran();
            Assert.True((await waiting).Success);
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(writer));
        }
        finally
        {
            if (blocker.Ado.Transaction is not null)
                blocker.Ado.RollbackTran();
            await waiting;
        }
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserLocalePreference));
        Assert.Equal(1, await db.Insertable(new User { Status = 0 }).ExecuteReturnIdentityAsync());
        return db;
    }

    private static UserLocalePreferenceService Service(SqlSugarClient db)
        => new(db, NullLogger<UserLocalePreferenceService>.Instance, new FixedTime(s_now));

    private static Task<int> FailEnrollmentAsync(SqlSugarClient db)
        => db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_locale_source() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'actual locale enrollment failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_locale_enrollment BEFORE INSERT ON article_source_observation
                FOR EACH ROW WHEN (NEW.origin_kind = 'display-locale') EXECUTE FUNCTION fail_locale_source();
            """);

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
