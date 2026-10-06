using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.Extensions.DependencyInjection;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ChallengeV2DurableReplayIssue2040IntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealPostgresCommit_ExactDuplicateKeepsOneIdentityFullPayloadAndCreatedTime(bool high)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("exact");
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("exact", high));
        ProtectedChallengeWitness witness = await CaptureWitnessAsync(owner, high);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        var service = new SecurityChallengePersistenceService(db);
        await service.RecordAttemptAsync(delivery!.Attempt);
        SecurityChallengeAttempt first = Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync());
        Assert.True(first.Id > 0);
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(ChallengeV2DurableDelivery.GetRequired(delivery.Attempt), first));
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery.Attempt);
        await AssertRawTimestampsAsync(db, prepared);
        AssertRawTimestamp(prepared.CreatedAtUtc, first.CreatedAtUtc);
        AssertRawTimestamp(prepared.Request.AttemptedAtUtc!.Value, first.AttemptedAtUtc);
        Assert.True(witness.Entry.Event == delivery, "challenge-witness:live-delivery-mismatch");
        await AssertPendingWitnessAsync(owner, witness);
        var sql = new List<string>();
        db.Aop.OnLogExecuting = (statement, _) => sql.Add(statement);
        SecurityChallengeAttempt duplicate = await service.RecordAttemptAsync(delivery.Attempt);
        Assert.Equal(first.Id, duplicate.Id);
        Assert.DoesNotContain(sql, statement => statement.Contains("INSERT", StringComparison.OrdinalIgnoreCase)
            || statement.Contains("UPDATE security_challenge", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        Assert.Equal(1, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
        await AssertRetainedWitnessAsync(owner, witness);

        // A committed explicit identity reuses the authenticated private clock;
        // another lane's pending event must not be swept or rescheduled by it.
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("exact", !high));
        ProtectedChallengeWitness peer = await CaptureWitnessAsync(owner, !high);
        Assert.NotEqual(witness.Entry.Reference, peer.Entry.Reference);
        Assert.NotEqual(witness.KeyPath, peer.KeyPath);
        Assert.NotEqual(witness.KeyDigest, peer.KeyDigest);
        ChallengeV2LaneSnapshot peerBefore = owner.Queue.LaneSnapshot(!high);
        var retry = ChallengeV2AuditEvent.FromAttempt(delivery.Attempt with
        {
            AttemptedAtUtc = null
        },
            delivery.EventKind, delivery.ChallengeKind, delivery.Action);
        await owner.Queue.WriteAsync(retry);
        Assert.Equal(peerBefore, owner.Queue.LaneSnapshot(!high));
        Assert.Equal(0, owner.Queue.LaneSnapshot(high).DurablePendingCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).DurableAcceptedCount);
        await AssertRetainedWitnessAsync(owner, witness);
        await AssertPendingWitnessAsync(owner, peer);
        await AssertRawTimestampsAsync(db, prepared);
        Assert.Equal(1, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
        Assert.Equal(first.Id, Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync()).Id);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        await AssertRetainedWitnessAsync(owner, witness);
        await AssertRetainedWitnessAsync(owner, peer);
        Assert.Equal(2, await db.Queryable<SecurityChallengeAttempt>().CountAsync());

        // Release the exclusive journal owner before reopening; the new raw
        // explicit-ID request has no private in-memory prepared binding.
        owner.Queue.Dispose();
        using var cold = new ChallengeV2Issue2040Owner(root: owner.Root, deleteRoot: false,
            database: () => PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString));
        await AssertRetainedWitnessAsync(cold, witness);
        await AssertRetainedWitnessAsync(cold, peer);
        ChallengeV2LaneSnapshot coldPeerBefore = cold.Queue.LaneSnapshot(!high);
        SecurityChallengeAttemptRequest rawRetry = prepared.Request with
        {
            AttemptedAtUtc = null
        };
        Assert.NotSame(delivery.Attempt, rawRetry);
        Assert.Null(ChallengeV2DurableDelivery.TryGet(rawRetry));
        Assert.Equal(prepared.Request.AttemptId, rawRetry.AttemptId);
        var coldRetry = new ChallengeV2AuditEvent(rawRetry, delivery.EventKind,
            delivery.ChallengeKind, delivery.Action, delivery.IsHighValue);
        ChallengeV2AuditEvent restoredRetry = await cold.Provider.GetRequiredService<ChallengeV2FallbackWriter>()
            .AdmitAsync(coldRetry);
        ChallengeV2PreparedAttempt restoredPrepared = ChallengeV2DurableDelivery.GetRequired(restoredRetry.Attempt);
        Assert.True(witness.Entry.Event == restoredRetry, "challenge-witness:explicit-retry-payload-changed");
        Assert.Equal(witness.Entry.CreatedAtUtc.Ticks, restoredPrepared.CreatedAtUtc.Ticks);
        Assert.Equal(witness.Entry.SuppliedAttemptedAt, restoredPrepared.SuppliedAttemptedAt);
        Assert.Equal(prepared.Request.AttemptId, restoredPrepared.Request.AttemptId);
        Assert.Equal(DateTimeKind.Utc, restoredPrepared.CreatedAtUtc.Kind);
        Assert.Equal(DateTimeKind.Utc, restoredPrepared.Request.AttemptedAtUtc!.Value.Kind);
        Assert.Equal(0L, restoredPrepared.CreatedAtUtc.Ticks % 10);
        Assert.Equal(0L, restoredPrepared.Request.AttemptedAtUtc.Value.Ticks % 10);
        await cold.Queue.WriteAsync(restoredRetry);
        Assert.False(cold.Queue.TryRead(out _));
        Assert.Equal(0, cold.Queue.Snapshot().OutstandingCount);
        Assert.Equal(coldPeerBefore, cold.Queue.LaneSnapshot(!high));
        await AssertRetainedWitnessAsync(cold, witness);
        await AssertRetainedWitnessAsync(cold, peer);
        sql.Clear();
        SecurityChallengeAttempt coldDuplicate = await service.RecordAttemptAsync(restoredRetry.Attempt);
        Assert.Equal(first.Id, coldDuplicate.Id);
        Assert.DoesNotContain(sql, statement => statement.Contains("INSERT", StringComparison.OrdinalIgnoreCase)
            || statement.Contains("UPDATE security_challenge", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(2, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
        await AssertRawTimestampsAsync(db, restoredPrepared);
        await AssertRetainedWitnessAsync(cold, witness);
        await AssertRetainedWitnessAsync(cold, peer);
    }

    [Theory]
    [InlineData("challenge")]
    [InlineData("outcome")]
    [InlineData("reason")]
    [InlineData("payload")]
    [InlineData("client")]
    [InlineData("device")]
    [InlineData("trace")]
    [InlineData("traceparent")]
    [InlineData("attempted")]
    [InlineData("created")]
    public async Task SameIdentityWithAnyAlteredNormalizedSqlFieldIsRejected(string field)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("altered");
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("altered", false));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery!.Attempt);
        var service = new SecurityChallengePersistenceService(db);
        await service.RecordAttemptAsync(delivery.Attempt);
        ChallengeV2PreparedAttempt changed = Alter(prepared, field);
        SecurityChallengeAttemptRequest request = ChallengeV2DurableDelivery.Bind(changed);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => service.RecordAttemptAsync(request));
        Assert.Equal("security_challenge_attempt_idempotency_conflict", failure.Message);
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(prepared,
            Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync())));
        await AssertRawTimestampsAsync(db, prepared);
        Assert.Equal(1, owner.Queue.Snapshot().InFlightCount);
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
    }

    [Fact]
    public async Task SqlNormalizedEquivalentDuplicateAndIndependentEqualEventsAreNotConflated()
    {
        using SqlSugarClient db = await CreateDatabaseAsync("normalized");
        using var owner = Owner(db);
        ChallengeV2AuditEvent first = ChallengeV2Issue2040Owner.Event("normalized", false);
        await owner.Queue.WriteAsync(first);
        ProtectedChallengeWitness firstWitness = await CaptureWitnessAsync(owner, false);
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery!.Attempt);
        var service = new SecurityChallengePersistenceService(db);
        await service.RecordAttemptAsync(delivery.Attempt);
        await AssertRawTimestampsAsync(db, prepared);
        ChallengeV2PreparedAttempt equivalent = SecurityChallengePersistenceService.PrepareAttempt(prepared.Request with
        {
            ChallengeId = " normalized ",
            Outcome = " FAILED ",
            Reason = " private-reason ",
            PayloadHash = " " + ChallengeV2Issue2040Owner.Hash.ToUpperInvariant() + " ",
            TraceId = " private-trace ",
            Traceparent = " private-traceparent "
        }, prepared.CreatedAtUtc);
        await service.RecordAttemptAsync(ChallengeV2DurableDelivery.Bind(equivalent));
        await AssertRawTimestampsAsync(db, prepared);
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
        await AssertRetainedWitnessAsync(owner, firstWitness);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("normalized", false));
        ProtectedChallengeWitness independentWitness = await CaptureWitnessAsync(owner, false);
        Assert.NotEqual(firstWitness.Entry.Reference, independentWitness.Entry.Reference);
        Assert.NotEqual(firstWitness.KeyPath, independentWitness.KeyPath);
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        var rows = await db.Queryable<SecurityChallengeAttempt>().OrderBy(item => item.Id).ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.NotEqual(rows[0].AttemptId, rows[1].AttemptId);
        Assert.True(rows[0].Id < rows[1].Id);
        await AssertRawTimestampsAsync(db, prepared);
        await AssertRawTimestampsAsync(db, new(independentWitness.Entry.Event.Attempt,
            independentWitness.Entry.CreatedAtUtc, independentWitness.Entry.SuppliedAttemptedAt));
        await AssertRetainedWitnessAsync(owner, firstWitness);
        await AssertRetainedWitnessAsync(owner, independentWitness);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AlteredCommittedDatabasePayloadCannotAcknowledgePendingJournal(bool high)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("row-altered");
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("row-altered", high));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery!.Attempt);
        await new SecurityChallengePersistenceService(db).RecordAttemptAsync(delivery.Attempt);
        Assert.True(owner.Queue.TryRequeue(delivery));
        await db.Ado.ExecuteCommandAsync("UPDATE security_challenge_attempt SET reason = 'forged', created_at_utc = created_at_utc + interval '1 second';");
        Assert.Equal(0, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).DurablePendingCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        Assert.Single(Directory.GetFiles(owner.Root, "*.json", SearchOption.AllDirectories));
        Assert.False(ChallengeV2DurableAdmissionIssue2040Tests.Observe(owner, high).Complete);
        await db.Ado.ExecuteCommandAsync("UPDATE security_challenge_attempt SET reason = @Reason, created_at_utc = @Created;",
            new SugarParameter("@Reason", prepared.Request.Reason), new SugarParameter("@Created", prepared.CreatedAtUtc));
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(prepared,
            Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync())));
        await AssertRawTimestampsAsync(db, prepared);
        Assert.True(ChallengeV2DurableAdmissionIssue2040Tests.Observe(owner, high).Complete);
    }

    [Fact]
    public async Task TwoRealScopesRaceOnePreparedIdentityWithoutAnotherSideEffect()
    {
        using SqlSugarClient db = await CreateDatabaseAsync("concurrent");
        using SqlSugarClient other = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("concurrent", false));
        Assert.True(owner.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
        await Task.WhenAll(new SecurityChallengePersistenceService(db).RecordAttemptAsync(delivery!.Attempt),
            new SecurityChallengePersistenceService(other).RecordAttemptAsync(delivery.Attempt));
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(ChallengeV2DurableDelivery.GetRequired(delivery.Attempt),
            Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync())));
        await AssertRawTimestampsAsync(db, ChallengeV2DurableDelivery.GetRequired(delivery.Attempt));
        Assert.Equal(1, await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Fact]
    public async Task GenuineCommitReplyLoss_UsesFreshConnectionFullProofOrRetainsPendingForRetry()
    {
        using SqlSugarClient db = await CreateDatabaseAsync("relay");
        await using var relay = new CommitReplyCutRelay(db.CurrentConnectionConfig.ConnectionString);
        using var owner = new ChallengeV2Issue2040Owner(database: () => PostgresSqlSugarTestClient.Create(relay.ConnectionString));
        ChallengeV2AuditEvent expected = ChallengeV2Issue2040Owner.Event("relay", false);
        ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(expected.Attempt);
        await owner.Queue.WriteAsync(expected);
        ProtectedChallengeWitness witness = await CaptureWitnessAsync(owner, false);
        await owner.Worker.FlushOnceAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5));
        await relay.CommitCut.WaitAsync(TimeSpan.FromSeconds(5));
        SecurityChallengeAttempt committed = Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync());
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(prepared, committed));
        await AssertRawTimestampsAsync(db, prepared);
        // The relay discards a real backend COMMIT completion, not a fixture throw.
        // An unresolved proof must remain pending; a successful fresh proof may ACK.
        if (owner.Queue.Snapshot().OutstandingCount > 0)
        {
            Assert.Equal(1, owner.Queue.Snapshot().DurablePendingCount);
            await AssertPendingWitnessAsync(owner, witness);
            Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        }
        SecurityChallengeAttempt retried = Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync());
        Assert.True(ChallengeV2DurableDelivery.MatchesStored(prepared, retried));
        Assert.Equal(committed.Id, retried.Id);
        Assert.Equal(committed.CreatedAtUtc, retried.CreatedAtUtc);
        Assert.Equal(committed.AttemptId, retried.AttemptId);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        await AssertRetainedWitnessAsync(owner, witness);
        await AssertRawTimestampsAsync(db, prepared);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WriterCancelledDuringRealChallengeRowLockWait_RollsBackPendingThenRetries(bool high)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("lock-wait");
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("lock-wait", high));
        ProtectedChallengeWitness witness = await CaptureWitnessAsync(owner, high);
        await using var blocker = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await blocker.OpenAsync();
        await using var transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT challenge_id FROM security_challenge WHERE challenge_id = 'lock-wait' FOR UPDATE;", blocker, transaction))
        {
            await command.ExecuteScalarAsync();
        }
        await using var observer = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await observer.OpenAsync();
        using var cancellation = new CancellationTokenSource();
        Task write = owner.Worker.FlushOnceAsync(cancellation.Token);
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var watch = Stopwatch.StartNew();
            bool waiting = false;
            while (watch.Elapsed < TimeSpan.FromSeconds(5) && !write.IsCompleted)
            {
                await using var observation = new NpgsqlCommand("""
                    SELECT COUNT(*) FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> @BlockerPid
                        AND wait_event_type = 'Lock' AND wait_event = 'transactionid'
                        AND pg_blocking_pids(pid) @> ARRAY[@BlockerPid]
                        AND query LIKE '%UPDATE security_challenge%';
                    """, observer);
                observation.Parameters.AddWithValue("BlockerPid", blocker.ProcessID);
                waiting = Convert.ToInt64(await observation.ExecuteScalarAsync(deadline.Token)) > 0;
                if (waiting)
                {
                    break;
                }
                await Task.Delay(25, deadline.Token);
            }
            Assert.True(waiting, "The real challenge UPDATE must be blocked before cancellation.");
            Assert.False(write.IsCompleted);
            Assert.Equal(1, owner.Queue.LaneSnapshot(high).InFlightCount);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => write.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(0, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
            Assert.Equal(0, owner.Queue.LaneSnapshot(high).InFlightCount);
            Assert.Equal(1, owner.Queue.LaneSnapshot(high).DurablePendingCount);
            Assert.Equal(1, owner.Queue.LaneSnapshot(high).RequeuedCount);
            Assert.Equal(0, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
            await AssertPendingWitnessAsync(owner, witness);
        }
        finally
        {
            cancellation.Cancel();
            await transaction.RollbackAsync();
            try
            {
                await write.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (OperationCanceledException)
            {
            }
        }
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        await AssertRawTimestampsAsync(db, new(witness.Entry.Event.Attempt,
            witness.Entry.CreatedAtUtc, witness.Entry.SuppliedAttemptedAt));
        await AssertRetainedWitnessAsync(owner, witness);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RealSqlReplayFailureRetainsLaneUntilRestoredAndDoesNotQualifyItsPeer(bool high)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("recover");
        using var owner = Owner(db);
        await owner.Queue.WriteAsync(ChallengeV2Issue2040Owner.Event("recover", high));
        ProtectedChallengeWitness witness = await CaptureWitnessAsync(owner, high);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE security_challenge_attempt RENAME TO challenge_owned_unavailable;");
        Assert.Equal(0, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).DurablePendingCount);
        Assert.Equal(1, owner.Queue.LaneSnapshot(high).TerminalFailureCount);
        Assert.False(ChallengeV2DurableAdmissionIssue2040Tests.Observe(owner, high).Complete);
        Assert.True(ChallengeV2DurableAdmissionIssue2040Tests.Observe(owner, !high).Complete);
        await AssertPendingWitnessAsync(owner, witness);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE challenge_owned_unavailable RENAME TO security_challenge_attempt;");
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, await db.Queryable<SecurityChallengeAttempt>().CountAsync());
        Assert.True(ChallengeV2DurableAdmissionIssue2040Tests.Observe(owner, high).Complete);
        await AssertRawTimestampsAsync(db, new(witness.Entry.Event.Attempt,
            witness.Entry.CreatedAtUtc, witness.Entry.SuppliedAttemptedAt));
        await AssertRetainedWitnessAsync(owner, witness);
    }

    [Theory]
    [Trait("Category", "Process")]
    [InlineData(false, "admission")]
    [InlineData(true, "admission")]
    [InlineData(false, "in-flight")]
    [InlineData(true, "in-flight")]
    [InlineData(false, "commit-before-ack")]
    [InlineData(true, "commit-before-ack")]
    public async Task RealChildKillEachDeliveryWindow_RestartCommitsOneExactEvent(bool high, string window)
    {
        using SqlSugarClient db = await CreateDatabaseAsync("process-required");
        string root = Path.Combine(ChallengeV2Issue2040Owner.TemporaryRoot, $"fsusblog-challenge-issue2040-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            long committedId = 0;
            await using (ChallengeV2OwnedProcess child = await ChallengeV2OwnedProcess.StartAsync(root, high, window,
                db.CurrentConnectionConfig.ConnectionString))
            {
                await child.ReadyAsync(window == "admission" ? "admitted" : window == "in-flight" ? "in-flight" : "committed");
                var rows = await db.Queryable<SecurityChallengeAttempt>().ToListAsync();
                if (window == "commit-before-ack")
                {
                    committedId = Assert.Single(rows).Id;
                    Assert.True(committedId > 0);
                }
                else
                {
                    Assert.Empty(rows);
                }
                Assert.Single(Directory.GetFiles(root, "*.json", SearchOption.AllDirectories));
                await child.KillAsync();
            }
            using var recovered = new ChallengeV2Issue2040Owner(root: root,
                database: () => PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString), deleteRoot: false);
            Assert.Equal(1, recovered.Queue.LaneSnapshot(high).DurablePendingCount);
            ProtectedChallengeWitness witness = await CaptureWitnessAsync(recovered, high);
            Assert.True(recovered.Queue.TryRead(out ChallengeV2AuditEvent? delivery));
            ChallengeV2PreparedAttempt prepared = ChallengeV2DurableDelivery.GetRequired(delivery!.Attempt);
            Assert.True(witness.Entry.Event == delivery, "challenge-witness:cold-delivery-mismatch");
            Assert.Equal(witness.Entry.CreatedAtUtc.Ticks, prepared.CreatedAtUtc.Ticks);
            await AssertPendingWitnessAsync(recovered, witness);
            Assert.Equal(1, await recovered.Worker.PersistSafelyAsync([delivery], CancellationToken.None));
            SecurityChallengeAttempt row = Assert.Single(await db.Queryable<SecurityChallengeAttempt>().ToListAsync());
            Assert.True(ChallengeV2DurableDelivery.MatchesStored(prepared, row));
            Assert.Equal(prepared.CreatedAtUtc, ChallengeV2DurableDelivery.SqlTimestamp(row.CreatedAtUtc));
            AssertRawTimestamp(prepared.CreatedAtUtc, row.CreatedAtUtc);
            AssertRawTimestamp(prepared.Request.AttemptedAtUtc!.Value, row.AttemptedAtUtc);
            await AssertRawTimestampsAsync(db, prepared);
            await AssertRetainedWitnessAsync(recovered, witness);
            if (committedId > 0)
            {
                Assert.Equal(committedId, row.Id);
            }
            Assert.Equal(0, recovered.Queue.Snapshot().OutstandingCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync(string challengeId)
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityChallenge), typeof(SecurityChallengeAttempt));
        await AssertTimestampSchemaAsync(db);
        await new SecurityChallengePersistenceService(db).IssueAsync(new(challengeId, "perception_micro_interaction_v2", "algorithm",
            "auth.login", "/auth/login", ChallengeV2Issue2040Owner.Hash, ChallengeV2Issue2040Owner.Hash,
            ChallengeV2Issue2040Owner.Hash, "issue2040", ChallengeV2Issue2040Owner.Hash, null, null,
            DateTime.UtcNow.AddMinutes(-1), DateTime.UtcNow.AddMinutes(5)));
        return db;
    }

    private static ChallengeV2Issue2040Owner Owner(SqlSugarClient db)
        => new(database: () => PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString));

    private static async Task AssertTimestampSchemaAsync(SqlSugarClient db)
    {
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT column_name, data_type, datetime_precision, is_nullable, current_setting('TimeZone')
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'security_challenge_attempt'
                AND column_name IN ('attempted_at_utc', 'created_at_utc')
            ORDER BY column_name;
            """, connection);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        foreach (string column in new[] { "attempted_at_utc", "created_at_utc" })
        {
            Assert.True(await reader.ReadAsync());
            Assert.Equal(column, reader.GetString(0));
            Assert.Equal("timestamp without time zone", reader.GetString(1));
            Assert.Equal(6, reader.GetInt32(2));
            Assert.Equal("NO", reader.GetString(3));
            Assert.Equal("UTC", reader.GetString(4));
        }
        Assert.False(await reader.ReadAsync());
    }

    private static async Task AssertRawTimestampsAsync(SqlSugarClient db, ChallengeV2PreparedAttempt prepared)
    {
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT attempted_at_utc, created_at_utc, current_setting('TimeZone')
            FROM security_challenge_attempt WHERE attempt_id = @AttemptId;
            """, connection);
        command.Parameters.AddWithValue("AttemptId", prepared.Request.AttemptId!);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal("UTC", reader.GetString(2));
        AssertRawTimestamp(prepared.Request.AttemptedAtUtc!.Value, reader.GetDateTime(0));
        AssertRawTimestamp(prepared.CreatedAtUtc, reader.GetDateTime(1));
        Assert.False(await reader.ReadAsync());
    }

    private static void AssertRawTimestamp(DateTime expected, DateTime actual)
    {
        Assert.Equal(DateTimeKind.Utc, expected.Kind);
        Assert.Equal(0L, expected.Ticks % 10);
        Assert.Equal(DateTimeKind.Unspecified, actual.Kind);
        Assert.Equal(0L, actual.Ticks % 10);
        Assert.Equal(expected.Ticks, actual.Ticks);
    }

    private sealed record ProtectedChallengeWitness(string SourcePath, string KeyPath,
        string SourceDigest, string KeyDigest, ChallengeV2DurableEntry Entry);

    // Independent inspection of the current persisted wire format, not a producer,
    // key replacement, or a second source of product recovery metadata.
    private sealed record ObservedChallengeEnvelope(int Version, string Reference, long PublicationTicks,
        bool High, byte[] Nonce, byte[] Tag, byte[] Ciphertext);

    private static async Task<ProtectedChallengeWitness> CaptureWitnessAsync(ChallengeV2Issue2040Owner owner, bool high)
    {
        string lane = high ? "high-value" : "normal";
        string path = Assert.Single(Directory.GetFiles(Path.Combine(owner.Root, "challenge-v2-fallback", lane), "*.json"));
        return await ReadWitnessAsync(owner, path);
    }

    private static async Task<ProtectedChallengeWitness> ReadWitnessAsync(ChallengeV2Issue2040Owner owner, string path)
    {
        AssertPrivateWitnessFile(path);
        byte[] source = await File.ReadAllBytesAsync(path);
        Assert.True(source.Length is > 0 and <= 65_536, "challenge-witness:source-size-invalid");
        ObservedChallengeEnvelope envelope = JsonSerializer.Deserialize<ObservedChallengeEnvelope>(source)
            ?? throw new InvalidDataException("challenge-witness:envelope-missing");
        Assert.Equal(1, envelope.Version);
        Assert.Equal(64, envelope.Reference.Length);
        Assert.True(envelope.PublicationTicks > 0, "challenge-witness:publication-invalid");
        Assert.Equal(12, envelope.Nonce.Length);
        Assert.Equal(16, envelope.Tag.Length);
        string filename = $"challenge-{envelope.PublicationTicks:D19}-{envelope.Reference}.json";
        Assert.True(Path.GetFileName(path) == filename || Path.GetFileName(path) == filename + ".committed",
            "challenge-witness:filename-mismatch");
        Assert.Equal(envelope.High ? "high-value" : "normal", Path.GetFileName(Path.GetDirectoryName(path)));
        byte[] key = await owner.Provider.GetRequiredService<IAuditRetentionEpochKeyStore>()
            .TryReadAsync("challenge-v2-delivery", envelope.Reference, CancellationToken.None)
            ?? throw new InvalidDataException("challenge-witness:key-missing");
        byte[] plaintext = new byte[envelope.Ciphertext.Length];
        try
        {
            Assert.Equal(32, key.Length);
            string? keyPath = null;
            foreach (string candidatePath in Directory.EnumerateFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin"))
            {
                AssertPrivateWitnessFile(candidatePath);
                byte[] candidate = await File.ReadAllBytesAsync(candidatePath);
                try
                {
                    if (CryptographicOperations.FixedTimeEquals(candidate, key))
                    {
                        Assert.True(keyPath is null, "challenge-witness:ambiguous-key");
                        keyPath = candidatePath;
                    }
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(candidate);
                }
            }
            Assert.True(keyPath is not null, "challenge-witness:physical-key-missing");
            string queueId = envelope.High ? "challenge-audit-high-value" : "challenge-audit-normal";
            byte[] associatedData = Encoding.UTF8.GetBytes($"challenge:v1:{queueId}:{envelope.Reference}:{envelope.PublicationTicks.ToString(CultureInfo.InvariantCulture)}");
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(envelope.Nonce, envelope.Ciphertext, envelope.Tag, plaintext, associatedData);
            ChallengeV2DurableEntry entry = JsonSerializer.Deserialize<ChallengeV2DurableEntry>(plaintext)
                ?? throw new InvalidDataException("challenge-witness:payload-missing");
            Assert.Equal(envelope.Reference, entry.Reference);
            Assert.Equal(envelope.PublicationTicks, entry.PublicationTicks);
            Assert.Equal(envelope.High, entry.Event.IsHighValue);
            string reference = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(entry.Event.Attempt.AttemptId!)));
            Assert.Equal(reference, entry.Reference);
            Assert.Equal(DateTimeKind.Utc, entry.CreatedAtUtc.Kind);
            Assert.Equal(0L, entry.CreatedAtUtc.Ticks % 10);
            Assert.Equal(DateTimeKind.Utc, entry.Event.Attempt.AttemptedAtUtc!.Value.Kind);
            Assert.Equal(0L, entry.Event.Attempt.AttemptedAtUtc.Value.Ticks % 10);
            return new(path, keyPath ?? throw new InvalidDataException("challenge-witness:physical-key-missing"),
                Convert.ToHexStringLower(SHA256.HashData(source)), Convert.ToHexStringLower(SHA256.HashData(key)), entry);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static async Task AssertPendingWitnessAsync(ChallengeV2Issue2040Owner owner, ProtectedChallengeWitness witness)
    {
        Assert.False(File.Exists(witness.SourcePath + ".committed"));
        ProtectedChallengeWitness current = await ReadWitnessAsync(owner, witness.SourcePath);
        AssertWitnessUnchanged(witness, current);
    }

    private static async Task AssertRetainedWitnessAsync(ChallengeV2Issue2040Owner owner, ProtectedChallengeWitness witness)
    {
        Assert.False(File.Exists(witness.SourcePath));
        Assert.False(Directory.Exists(witness.SourcePath));
        Assert.Equal(witness.SourcePath + ".committed", Assert.Single(Directory.EnumerateFileSystemEntries(
            Path.GetDirectoryName(witness.SourcePath)!, $"challenge-*-{witness.Entry.Reference}.json*")));
        ProtectedChallengeWitness retained = await ReadWitnessAsync(owner, witness.SourcePath + ".committed");
        AssertWitnessUnchanged(witness, retained);
    }

    private static void AssertWitnessUnchanged(ProtectedChallengeWitness expected, ProtectedChallengeWitness actual)
    {
        Assert.Equal(expected.KeyPath, actual.KeyPath);
        Assert.Equal(expected.KeyDigest, actual.KeyDigest);
        Assert.Equal(expected.SourceDigest, actual.SourceDigest);
        Assert.True(expected.Entry == actual.Entry, "challenge-witness:authenticated-entry-changed");
    }

    private static void AssertPrivateWitnessFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("challenge-witness:unix-permission-evidence-required");
        }
        var info = new FileInfo(path);
        Assert.True(info.Exists && !info.Attributes.HasFlag(FileAttributes.Directory)
            && !info.Attributes.HasFlag(FileAttributes.ReparsePoint), "challenge-witness:private-regular-file-required");
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }

    private static ChallengeV2PreparedAttempt Alter(ChallengeV2PreparedAttempt prepared, string field)
    {
        const string OtherHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        SecurityChallengeAttemptRequest request = prepared.Request;
        return field switch
        {
            "challenge" => prepared with { Request = request with { ChallengeId = "another-challenge" } },
            "outcome" => prepared with { Request = request with { Outcome = SecurityChallengeAttemptOutcomes.Verified } },
            "reason" => prepared with { Request = request with { Reason = "changed" } },
            "payload" => prepared with { Request = request with { PayloadHash = OtherHash } },
            "client" => prepared with { Request = request with { ClientIpHash = OtherHash } },
            "device" => prepared with { Request = request with { DeviceFpHash = OtherHash } },
            "trace" => prepared with { Request = request with { TraceId = "changed" } },
            "traceparent" => prepared with { Request = request with { Traceparent = "changed" } },
            "attempted" => prepared with { Request = request with { AttemptedAtUtc = request.AttemptedAtUtc!.Value.AddTicks(10) } },
            "created" => prepared with { Request = request with { }, CreatedAtUtc = prepared.CreatedAtUtc.AddTicks(10) },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
    }

    /// <summary>Owned wire relay drops one genuine COMMIT response; no synthetic store exception.</summary>
    private sealed class CommitReplyCutRelay : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly List<Task> _connections = [];
        private readonly Task _accept;
        private readonly TaskCompletionSource _cut = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly string _host;
        private readonly int _port;
        private int _didCut;
        internal string ConnectionString
        {
            get;
        }
        internal Task CommitCut => _cut.Task;

        internal CommitReplyCutRelay(string connection)
        {
            var builder = new NpgsqlConnectionStringBuilder(connection);
            _host = builder.Host ?? throw new InvalidOperationException("owned_pg_relay_host_required");
            _port = builder.Port;
            _listener.Start();
            builder.Host = "127.0.0.1";
            builder.Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            builder.SslMode = SslMode.Disable;
            builder.Pooling = false;
            builder.Timeout = 3;
            builder.CommandTimeout = 3;
            ConnectionString = builder.ConnectionString;
            _accept = AcceptAsync();
        }

        private async Task AcceptAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    TcpClient client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    _connections.Add(ForwardAsync(client));
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
            }
            catch (SocketException) when (_stop.IsCancellationRequested)
            {
            }
        }

        private async Task ForwardAsync(TcpClient client)
        {
            using (client)
            using (var upstream = new TcpClient())
            using (var transfer = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
            {
                await upstream.ConnectAsync(_host, _port, transfer.Token);
                await using NetworkStream downstream = client.GetStream();
                await using NetworkStream server = upstream.GetStream();
                Task outbound = downstream.CopyToAsync(server, transfer.Token);
                Task inbound = ForwardResponsesAsync(server, downstream, transfer.Token);
                try
                {
                    await Task.WhenAny(outbound, inbound);
                }
                finally
                {
                    transfer.Cancel();
                    client.Close();
                    upstream.Close();
                    try
                    {
                        await Task.WhenAll(outbound, inbound);
                    }
                    catch (OperationCanceledException) when (transfer.IsCancellationRequested)
                    {
                    }
                    catch (IOException) when (transfer.IsCancellationRequested)
                    {
                    }
                    catch (ObjectDisposedException) when (transfer.IsCancellationRequested)
                    {
                    }
                }
            }
        }

        private async Task ForwardResponsesAsync(NetworkStream server, NetworkStream downstream, CancellationToken token)
        {
            byte[] header = new byte[5];
            while (true)
            {
                await server.ReadExactlyAsync(header, token);
                int length = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(1));
                if (length is < 4 or > 16_777_216)
                {
                    throw new InvalidDataException("challenge_relay_frame_invalid");
                }
                byte[] body = new byte[length - 4];
                await server.ReadExactlyAsync(body, token);
                if (header[0] == (byte)'C' && Encoding.ASCII.GetString(body) == "COMMIT\0"
                    && Interlocked.CompareExchange(ref _didCut, 1, 0) == 0)
                {
                    _cut.TrySetResult();
                    return;
                }
                await downstream.WriteAsync(header, token);
                await downstream.WriteAsync(body, token);
            }
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            try
            {
                await _accept;
                await Task.WhenAll(_connections);
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
            }
            finally
            {
                _stop.Dispose();
            }
        }
    }
}
