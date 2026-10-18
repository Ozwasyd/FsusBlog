using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Dependency", "Docker")]
[Trait("Category", "Integration")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class UserLocaleMutationReceiptPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task SuccessfulCas_RecordsActualStatesAndSameTransactionVisibility_WithoutAllocatingGeneration()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await BeginAsync(db);
        var transaction = db.Ado.Transaction;
        var connection = db.Ado.Connection;
        var before = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        Assert.Null(before.Before);
        Assert.Equal(0, await CountAsync(observer));
        int affected = await CasAsync(db, 1, 0, "fixed", "ja-JP");
        UserLocaleMutationReceipt receipt = Assert.IsType<UserLocaleMutationReceipt>(
            await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, before, affected));
        Assert.Equal("update", receipt.MutationKind);
        Assert.Equal(before.ReceiptId, receipt.ReceiptId);
        Assert.Null(receipt.Before);
        Assert.Equal(new UserLocalePreferenceReceiptState("fixed", "ja-JP", 1, Epoch()), receipt.After);
        Assert.Equal(receipt, await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, before, affected));
        Assert.Same(transaction, db.Ado.Transaction);
        Assert.Same(connection, db.Ado.Connection);
        Assert.Equal(1, await CountAsync(db));
        Assert.Equal(0, await CountAsync(observer));
        Assert.Equal(0, await observer.Queryable<UserLocalePreference>().CountAsync());
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(observer));
        Assert.Equal("ja-JP", (await observer.Queryable<UserLocalePreference>().SingleAsync()).FixedLocale);
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'article_source_%'"));

        await BeginAsync(db);
        var next = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        Assert.Equal(receipt.After, next.Before);
        affected = await CasAsync(db, 1, 1, "auto", null);
        UserLocaleMutationReceipt updated = Assert.IsType<UserLocaleMutationReceipt>(
            await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, next, affected));
        Assert.Equal(receipt.After, updated.Before);
        Assert.Equal("auto", updated.After!.Mode);
        Assert.Null(updated.After.FixedLocale);
        Assert.Equal(2, updated.After.Revision);
        db.Ado.CommitTran();
        Assert.Equal(2, await CountAsync(observer));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Compensation_RecordsActualRestorationOrDeletion_AndRetainsOriginalReceipt(bool previouslyExisted)
    {
        using SqlSugarClient db = await DatabaseAsync();
        if (previouslyExisted)
        {
            _ = await UpdateAsync(db, 1, 0, "fixed", "en-US");
        }
        long revision = previouslyExisted ? 1 : 0;
        UserLocaleMutationReceipt original = await UpdateAsync(db, 1, revision, "fixed", "ja-JP");
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1, original.ReceiptId);
        int affected = await RestoreAsync(db, original);
        UserLocaleMutationReceipt compensation = Assert.IsType<UserLocaleMutationReceipt>(
            await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, affected));
        Assert.Equal("compensation", compensation.MutationKind);
        Assert.Equal(original.ReceiptId, compensation.CompensatesReceiptId);
        Assert.Equal(original.After, compensation.Before);
        Assert.Equal(original.Before, compensation.After);
        db.Ado.CommitTran();
        Assert.Equal(previouslyExisted ? 3 : 2, await CountAsync(db));
        Assert.Equal(previouslyExisted ? 1 : 0, await db.Queryable<UserLocalePreference>().CountAsync());
        // Reusing the preference revision after compensation is a new immutable receipt.
        UserLocaleMutationReceipt retry = await UpdateAsync(db, 1, revision, "fixed", "ja-JP");
        Assert.Equal(original.After!.Revision, retry.After!.Revision);
        Assert.NotEqual(original.ReceiptId, retry.ReceiptId);
        Assert.Equal(1, await db.Ado.GetIntAsync(
            "SELECT count(*) FROM user_locale_mutation_receipt WHERE receipt_id = @Id",
            new SugarParameter("@Id", original.ReceiptId)));
    }

    [Fact]
    public async Task CasConflictAndNoChange_EmitNoReceipts_ButSameValueSuccessfulCasRetainsRevisionTransition()
    {
        using SqlSugarClient db = await DatabaseAsync();
        _ = await UpdateAsync(db, 1, 0, "auto", null);
        await BeginAsync(db);
        var conflict = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        int affected = await CasAsync(db, 1, 0, "fixed", "ja-JP");
        Assert.Equal(0, affected);
        Assert.Null(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, conflict, affected));
        var noChange = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        // A reported success without an actual transition cannot manufacture a receipt.
        Assert.Null(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, noChange, 1));
        db.Ado.CommitTran();
        Assert.Equal(1, await CountAsync(db));
        UserLocaleMutationReceipt repeated = await UpdateAsync(db, 1, 1, "auto", null);
        Assert.Equal(repeated.Before!.Mode, repeated.After!.Mode);
        Assert.Equal(2, repeated.After.Revision);
        Assert.Equal(2, await CountAsync(db));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationAndRollback_LeaveNeitherPreferenceNorReceipt_ThenFreshRetrySucceeds(bool cancel)
    {
        using SqlSugarClient db = await DatabaseAsync();
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        int affected = await CasAsync(db, 1, 0, "fixed", "en-US");
        if (cancel)
        {
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, affected, cancellation.Token));
        }
        else
        {
            Assert.NotNull(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, affected));
        }
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(0, await db.Queryable<UserLocalePreference>().CountAsync());
        await BeginAsync(db);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, affected));
        db.Ado.RollbackTran();
        UserLocaleMutationReceipt retry = await UpdateAsync(db, 1, 0, "fixed", "en-US");
        Assert.NotEqual(capture.ReceiptId, retry.ReceiptId);
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task CancellationWhilePostgresWaitsForReceiptInsert_RollsBackTheOriginalCas()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        Assert.Equal(1, await CasAsync(db, 1, 0, "fixed", "en-US"));
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using var blockerTransaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand(
            "LOCK TABLE user_locale_mutation_receipt IN ACCESS EXCLUSIVE MODE", blocker, blockerTransaction))
        {
            await command.ExecuteNonQueryAsync();
        }
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        Task<UserLocaleMutationReceipt?> pending = UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(
            db, capture, 1, cancellation.Token);
        try
        {
            await WaitForNativeLockAsync(observer, ((NpgsqlConnection)db.Ado.Connection).ProcessID);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        }
        finally
        {
            cancellation.Cancel();
            await blockerTransaction.RollbackAsync();
            db.Ado.RollbackTran();
        }
        Assert.Equal(0, await CountAsync(observer));
        Assert.Equal(0, await observer.Queryable<UserLocalePreference>().CountAsync());
        _ = await UpdateAsync(db, 1, 0, "fixed", "en-US");
        Assert.Equal(1, await CountAsync(observer));
    }

    [Fact]
    public async Task ContendingOriginalOwners_SerializeBeforeCapture_AndLosingCasEmitsNothing()
    {
        using SqlSugarClient first = await DatabaseAsync();
        using SqlSugarClient second = PostgresSqlSugarTestClient.Create(first.CurrentConnectionConfig.ConnectionString);
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(first.CurrentConnectionConfig.ConnectionString);
        await BeginAsync(first);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(first, 1);
        second.Ado.BeginTran();
        Task waiting = ArticleSourceGenerationAuthority.AcquireMutationLockAsync(second);
        try
        {
            await WaitForNativeLockAsync(observer, ((NpgsqlConnection)second.Ado.Connection).ProcessID);
            Assert.False(waiting.IsCompleted);
            int affected = await CasAsync(first, 1, 0, "fixed", "en-US");
            Assert.NotNull(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(first, capture, affected));
            first.Ado.CommitTran();
            await waiting.WaitAsync(TimeSpan.FromSeconds(10));
            var losing = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(second, 1);
            Assert.Equal(1, losing.Before!.Revision);
            Assert.Equal(0, await CasAsync(second, 1, 0, "fixed", "ja-JP"));
            Assert.Null(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(second, losing, 0));
            second.Ado.CommitTran();
        }
        finally
        {
            if (first.Ado.Transaction is not null)
            {
                first.Ado.RollbackTran();
            }
            if (second.Ado.Transaction is not null)
            {
                second.Ado.RollbackTran();
            }
        }
        Assert.Equal(1, await CountAsync(observer));
        Assert.Equal("en-US", (await observer.Queryable<UserLocalePreference>().SingleAsync()).FixedLocale);
    }

    [Fact]
    public async Task CaptureRequiresOriginalNativeTransactionAndFamilyLock_AndRejectsWrongClientAndAccount()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1));
        db.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1));
        db.Ado.RollbackTran();
        db.Ado.BeginTran(System.Data.IsolationLevel.RepeatableRead);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1));
        db.Ado.RollbackTran();
        UserLocaleMutationReceipt original = await UpdateAsync(db, 1, 0, "fixed", "en-US");
        await BeginAsync(db);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 2, original.ReceiptId));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1, Guid.NewGuid()));
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        using SqlSugarClient wrong = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        wrong.Ado.BeginTran();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(wrong, capture, 1));
        wrong.Ado.RollbackTran();
        db.Ado.RollbackTran();
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task UnrelatedAbsentRowInsert_CannotBeClaimedAsAnOriginalTransactionWrite()
    {
        using SqlSugarClient db = await DatabaseAsync();
        using SqlSugarClient bypass = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        // Deliberately bypass the family owner on another connection as a negative control.
        Assert.Equal(1, await CasAsync(bypass, 1, 0, "fixed", "en-US"));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, 1));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(1, await db.Queryable<UserLocalePreference>().CountAsync());
    }

    [Fact]
    public async Task InvalidActualTransitionAndLyingAffectedCount_RefuseWithoutReceipts()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1);
        Assert.Equal(1, await CasAsync(db, 1, 0, "auto", null));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, 0));
        await db.Ado.ExecuteCommandAsync("UPDATE user_locale_preference SET revision = 5 WHERE account_id = 1");
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, 1));
        db.Ado.RollbackTran();
        Assert.Equal(0, await CountAsync(db));
    }

    [Fact]
    public async Task CompensationConflictAndWrongRestoration_RefuseFakeCompensation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        UserLocaleMutationReceipt original = await UpdateAsync(db, 1, 0, "fixed", "en-US");
        _ = await UpdateAsync(db, 1, 1, "fixed", "ja-JP");
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, 1, original.ReceiptId);
        Assert.Equal(0, await RestoreAsync(db, original));
        Assert.Null(await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, 0));
        await db.Ado.ExecuteCommandAsync("DELETE FROM user_locale_preference WHERE account_id = 1");
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, 1));
        db.Ado.RollbackTran();
        Assert.Equal(2, await CountAsync(db));
    }

    [Theory]
    [InlineData("UPDATE user_locale_mutation_receipt SET mutation_kind = mutation_kind")]
    [InlineData("DELETE FROM user_locale_mutation_receipt")]
    [InlineData("TRUNCATE user_locale_mutation_receipt")]
    public async Task MigrationMakesReceiptsImmutable_WithoutCascadingAccountDeletion(string sql)
    {
        using SqlSugarClient db = await DatabaseAsync();
        _ = await UpdateAsync(db, 1, 0, "auto", null);
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(sql));
        Assert.Equal("55000", error.SqlState);
        await db.Deleteable<User>().Where(user => user.Id == 1).ExecuteCommandAsync();
        Assert.Equal(0, await db.Queryable<UserLocalePreference>().CountAsync());
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task OriginalService_EnlistsActualUpdateAndCompensationThroughTheSourceAuthority()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var original = new UserLocalePreferenceService(db, NullLogger<UserLocalePreferenceService>.Instance);
        var result = await original.UpdateAsync(1, new("fixed", "ja-JP", 0));
        Assert.Equal(UserLocalePreferenceUpdateOutcome.Success, result.Outcome);
        Assert.Equal(1, await CountAsync(db));
        Assert.True(await original.CompensateAsync(1, result.Preference!.Value,
            result.PreviousPreference!.Value, result.PreviousPreferenceExisted));
        Assert.Equal(2, await CountAsync(db));
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User));
        for (int account = 1; account <= 2; account++)
        {
            Assert.Equal(account, await db.Insertable(new User { Status = 0 }).ExecuteReturnIdentityAsync());
        }
        foreach (SchemaMigrationStep step in UserLocalePreferenceMigrationDefinitions.BuildMigration().Steps)
        {
            await step.ExecuteAsync(db, default);
        }
        // Execute this unregistered descriptor explicitly, including replay; no runtime DDL.
        for (int replay = 0; replay < 2; replay++)
        {
            foreach (SchemaMigrationStep step in UserLocaleMutationReceiptMigrationDefinitions.BuildMigration().Steps)
            {
                await step.ExecuteAsync(db, default);
            }
        }
        PostgresSqlSugarTestClient.InitTables(db, typeof(UserLocalePreference));
        return db;
    }

    private static async Task BeginAsync(SqlSugarClient db)
    {
        db.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
    }

    private static async Task<UserLocaleMutationReceipt> UpdateAsync(
        SqlSugarClient db, int accountId, long expectedRevision, string mode, string? locale)
    {
        await BeginAsync(db);
        var capture = await UserLocaleMutationReceiptPersistence.CaptureBeforeAsync(db, accountId);
        int affected = await CasAsync(db, accountId, expectedRevision, mode, locale);
        Assert.Equal(1, affected);
        UserLocaleMutationReceipt receipt = Assert.IsType<UserLocaleMutationReceipt>(
            await UserLocaleMutationReceiptPersistence.PersistActualAfterAsync(db, capture, affected));
        db.Ado.CommitTran();
        return receipt;
    }

    // Original service CAS SQL on the real owner client/transaction. Production endpoints
    // remain owned by the original service; this is explicit component acceptance only.
    private static Task<int> CasAsync(SqlSugarClient db, int accountId, long expectedRevision, string mode, string? locale)
        => db.Ado.ExecuteCommandAsync(expectedRevision == 0 ? """
            INSERT INTO user_locale_preference(account_id, mode, fixed_locale, revision, updated_at)
            SELECT @AccountId, @Mode, @Locale, 1, @At WHERE @Expected = 0
            ON CONFLICT (account_id) DO NOTHING;
            """ : """
            UPDATE user_locale_preference SET mode = @Mode, fixed_locale = @Locale,
                revision = @Expected + 1, updated_at = @At
            WHERE account_id = @AccountId AND revision = @Expected;
            """, new SugarParameter("@AccountId", accountId), new SugarParameter("@Expected", expectedRevision),
            new SugarParameter("@Mode", mode), new SugarParameter("@Locale", locale), new SugarParameter("@At", Epoch()));

    private static Task<int> RestoreAsync(SqlSugarClient db, UserLocaleMutationReceipt original)
        => db.Ado.ExecuteCommandAsync(original.Before is null ? """
            DELETE FROM user_locale_preference WHERE account_id = @AccountId AND revision = @Committed;
            """ : """
            UPDATE user_locale_preference SET mode = @Mode, fixed_locale = @Locale,
                revision = @Revision, updated_at = @At
            WHERE account_id = @AccountId AND revision = @Committed;
            """, new SugarParameter("@AccountId", original.AccountId),
            new SugarParameter("@Committed", original.After!.Revision),
            new SugarParameter("@Mode", original.Before?.Mode), new SugarParameter("@Locale", original.Before?.FixedLocale),
            new SugarParameter("@Revision", original.Before?.Revision), new SugarParameter("@At", original.Before?.UpdatedAt));

    private static Task<int> CountAsync(SqlSugarClient db)
        => db.Ado.GetIntAsync("SELECT count(*) FROM user_locale_mutation_receipt");

    private static async Task WaitForNativeLockAsync(SqlSugarClient observer, int processId)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await observer.Ado.GetIntAsync(
            "SELECT count(*) FROM pg_stat_activity WHERE pid = @Pid AND wait_event_type = 'Lock'",
            new SugarParameter("@Pid", processId)) == 0)
        {
            await Task.Delay(20, timeout.Token);
        }
    }

    private static DateTime Epoch() => TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;
}
