using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.AspNetCore.DataProtection;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class DocumentExportTaskJournalIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DocumentExportQueueLimits s_limits = new(8, 1, 67108864, TimeSpan.FromMinutes(5));

    [Fact]
    public async Task QueuedRecovery_ReusesEncryptedInputAndIdempotencyAcrossIndependentKeyRingProviders()
    {
        using SqlSugarClient db = await DatabaseAsync();
        string keyDirectory = Path.Combine(Path.GetTempPath(), $"fsus-export-keys-{Guid.NewGuid():N}");
        Directory.CreateDirectory(keyDirectory);
        try
        {
            DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
            DocumentExportQueueSnapshot original;
            using (var queue = Queue(db, DataProtectionProvider.Create(new DirectoryInfo(keyDirectory))))
            {
                original = await queue.EnqueueAsync(Task(input, 1), input);
                await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
                await connection.OpenAsync();
                await using var command = new NpgsqlCommand("SELECT frozen_input FROM document_export_task;", connection);
                byte[] encrypted = Assert.IsType<byte[]>(await command.ExecuteScalarAsync());
                Assert.False(encrypted.AsSpan().SequenceEqual(DocumentExportDigest.Serialize(input)));
                Assert.Throws<InvalidDataException>(() => DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(encrypted));
            }
            using var restored = Queue(db, DataProtectionProvider.Create(new DirectoryInfo(keyDirectory)));
            Assert.Equal(original, await restored.ReadAsync(input.UserId, input.SiteId, original.Task.TaskId));
            Assert.Equal(original, await restored.EnqueueAsync(Task(input, 1) with
            {
                TaskId = original.Task.TaskId
            }, input));
            DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await restored.TryClaimAsync());
            (_, DocumentExportFrozenInput delivered) = await restored.StartAsync(claim);
            Assert.Equal(input.ContentDigest, delivered.ContentDigest);
            Assert.Empty(await restored.ReadRecoveryClaimsAsync());
        }
        finally
        {
            Directory.Delete(keyDirectory, recursive: true);
        }
    }

    [Fact]
    public async Task InterruptedRetry_RetainsOriginalFailureAndOutstandingCleanupUntilExplicitAcknowledgement()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTaskClaim oldClaim;
        DocumentExportTask originalFailure;
        Guid secondAttemptId;
        using (var queue = Queue(db, protection))
        {
            await queue.EnqueueAsync(Task(input, 1), input);
            oldClaim = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
            originalFailure = (await queue.AcknowledgeStoppedAsync(
                oldClaim, DocumentExportProviderResultStatus.Failed, true)).Task;
            await queue.RetryAsync(input.UserId, input.SiteId, oldClaim.TaskId, "retry-two");
            DocumentExportTaskClaim second = Assert.IsType<DocumentExportTaskClaim>(await queue.TryClaimAsync());
            await queue.StartAsync(second);
            secondAttemptId = (await queue.ReadAsync(input.UserId, input.SiteId, oldClaim.TaskId)).CurrentAttempt.AttemptId;
        }
        using var restored = Queue(db, protection);
        DocumentExportQueueSnapshot recovery = await restored.ReadAsync(input.UserId, input.SiteId, oldClaim.TaskId);
        Assert.Equal(originalFailure, recovery.Task);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, recovery.CurrentAttempt.Status);
        Assert.Equal(secondAttemptId, recovery.CurrentAttempt.AttemptId);
        Assert.True(recovery.ExecutionOutstanding);
        await restored.EnqueueAsync(Task(input, 2), input);
        Assert.Null(await restored.TryClaimAsync());
        (Guid attemptId, DocumentExportTaskClaim claim) = Assert.Single(await restored.ReadRecoveryClaimsAsync());
        Assert.Equal(secondAttemptId, attemptId);
        Assert.True(claim.CancellationToken.IsCancellationRequested);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            restored.AcknowledgeStoppedAsync(oldClaim, DocumentExportProviderResultStatus.Failed, true));
        await restored.AcknowledgeStoppedAsync(claim, DocumentExportProviderResultStatus.Failed, false);
        Assert.Null(await restored.TryClaimAsync());
        await restored.AcknowledgeStoppedAsync(claim, DocumentExportProviderResultStatus.Failed, true);
        Assert.NotNull(await restored.TryClaimAsync());
        Assert.Equal(originalFailure, (await restored.ReadAsync(input.UserId, input.SiteId, oldClaim.TaskId)).Task);
        Assert.Equal(2, (await restored.ReadAttemptsAsync(input.UserId, input.SiteId, oldClaim.TaskId)).Count);
    }

    [Fact]
    public async Task AnotherDatabaseOwner_IsRefusedUntilTheDedicatedSessionIsReleased()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        using (var owner = Queue(db, protection))
        {
            Assert.Throws<InvalidOperationException>(() => Queue(db, protection));
        }
        using var successor = Queue(db, protection);
        Assert.Null(await successor.TryClaimAsync());
    }

    [Fact]
    public async Task StalePersistedRevision_PoisonsAdmissionWithoutExposingAnUncommittedClaim()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = Queue(db, protection))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
            await db.Ado.ExecuteCommandAsync("UPDATE document_export_task SET revision = revision + 1;");
            await Assert.ThrowsAsync<InvalidOperationException>(() => owner.TryClaimAsync());
            await Assert.ThrowsAsync<InvalidOperationException>(() => owner.ReadAsync(input.UserId, input.SiteId, "journal-task-1"));
        }
        using var restored = Queue(db, protection);
        DocumentExportQueueSnapshot state = await restored.ReadAsync(input.UserId, input.SiteId, "journal-task-1");
        Assert.Equal(DocumentExportTaskStatus.Queued, state.CurrentAttempt.Status);
        Assert.False(state.ExecutionOutstanding);
        Assert.NotNull(await restored.TryClaimAsync());
    }

    [Fact]
    public async Task ConnectionLoss_StopsTheOwnerAndRecoveryPreservesTheHostObligation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        string application = $"export-journal-control-{Guid.NewGuid():N}";
        var connection = new NpgsqlConnectionStringBuilder(db.CurrentConnectionConfig.ConnectionString)
        {
            ApplicationName = application
        };
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = new DocumentExportTaskQueue(new Clock(), s_limits,
            new PostgresDocumentExportTaskJournal(connection.ConnectionString, protection, s_limits)))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
            DocumentExportTaskClaim claim = Assert.IsType<DocumentExportTaskClaim>(await owner.TryClaimAsync());
            await owner.StartAsync(claim);
            var aborted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using CancellationTokenRegistration registration = claim.CancellationToken.Register(() => aborted.TrySetResult());
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = @App;",
                new SugarParameter("@App", application));
            await Assert.ThrowsAsync<InvalidOperationException>(() => owner.ReadAsync(input.UserId, input.SiteId, claim.TaskId));
            await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        }
        using var restored = Queue(db, protection);
        Assert.Single(await restored.ReadRecoveryClaimsAsync());
        Assert.Null(await restored.TryClaimAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CiphertextTamperOrCrossTaskReplay_FailsRecovery(bool replay)
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = Queue(db, protection))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
            await owner.EnqueueAsync(Task(input, 2), input);
        }
        await db.Ado.ExecuteCommandAsync(replay
            ? "UPDATE document_export_task SET frozen_input = (SELECT frozen_input FROM document_export_task WHERE task_id = 'journal-task-2') WHERE task_id = 'journal-task-1';"
            : "UPDATE document_export_task SET state = set_byte(state, 20, get_byte(state, 20) # 1) WHERE task_id = 'journal-task-1';");
        Assert.ThrowsAny<Exception>(() => Queue(db, protection));
    }

    [Fact]
    public async Task ExpiredRecovery_HoldsActiveSlotAndPurgesOnlyAfterCleanup()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        var clock = new Clock();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = Queue(db, protection, clock))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
            await owner.TryClaimAsync();
        }
        clock.Advance(TimeSpan.FromMinutes(6));
        using var restored = Queue(db, protection, clock);
        DocumentExportQueueSnapshot state = await restored.ReadAsync(input.UserId, input.SiteId, "journal-task-1");
        Assert.Equal(DocumentExportTaskStatus.Expired, state.CurrentAttempt.Status);
        (Guid _, DocumentExportTaskClaim claim) = Assert.Single(await restored.ReadRecoveryClaimsAsync());
        Assert.Null(await restored.TryClaimAsync());
        await restored.AcknowledgeStoppedAsync(claim, DocumentExportProviderResultStatus.Cancelled, true);
        await restored.ExpireAsync();
        Assert.Equal(0L, Convert.ToInt64(await db.Ado.GetScalarAsync("SELECT count(*) FROM document_export_task;")));
        await restored.EnqueueAsync(Task(input, 1), input);
        Assert.NotNull(await restored.TryClaimAsync());
    }

    [Fact]
    public async Task JournalWrite_CannotReplaceTheImmutableInputScopeOrProviderIdentity()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = Queue(db, protection))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
        }
        using var journal = new PostgresDocumentExportTaskJournal(db.CurrentConnectionConfig.ConnectionString, protection, s_limits);
        DocumentExportJournalEntry original = Assert.Single(journal.Read());
        DocumentExportFrozenInput replacement = DocumentExportContractValidator.Seal(input with
        {
            InputId = "replacement-input"
        });
        DocumentExportTask task = Task(replacement, 1);
        DocumentExportAttemptSnapshot unsigned = original.State.Attempts[0].Snapshot with
        {
            TaskDigest = task.ContentDigest,
            ContentDigest = string.Empty
        };
        DocumentExportAttemptSnapshot snapshot = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        DocumentExportPersistedEntry changed = original.State with
        {
            Task = task,
            Identity = DocumentExportDigest.Compute(task with
            {
                TaskId = string.Empty,
                RequestId = string.Empty,
                ContentDigest = string.Empty
            }),
            RetainedBytes = DocumentExportDigest.Serialize(replacement).LongLength,
            Attempts = [new DocumentExportPersistedAttempt(task, snapshot, false)]
        };
        Assert.Throws<InvalidOperationException>(() => journal.Write(changed, replacement, original.Revision));
        DocumentExportJournalEntry retained = Assert.Single(journal.Read());
        Assert.Equal(original.State.Task, retained.State.Task);
        Assert.Equal(original.Input.ContentDigest, retained.Input.ContentDigest);
        Assert.Equal(original.Revision, retained.Revision);
    }

    [Fact]
    public async Task RecoveryBudget_RefusesAnOversizedRetainedQueue()
    {
        using SqlSugarClient db = await DatabaseAsync();
        var protection = new EphemeralDataProtectionProvider();
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        using (var owner = Queue(db, protection))
        {
            await owner.EnqueueAsync(Task(input, 1), input);
            await owner.EnqueueAsync(Task(input, 2), input);
        }
        var narrower = s_limits with
        {
            MaxTasks = 1
        };
        Assert.Throws<InvalidDataException>(() => new DocumentExportTaskQueue(new Clock(), narrower,
            new PostgresDocumentExportTaskJournal(db.CurrentConnectionConfig.ConnectionString, protection, narrower)));
    }

    [Fact]
    public async Task MissingSchema_RefusesActivationWithoutAutomaticDdl()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresException failure = Assert.Throws<PostgresException>(() => Queue(db, new EphemeralDataProtectionProvider()));
        Assert.Equal(PostgresErrorCodes.UndefinedTable, failure.SqlState);
        Assert.Equal(0L, Convert.ToInt64(await db.Ado.GetScalarAsync(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = 'document_export_task';")));
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        // DDL is confined to this disposable test database. Production activation
        // needs its explicit Expand/compatibility evidence; the adapter has no DDL.
        await db.Ado.ExecuteCommandAsync(
            """
            CREATE TABLE document_export_task(
                task_id text PRIMARY KEY,
                user_id bigint NOT NULL CHECK(user_id > 0),
                site_id bigint NOT NULL CHECK(site_id > 0),
                idempotency_key text NOT NULL,
                created_at_utc_ticks bigint NOT NULL,
                expires_at_utc_ticks bigint NOT NULL CHECK(expires_at_utc_ticks > created_at_utc_ticks),
                retained_bytes bigint NOT NULL CHECK(retained_bytes > 0),
                revision bigint NOT NULL CHECK(revision > 0),
                frozen_input bytea NOT NULL,
                state bytea NOT NULL,
                identity_digest varchar(71) NOT NULL,
                input_digest varchar(71) NOT NULL,
                UNIQUE(user_id, site_id, idempotency_key));
            """);
        return db;
    }

    private static DocumentExportTaskQueue Queue(
        ISqlSugarClient db, IDataProtectionProvider protection, Clock? clock = null)
        => new(clock ?? new Clock(), s_limits,
            new PostgresDocumentExportTaskJournal(db.CurrentConnectionConfig.ConnectionString, protection, s_limits));

    private static DocumentExportTask Task(DocumentExportFrozenInput input, int number)
        => DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            TaskId = $"journal-task-{number}",
            RequestId = $"journal-request-{number}",
            IdempotencyKey = $"journal-key-{number}"
        });

    private sealed class Clock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        internal void Advance(TimeSpan duration) => _now += duration;
    }
}
