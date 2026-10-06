using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuditDurableReplayIssue2040IntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "audit-durable-issue2040-integration-tamper-key-0123456789";

    [Fact]
    public async Task CommittedBeforeAcknowledgementLoss_RestartReplaysOnceWithExactChainAndCiphertext()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AuditDurableTestOwner();
        await owner.Journal.WriteBatchAsync(
            [AuditDurableAdmissionIssue2040Tests.Record("first"), AuditDurableAdmissionIssue2040Tests.Record("second")],
            new IOException("fixture"), CancellationToken.None);
        var store = Store(db, owner);
        var identities = new List<string>();
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync(async (records, token) =>
        {
            identities.AddRange(records.Select(static record => record.DurableDeliveryId!));
            await store.WriteBatchAsync(records, token);
            throw new IOException("fixture acknowledgement lost after real SQL commit");
        }, CancellationToken.None));
        Assert.Equal(2, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(2, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(0, owner.Channel.Snapshot().CommittedCount);

        using SqlSugarClient restartedDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var restarted = new AuditDurableTestOwner(owner.Root, deleteRoot: false);
        var restartedStore = Store(restartedDb, restarted);
        var replayedIdentities = new List<string>();
        await restarted.Journal.ReplayAsync(async (records, token) =>
        {
            replayedIdentities.AddRange(records.Select(static record => record.DurableDeliveryId!));
            await restartedStore.WriteBatchAsync(records, token);
        }, CancellationToken.None);
        Assert.Equal(identities, replayedIdentities);
        AuditLog[] rows = (await db.Queryable<AuditLog>().OrderBy(row => row.Id).ToListAsync()).ToArray();
        Assert.Equal(2, rows.Length);
        Assert.Null(rows[0].PrevHash);
        Assert.Equal(rows[0].RecordHash, rows[1].PrevHash);
        byte[] key = Encoding.UTF8.GetBytes(TamperKey);
        Assert.All(rows, row => Assert.True(AuditTamperEvidence.Verify(row, key)));
        Assert.Equal(identities, rows.Select(row => AuditDurableDelivery.Identity(row.ContextPayload!)).ToList());
        Assert.Equal(0, restarted.Channel.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task ConcurrentDuplicateScopes_CommitOneRowWithoutMaskingAnUncommittedDelivery()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("concurrent")));
        AuditRecord? delivery = null;
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync((records, _) =>
        {
            delivery = Assert.Single(records);
            throw new IOException("fixture before commit");
        }, CancellationToken.None));
        Assert.Equal(0, await db.Queryable<AuditLog>().CountAsync());
        using SqlSugarClient otherDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await Task.WhenAll(
            Store(db, owner).WriteBatchAsync([delivery!], CancellationToken.None),
            Store(otherDb, owner).WriteBatchAsync([delivery!], CancellationToken.None));
        Assert.Equal(1, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount); // SQL commit is not journal ACK.
        await owner.Journal.ReplayAsync(Store(db, owner).WriteBatchAsync, CancellationToken.None);
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
        Assert.Equal(1, await db.Queryable<AuditLog>().CountAsync());
    }

    [Fact]
    public async Task ExistingCiphertextWithMutatedDatabaseRow_IsNotAcceptedAsACommitReceipt()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("mutation")));
        var store = Store(db, owner);
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync(async (records, token) =>
        {
            await store.WriteBatchAsync(records, token);
            throw new IOException("fixture acknowledgement lost");
        }, CancellationToken.None));
        await db.Ado.ExecuteCommandAsync("UPDATE sys_audit_log SET event_info = 'fixture-tampered';");
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Journal.ReplayAsync(store.WriteBatchAsync, CancellationToken.None));
        Assert.Equal(1, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
    }

    [Fact]
    public async Task SameDeliveryWithDifferentClassification_FailsClosedWithoutAddingASideEffect()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("classification")));
        var store = Store(db, owner);
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync(async (records, token) =>
        {
            await store.WriteBatchAsync(records, token);
            throw new IOException("fixture acknowledgement lost");
        }, CancellationToken.None));
        await Assert.ThrowsAsync<InvalidDataException>(() => owner.Journal.ReplayAsync(
            (records, token) => store.WriteBatchAsync(records.Select(record => record with { Source = "changed-source" }).ToArray(), token),
            CancellationToken.None));
        Assert.Equal(1, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        Assert.Equal(1, owner.Channel.Snapshot().TerminalFailureCount);
    }

    [Fact]
    public async Task WriterCancelledDuringRealAdvisoryLockWait_RollsBackAndKeepsDurablePending()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using var owner = new AuditDurableTestOwner();
        Assert.True(owner.Channel.TryWrite(AuditDurableAdmissionIssue2040Tests.Record("cancelled-sql")));
        AuditRecord? delivery = null;
        await Assert.ThrowsAsync<IOException>(() => owner.Journal.ReplayAsync((records, _) =>
        {
            delivery = Assert.Single(records);
            throw new IOException("fixture before commit");
        }, CancellationToken.None));
        using SqlSugarClient blocker = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        await blocker.Ado.BeginTranAsync();
        await blocker.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2361));",
            new SugarParameter("@Identity", $"audit-delivery:{delivery!.DurableDeliveryId}"));
        // PostgreSQL caches activity observations inside a transaction. Keep the
        // observer outside the transaction holding the delivery fence.
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var cancellation = new CancellationTokenSource();
        Task replay = owner.Journal.ReplayAsync(Store(db, owner).WriteBatchAsync, cancellation.Token);
        try
        {
            var watch = Stopwatch.StartNew();
            bool blocked = false;
            while (watch.Elapsed < TimeSpan.FromSeconds(5))
            {
                blocked = await observer.Ado.GetIntAsync("""
                    SELECT COUNT(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                      AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%';
                    """) > 0;
                if (blocked)
                {
                    break;
                }
                await Task.Delay(25);
            }
            Assert.True(blocked, "The reproduction must reach a real PostgreSQL lock wait before cancellation.");
            Assert.Equal(1, owner.Channel.Snapshot().InFlightCount);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => replay.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(0, await blocker.Queryable<AuditLog>().CountAsync());
            Assert.Equal(0, owner.Channel.Snapshot().InFlightCount);
            Assert.Equal(1, owner.Channel.Snapshot().DurablePendingCount);
        }
        finally
        {
            cancellation.Cancel();
            await blocker.Ado.RollbackTranAsync();
            try
            {
                await replay.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (OperationCanceledException)
            {
            }
        }
        await owner.Journal.ReplayAsync(Store(db, owner).WriteBatchAsync, CancellationToken.None);
        Assert.Equal(1, await db.Queryable<AuditLog>().CountAsync());
        Assert.Equal(0, owner.Channel.Snapshot().OutstandingCount);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AuditLog));
        return db;
    }

    private static AuditLogStore Store(SqlSugarClient db, AuditDurableTestOwner owner)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Audit:TamperEvidenceKey"] = TamperKey }).Build();
        return new AuditLogStore(db, configuration, owner.Protector);
    }
}
