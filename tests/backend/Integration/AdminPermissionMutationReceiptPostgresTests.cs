using System.Text.Json;

using Npgsql;

using SqlSugar;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Integration;

// These are actual PostgreSQL persistence controls. Live endpoint enrollment is owned separately;
// executing equivalent SQL here does not qualify unwired AdminPrincipalService endpoints.
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class AdminPermissionMutationReceiptPostgresTests(PostgresSchemaMigrationFixture postgres)
{
    [Fact]
    public async Task PrincipalAndSessionSnapshots_AreActualImmutableTransitionsWithoutCredentials()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("""
            UPDATE admin_principal SET status = 'disabled', isroot = true,
                permissions = 'audit.read', validationversion = validationversion + 1 WHERE id = 1;
            """));
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("""
            UPDATE admin_session SET revokedatutc = @Now, idleexpiresatutc = @Idle,
                absoluteexpiresatutc = @Absolute, validationversion = validationversion + 1 WHERE sessionid = 'a';
            """, new SugarParameter("@Now", Now), new SugarParameter("@Idle", Now.AddMinutes(10)),
            new SugarParameter("@Absolute", Now.AddMinutes(20))));
        IReadOnlyList<AdminPermissionMutationReceipt> receipts = await batch.CompleteAsync(2);
        Assert.Equal(receipts, await batch.CompleteAsync(2));
        Assert.All(receipts, receipt => Assert.Equal(batch.TransactionId, receipt.TransactionId));
        Assert.Equal([1, 2], receipts.Select(receipt => receipt.Ordinal));
        using JsonDocument before = JsonDocument.Parse(receipts[0].BeforeJson!);
        using JsonDocument after = JsonDocument.Parse(receipts[0].AfterJson!);
        Assert.Equal("active", before.RootElement.GetProperty("Status").GetString());
        Assert.False(before.RootElement.GetProperty("IsRoot").GetBoolean());
        Assert.Equal("article.write\naudit.read", before.RootElement.GetProperty("Permissions").GetString());
        Assert.Equal(1, before.RootElement.GetProperty("ValidationVersion").GetInt64());
        Assert.Equal("disabled", after.RootElement.GetProperty("Status").GetString());
        Assert.True(after.RootElement.GetProperty("IsRoot").GetBoolean());
        Assert.Equal("audit.read", after.RootElement.GetProperty("Permissions").GetString());
        Assert.Equal(2, after.RootElement.GetProperty("ValidationVersion").GetInt64());
        using JsonDocument sessionBefore = JsonDocument.Parse(receipts[1].BeforeJson!);
        using JsonDocument sessionAfter = JsonDocument.Parse(receipts[1].AfterJson!);
        Assert.Equal("a", sessionAfter.RootElement.GetProperty("SessionId").GetString());
        Assert.Equal(1, sessionAfter.RootElement.GetProperty("PrincipalId").GetInt64());
        Assert.Equal(JsonValueKind.Null, sessionBefore.RootElement.GetProperty("RevokedAtUtc").ValueKind);
        Assert.Equal(Now, sessionAfter.RootElement.GetProperty("RevokedAtUtc").GetDateTime().ToUniversalTime());
        Assert.Equal(Now.AddMinutes(10), sessionAfter.RootElement.GetProperty("IdleExpiresAtUtc").GetDateTime().ToUniversalTime());
        Assert.Equal(Now.AddMinutes(20), sessionAfter.RootElement.GetProperty("AbsoluteExpiresAtUtc").GetDateTime().ToUniversalTime());
        Assert.Equal(2, sessionAfter.RootElement.GetProperty("ValidationVersion").GetInt64());
        Assert.Equal(5, after.RootElement.EnumerateObject().Count());
        Assert.Equal(7, sessionAfter.RootElement.EnumerateObject().Count());
        Assert.DoesNotContain("fixture-token-hash", string.Join("", receipts));
        await db.Ado.CommitTranAsync();
        string immutable = await db.Ado.GetStringAsync("""
            SELECT after_state::text FROM public.admin_permission_mutation_receipt
            WHERE subject_kind = 'principal';
            """);

        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch next = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions = '' WHERE id = 1;");
        await next.CompleteAsync(1);
        await db.Ado.CommitTranAsync();
        Assert.Equal(immutable, await db.Ado.GetStringAsync("""
            SELECT after_state::text FROM public.admin_permission_mutation_receipt
            WHERE subject_kind = 'principal' AND ordinal = 1 ORDER BY transaction_id LIMIT 1;
            """));
    }

    [Fact]
    public async Task RollbackAndRetry_OnlyCommittedAttemptHasReceipts()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch failed = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(1, await RevokeAsync(db, "a"));
        IReadOnlyList<AdminPermissionMutationReceipt> provisional = await failed.CompleteAsync(1);
        Assert.Single(provisional);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT validationversion FROM admin_session WHERE sessionid = 'a';"));

        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch retry = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.NotEqual(failed.TransactionId, retry.TransactionId);
        Assert.Equal(1, await RevokeAsync(db, "a"));
        Assert.Single(await retry.CompleteAsync(1));
        await db.Ado.CommitTranAsync();
        Assert.Equal(1, await CountAsync(db));

        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch noOp = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(0, await RevokeAsync(db, "a"));
        Assert.Empty(await noOp.CompleteAsync(0));
        await db.Ado.CommitTranAsync();
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task FailedCasAndMetadataOrIdenticalUpdates_EmitNoTransition()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(0, await db.Ado.ExecuteCommandAsync("""
            UPDATE admin_session SET revokedatutc = @Now, validationversion = validationversion + 1
            WHERE sessionid = 'a' AND xmin::text = '0';
            """, new SugarParameter("@Now", Now)));
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("UPDATE admin_session SET validationversion = validationversion WHERE sessionid = 'a';"));
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET lastloginatutc = @Now WHERE id = 1;",
            new SugarParameter("@Now", Now)));
        Assert.Empty(await batch.CompleteAsync(0));
        await db.Ado.CommitTranAsync();
        Assert.Equal(0, await CountAsync(db));
    }

    [Fact]
    public async Task RevokeOthers_BatchContainsEveryActualReturningRow()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        var changed = await db.Ado.SqlQueryAsync<string>("""
            UPDATE admin_session SET revokedatutc = @Now, validationversion = validationversion + 1
            WHERE adminprincipalid = 1 AND sessionid <> 'a' AND revokedatutc IS NULL RETURNING sessionid;
            """, new SugarParameter("@Now", Now));
        Assert.Equal(2, changed.Count);
        IReadOnlyList<AdminPermissionMutationReceipt> receipts = await batch.CompleteAsync(changed.Count);
        string[] captured = receipts.Select(receipt =>
        {
            using JsonDocument state = JsonDocument.Parse(receipt.AfterJson!);
            return state.RootElement.GetProperty("SessionId").GetString()!;
        }).Order().ToArray();
        Assert.Equal(changed.Order(), captured);
        await db.Ado.CommitTranAsync();
        Assert.Equal(2, await CountAsync(db));
    }

    [Fact]
    public async Task PartialBatch_AbortsAllActualChanges()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(1, await RevokeAsync(db, "a"));
        Assert.Equal(1, await RevokeAsync(db, "b"));
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => batch.CompleteAsync(1));
        Assert.Equal("admin_receipt_partial_batch", error.MessageText);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(3, await db.Ado.GetIntAsync("SELECT count(*) FROM admin_session WHERE revokedatutc IS NULL;"));
    }

    [Fact]
    public async Task MissingProducer_RejectsCommitAndRollsBackMutation()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        Assert.Equal(1, await RevokeAsync(db, "a"));
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.CommitTranAsync());
        Assert.Equal("admin_receipt_unsealed_batch", error.MessageText);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(0, await CountAsync(db));
        Assert.Equal(3, await db.Ado.GetIntAsync("SELECT count(*) FROM admin_session WHERE revokedatutc IS NULL;"));
    }

    [Fact]
    public async Task MutationAfterSeal_RejectsCommitOfPartialBatch()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(1, await RevokeAsync(db, "a"));
        await batch.CompleteAsync(1);
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => RevokeAsync(db, "b"));
        Assert.Equal("admin_receipt_mutation_after_seal", error.MessageText);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(0, await CountAsync(db));
    }

    [Fact]
    public async Task WrongOrMissingTransaction_CannotReuseBinding()
    {
        using SqlSugarClient db = await CreateAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => AdminPermissionMutationReceiptPersistence.BeginAsync(db));
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        await db.Ado.RollbackTranAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => batch.CompleteAsync(0));
        await db.Ado.BeginTranAsync();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => batch.CompleteAsync(0));
        Assert.Equal("admin_receipt_wrong_transaction", error.Message);
        await db.Ado.RollbackTranAsync();
    }

    [Fact]
    public async Task BeginAfterMutation_IsRejected()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        await RevokeAsync(db, "a");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => AdminPermissionMutationReceiptPersistence.BeginAsync(db));
        Assert.Equal("admin_receipt_begin_after_mutation", error.Message);
        await db.Ado.RollbackTranAsync();
    }

    [Fact]
    public async Task IssuanceRotationRevocationDeletion_PreserveEveryIntermediateState()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        var session = Session("issued");
        await db.Insertable(session).ExecuteCommandAsync();
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("""
            UPDATE admin_session SET accesstokenhash = 'changed-private-hash', validationversion = validationversion + 1
            WHERE sessionid = 'issued' AND validationversion = 1 AND revokedatutc IS NULL;
            """));
        Assert.Equal(1, await RevokeAsync(db, "issued"));
        Assert.Equal(1, await db.Ado.ExecuteCommandAsync("DELETE FROM admin_session WHERE sessionid = 'issued';"));
        IReadOnlyList<AdminPermissionMutationReceipt> receipts = await batch.CompleteAsync(4);
        Assert.Equal(["INSERT", "UPDATE", "UPDATE", "DELETE"], receipts.Select(receipt => receipt.MutationKind));
        Assert.Null(receipts[0].BeforeJson);
        Assert.Null(receipts[3].AfterJson);
        Assert.True(receipts[1].CredentialChanged);
        Assert.False(receipts[2].CredentialChanged);
        Assert.Equal(receipts[0].AfterJson, receipts[1].BeforeJson);
        Assert.Equal(receipts[1].AfterJson, receipts[2].BeforeJson);
        Assert.Equal(receipts[2].AfterJson, receipts[3].BeforeJson);
        Assert.DoesNotContain("changed-private-hash", string.Join("", receipts));
        await db.Ado.CommitTranAsync();
        Assert.Equal(4, await CountAsync(db));
    }

    [Fact]
    public async Task SavepointRollback_RemovesTransitionsBeforeRetry()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        await db.Ado.ExecuteCommandAsync("SAVEPOINT mutation_attempt;");
        await RevokeAsync(db, "a");
        await db.Ado.ExecuteCommandAsync("ROLLBACK TO SAVEPOINT mutation_attempt;");
        await RevokeAsync(db, "b");
        AdminPermissionMutationReceipt receipt = Assert.Single(await batch.CompleteAsync(1));
        Assert.Equal(1, receipt.Ordinal);
        using JsonDocument state = JsonDocument.Parse(receipt.AfterJson!);
        Assert.Equal("b", state.RootElement.GetProperty("SessionId").GetString());
        await db.Ado.CommitTranAsync();
        Assert.Equal(1, await CountAsync(db));
    }

    [Fact]
    public async Task TimePassingAndReadOnlyCleanupRetry_DoNotInventAuthorityMutation()
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        Assert.Equal(0, await db.Queryable<AdminSession>().Where(session => session.IdleExpiresAtUtc > Now.AddDays(2)).CountAsync());
        Assert.Empty(await batch.CompleteAsync(0));
        await db.Ado.CommitTranAsync();
        Assert.Equal(0, await CountAsync(db));
    }

    [Theory]
    [InlineData("UPDATE public.admin_permission_mutation_receipt SET after_state = '{}'::jsonb;", "admin_receipt_immutable")]
    [InlineData("DELETE FROM public.admin_permission_mutation_receipt;", "admin_receipt_immutable")]
    [InlineData("TRUNCATE public.admin_permission_mutation_receipt;", "admin_receipt_immutable")]
    [InlineData("UPDATE public.admin_permission_mutation_receipt_batch SET transition_count = 0;", "admin_receipt_immutable")]
    [InlineData("DELETE FROM public.admin_permission_mutation_receipt_batch;", "admin_receipt_immutable")]
    [InlineData("TRUNCATE public.admin_permission_mutation_receipt_batch;", "admin_receipt_immutable")]
    [InlineData("TRUNCATE public.admin_session;", "admin_receipt_immutable")]
    [InlineData("TRUNCATE public.admin_principal;", "admin_receipt_immutable")]
    [InlineData("INSERT INTO public.admin_permission_mutation_receipt VALUES (pg_current_xact_id(), 1, 'principal', 'INSERT', NULL, '{}', false);", "admin_receipt_database_capture_required")]
    [InlineData("INSERT INTO public.admin_permission_mutation_receipt_batch SELECT transaction_id, transition_count FROM public.admin_permission_mutation_receipt_batch LIMIT 1;", "admin_receipt_partial_batch")]
    public async Task PersistedReceipts_RejectMutationForgeryAndWrongTransaction(string sql, string expectedError)
    {
        using SqlSugarClient db = await CreateAsync();
        await db.Ado.BeginTranAsync();
        AdminPermissionMutationReceiptBatch batch = await AdminPermissionMutationReceiptPersistence.BeginAsync(db);
        await RevokeAsync(db, "a");
        await batch.CompleteAsync(1);
        await db.Ado.CommitTranAsync();
        await db.Ado.BeginTranAsync();
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => db.Ado.ExecuteCommandAsync(sql));
        Assert.Equal(expectedError, error.MessageText);
        await db.Ado.RollbackTranAsync();
        Assert.Equal(1, await CountAsync(db));
    }

    private static DateTime Now => TestTemporalContext.CreateCanonical().BusinessEpochUtc.UtcDateTime;

    private async Task<SqlSugarClient> CreateAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(postgres);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
        await db.Insertable(new AdminPrincipal
        {
            Id = 1,
            Handle = "receipt-fixture",
            Permissions = "article.write\naudit.read",
            ValidationVersion = 1,
            Status = AdminPrincipalStatus.Active,
            CreatedAtUtc = Now
        }).ExecuteCommandAsync();
        await db.Insertable(new[] { Session("a"), Session("b"), Session("c") }).ExecuteCommandAsync();
        // Replay the descriptor too: registration remains outside this task's exclusive files.
        for (int attempt = 0; attempt < 2; attempt++)
        {
            foreach (SchemaMigrationStep step in AdminPermissionMutationReceiptMigrationDefinitions.BuildMigration().Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
        return db;
    }

    private static AdminSession Session(string id) => new()
    {
        SessionId = id,
        AdminPrincipalId = 1,
        AccessTokenHash = "fixture-token-hash",
        ValidationVersion = 1,
        CreatedAtUtc = Now,
        LastSeenAtUtc = Now,
        IdleExpiresAtUtc = Now.AddHours(8),
        AbsoluteExpiresAtUtc = Now.AddHours(12)
    };

    private static Task<int> CountAsync(SqlSugarClient db)
        => db.Ado.GetIntAsync("SELECT count(*) FROM public.admin_permission_mutation_receipt;");

    private static Task<int> RevokeAsync(SqlSugarClient db, string id)
        => db.Ado.ExecuteCommandAsync("""
            UPDATE admin_session SET revokedatutc = @Now, validationversion = validationversion + 1
            WHERE sessionid = @Id AND revokedatutc IS NULL;
            """, new SugarParameter("@Now", Now), new SugarParameter("@Id", id));
}
