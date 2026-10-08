using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleVaultRecoveryCheckpointTransactionPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task JointAppendAndIndependentWriterRetry_CommitExactlyOneCheckpointAndAssociation()
    {
        await using Database database = await CreateAsync();
        var second = new PostgresArticleVaultOperationCheckpointStore(database.Source, database.Execution, database.Clock);
        await Task.WhenAll(AppendAsync(database), AppendAsync(database, second));
        Assert.Equal(1, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_journal"));
        IReadOnlyList<ArticleVaultRecoveryStoredJournal> rows = await database.Storage.ReadThroughAsync(
            database.Plan, database.Proposal, 0, database.Journal.ContentSha256);
        Assert.Equal(database.Association, Assert.Single(rows).Association);
        Assert.All((await database.Operations.ReadThroughAsync(database.Plan.Operation, database.Plan.SyncPlan,
            0, database.Checkpoint.ContentSha256))[0].Articles,
            static outcome => Assert.Equal(outcome.BaseBeforeSha256, outcome.BaseAfterSha256));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualCheckpointInsertOrDeferredDigestFailure_RollsBackStagedJournal(bool deferred)
    {
        await using Database database = await CreateAsync();
        string body = deferred
            ? "NEW.content_sha256 := repeat('f', 64); RETURN NEW;"
            : "RAISE EXCEPTION 'diagnostic_checkpoint_insert_failure';";
        await fixture.ExecuteAsync(database.ConnectionString, $$"""
            CREATE FUNCTION diagnostic_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN {{body}} END;
            $$;
            CREATE TRIGGER diagnostic_checkpoint_failure BEFORE INSERT ON article_vault_operation_checkpoint
                FOR EACH ROW EXECUTE FUNCTION diagnostic_checkpoint_failure();
            """);
        PostgresException rejected = await Assert.ThrowsAsync<PostgresException>(() => AppendAsync(database));
        Assert.Equal("P0001", rejected.SqlState);
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_backup"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public async Task FailureCancellationOrExpiryAfterActualStage_LeavesNeitherTransactionFact(int scenario)
    {
        await using Database database = await CreateAsync(retentionMs: scenario == 3 ? 5000 : 60_000);
        using var cancellation = new CancellationTokenSource();
        var stage = new AfterStage(database.Storage, () =>
        {
            if (scenario == 0)
            {
                throw new ArticleVaultExecutionRejectedException("diagnostic_failure_after_real_stage");
            }
            if (scenario == 1)
            {
                cancellation.Cancel();
            }
            else if (scenario == 2)
            {
                database.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(database.Plan.Operation.DeadlineUnixMs + 1);
            }
            else if (scenario == 3)
            {
                database.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(database.Backup.Policy.DeleteAfterUnixMs);
            }
            else
            {
                database.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(database.Proposal.ExpiresAtUnixMs);
            }
        });
        if (scenario == 1)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => AppendAsync(database, stage: stage,
                cancellationToken: cancellation.Token));
        }
        else
        {
            ArticleVaultExecutionRejectedException rejection = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
                () => AppendAsync(database, stage: stage));
            string expected = scenario switch
            {
                0 => "diagnostic_failure_after_real_stage",
                2 => "article_vault_operation_current_deadline_invalid",
                3 => "article_vault_recovery_storage_backup_expired_or_future",
                _ => "article_vault_recovery_storage_proposal_expired"
            };
            Assert.Equal(expected, rejection.Message);
        }

        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
    }

    [Fact]
    public async Task MissingProtectionAndStaleCurrentFacts_RefuseBeforeJointWrite()
    {
        await using Database database = await CreateAsync();
        database.Protection.Refuse = true;
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => AppendAsync(database));
        database.Protection.Refuse = false;
        ArticleVaultResolutionPlanInput stale = database.Input with
        {
            Git = database.Input.Git with
            {
                ContentSha256 = ArticleVaultResolutionProposalFixture.Digest
            }
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Operations.AppendAsync(
            database.Plan, database.Proposal, stale, database.Journal, database.Checkpoint,
            database.Association, database.Storage));
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
    }

    [Fact]
    public async Task SameCheckpointWithConflictingJournalRetry_CannotRewriteEitherHistory()
    {
        await using Database database = await CreateAsync();
        await AppendAsync(database);
        ArticleVaultRecoveryJournal changed = Seal(database.Journal with
        {
            CreatedAtUnixMs = database.Journal.CreatedAtUnixMs - 1
        });
        ArticleVaultRecoveryJournalAssociation association = Association(database, changed, database.Checkpoint);
        ArticleVaultExecutionRejectedException rejected = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => database.Operations.AppendAsync(database.Plan, database.Proposal, database.Input,
                changed, database.Checkpoint, association, database.Storage));
        Assert.Equal("article_vault_recovery_storage_journal_append_conflict", rejected.Message);
        Assert.Equal(1, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Single(await database.Storage.ReadThroughAsync(database.Plan, database.Proposal, 0, database.Journal.ContentSha256));
    }

    [Fact]
    public async Task CallerCheckpointMutationAfterStage_IsRejectedWithoutCorruptingStoredDigest()
    {
        await using Database database = await CreateAsync();
        var stage = new AfterStage(database.Storage, () =>
        {
            var outcomes = (VaultOperationArticleOutcome[])database.Checkpoint.Articles;
            outcomes[0] = outcomes[0] with
            {
                BaseAfterSha256 = ArticleVaultResolutionProposalFixture.Digest
            };
        });
        InvalidDataException rejected = await Assert.ThrowsAsync<InvalidDataException>(() => AppendAsync(database, stage: stage));
        Assert.Equal("article_vault_operation_checkpoint_invalid", rejected.Message);
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
    }

    [Fact]
    public async Task ErasedBackupAndExpiredProposal_JointlyRetainUnknownObligationWithoutResume()
    {
        await using Database database = await CreateAsync(retentionMs: 1500);
        await AppendAsync(database);
        ArticleVaultOperationCheckpoint validating = Next(database.Checkpoint, VaultOperationState.Validating);
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, validating);
        ArticleVaultOperationCheckpoint committing = Next(validating, VaultOperationState.ExecutingServer, VaultServerCommitDisposition.Unknown);
        ArticleVaultRecoveryJournal committingJournal = Seal(database.Journal with
        {
            Sequence = 1,
            PreviousCheckpointSha256 = database.Journal.ContentSha256,
            State = VaultRecoveryState.ServerCommitting,
            CreatedAtUnixMs = committing.RecordedAtUnixMs
        });
        await database.Operations.AppendAsync(database.Plan, database.Proposal, database.Input, committingJournal,
            committing, Association(database, committingJournal, committing), database.Storage);
        long wait = database.Backup.Policy.DeleteAfterUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30;
        if (wait > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(wait));
        }
        database.Clock.Now = DateTimeOffset.UtcNow;
        Assert.Equal(1, await database.Storage.EraseExpiredPayloadsAsync("site-one", "vault-one", "device-one"));
        database.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(database.Plan.Operation.DeadlineUnixMs + 1);
        database.Protection.Refuse = true;
        int protectionCalls = database.Protection.Calls;
        ArticleVaultOperationCheckpoint recovery = Next(committing, VaultOperationState.RecoveryRequired,
            VaultServerCommitDisposition.Unknown, "server_outcome_unknown", database.Clock.Now.ToUnixTimeMilliseconds());
        ArticleVaultRecoveryJournal recoveryJournal = Seal(committingJournal with
        {
            Sequence = 2,
            PreviousCheckpointSha256 = committingJournal.ContentSha256,
            State = VaultRecoveryState.RecoveryRequired,
            CreatedAtUnixMs = recovery.RecordedAtUnixMs
        });
        await database.Operations.AppendAsync(database.Plan, database.Proposal, database.Input, recoveryJournal,
            recovery, Association(database, recoveryJournal, recovery), database.Storage);
        await database.Operations.AppendAsync(database.Plan, database.Proposal, database.Input, recoveryJournal,
            recovery, Association(database, recoveryJournal, recovery), database.Storage);
        Assert.Equal(protectionCalls, database.Protection.Calls);
        Assert.Equal(3, (await database.Storage.ReadThroughAsync(database.Plan, database.Proposal,
            recoveryJournal.Sequence, recoveryJournal.ContentSha256)).Count);
        Assert.Equal(4, (await database.Operations.ReadThroughAsync(database.Plan.Operation, database.Plan.SyncPlan,
            recovery.Sequence, recovery.ContentSha256)).Count);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.ReadBackupAsync(recoveryJournal.Backup));
        Assert.Equal("article_vault_resolution_operation_canonical_planner_decision_admission_missing",
            ArticleVaultResolutionOperationPlanner.RequireExecutionAdmission(database.Plan, database.Proposal, database.Input).ReasonCode);
        Assert.All(recovery.Articles, static outcome => Assert.Equal(outcome.BaseBeforeSha256, outcome.BaseAfterSha256));
        ArticleVaultOperationCheckpoint resume = Next(recovery, VaultOperationState.MaterializingLocal,
            VaultServerCommitDisposition.Unknown, time: recovery.RecordedAtUnixMs);
        ArticleVaultExecutionRejectedException refusal = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => database.Operations.AppendAsync(database.Plan, database.Proposal, database.Input, recoveryJournal,
                resume, Association(database, recoveryJournal, resume), database.Storage));
        Assert.Equal("article_vault_operation_resume_capability_missing", refusal.Message);
        Assert.Equal(4, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(3, await CountAsync(database, "article_vault_recovery_journal"));
    }

    private async Task<Database> CreateAsync(long retentionMs = 60_000)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        var descriptors = new[] { ArticleVaultExecutionMigrationDefinitions.BuildMigration(), ArticleVaultOperationMigrationDefinitions.BuildMigration(),
            ArticleVaultResolutionProposalMigrationDefinitions.BuildMigration(), ArticleVaultRecoveryStorageMigrationDefinitions.BuildMigration() };
        await fixture.ExecuteAsync(connectionString, string.Join('\n', descriptors.SelectMany(static descriptor => descriptor.Steps)
            .OfType<RawSqlStep>().Select(static step => step.Sql)));
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        NpgsqlDataSource source = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(connectionString) { MaxPoolSize = 1 }.ConnectionString);
        var clock = new TestClock(DateTimeOffset.UtcNow);
        var execution = new PostgresArticleVaultExecutionStore(db, clock);
        var proposals = new PostgresArticleVaultResolutionProposalStore(source, execution, clock);
        var operations = new PostgresArticleVaultOperationCheckpointStore(source, execution, clock);
        ArticleVaultResolutionPlanInput input = ArticleVaultResolutionProposalFixture.Create(clock.Now.ToUnixTimeMilliseconds());
        ArticleVaultExecutionPayload payload = new(ArticleVaultExecutionSchemas.Payload, 1, [], string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        ArticleVaultSealedExecutionBundle bundle = new(ArticleVaultExecutionSchemas.Bundle, 1, input.Metadata.Plan.PlanCandidateIdentity,
            input.Metadata.Plan.ContentSha256, 7, input.Metadata.Plan, input.Metadata.Root, input.Metadata.Articles, input.Metadata.Observations, payload, string.Empty);
        bundle = bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
        await execution.SealAsync(bundle);
        ArticleVaultResolutionPlan proposal = ArticleVaultResolutionPlanner.Build(input).Plan!;
        await proposals.SealAsync(proposal, input);
        ArticleVaultResolutionOperationPlan plan = ArticleVaultResolutionOperationPlanner.Build(proposal, input).Plan!;
        await operations.RegisterAsync(plan.Operation, plan.SyncPlan);
        // These opaque bytes and the controlled verifier test transaction mechanics only.
        // No real encryption, key custody, native capture, execution or base commit is claimed.
        byte[] ciphertext = Enumerable.Repeat((byte)0x7f, 64).ToArray();
        ArticleVaultRecoveryBackupReceipt backup = new(ArticleVaultRecoveryStorageVerifier.BackupSchema, 1, "diagnostic-joint-backup",
            new(new(proposal.ResolutionOperationIdentity, proposal.ContentSha256), plan.OriginalSyncPlan,
                new(plan.Operation.OperationIdentity, plan.ContentSha256), new(plan.Operation.OperationIdentity, plan.Operation.ContentSha256),
                "site-one", "vault-one", "device-one", "article-one", proposal.RootManifestSha256, proposal.Binding.Coordinates.Base.ContentSha256,
                new("diagnostic-native-snapshot", ArticleVaultResolutionProposalFixture.Digest)),
            new(1024, clock.Now.ToUnixTimeMilliseconds() + retentionMs, true, "private-source", "owned-encrypted-backup-expiry-v1"),
            clock.Now.ToUnixTimeMilliseconds(), 7, proposal.Binding.Coordinates.Local.Source!.Sha256,
            ciphertext.Length, ArticleVaultManifestCodec.ComputeSha256(ciphertext), "article-vault-recovery",
            new("diagnostic-key", ArticleVaultResolutionProposalFixture.Digest), string.Empty);
        backup = backup with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(backup)
        };
        var protection = new ControlledProtection();
        var storage = new PostgresArticleVaultRecoveryStorage(source, proposals, operations, protection, clock);
        await storage.SealBackupAsync(backup, ciphertext);
        ArticleVaultRecoveryJournal journal = Seal(new(ArticleVaultRecoveryJournalVerifier.Schema, 1, proposal.ResolutionOperationIdentity,
            proposal.ContentSha256, "site-one", "vault-one", "device-one", 0, null, VaultRecoveryState.Prepared,
            new(backup.BackupIdentity, backup.ContentSha256), backup.Policy, null, null, null,
            proposal.Binding.Coordinates.Base.ContentSha256, null, clock.Now.ToUnixTimeMilliseconds(), string.Empty));
        ArticleVaultOperationCheckpoint checkpoint = new(ArticleVaultOperationSchemas.Checkpoint, 1, plan.Operation.OperationIdentity,
            plan.Operation.ContentSha256, 0, null, clock.Now.ToUnixTimeMilliseconds(), VaultOperationState.Planned,
            VaultServerCommitDisposition.NotStarted, null, null,
            new[] { new VaultOperationArticleOutcome("article-one", proposal.Binding.Coordinates.Base.ContentSha256, proposal.Binding.Coordinates.Base.ContentSha256) },
            false, null, string.Empty);
        checkpoint = checkpoint with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint)
        };
        ArticleVaultRecoveryJournalAssociation association = Association(plan, proposal, journal, checkpoint);
        return new(connectionString, source, db, clock, execution, operations, storage, protection, input, proposal, plan, backup, journal, checkpoint, association);
    }

    private static Task AppendAsync(Database database, PostgresArticleVaultOperationCheckpointStore? writer = null,
        IArticleVaultTransactionalRecoveryJournalStore? stage = null, CancellationToken cancellationToken = default)
        => (writer ?? database.Operations).AppendAsync(database.Plan, database.Proposal, database.Input, database.Journal,
            database.Checkpoint, database.Association, stage ?? database.Storage, cancellationToken);

    private static ArticleVaultRecoveryJournal Seal(ArticleVaultRecoveryJournal journal)
        => journal with
        {
            ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(journal)
        };

    private static ArticleVaultRecoveryJournalAssociation Association(Database database, ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint) => Association(database.Plan, database.Proposal, journal, checkpoint);

    private static ArticleVaultRecoveryJournalAssociation Association(ArticleVaultResolutionOperationPlan plan,
        ArticleVaultResolutionPlan proposal, ArticleVaultRecoveryJournal journal, ArticleVaultOperationCheckpoint checkpoint)
    {
        ArticleVaultRecoveryJournalAssociation result = new(ArticleVaultRecoveryStorageVerifier.AssociationSchema, 1,
            new(plan.Operation.OperationIdentity, plan.ContentSha256), new(plan.Operation.OperationIdentity, plan.Operation.ContentSha256),
            checkpoint.Sequence, checkpoint.ContentSha256,
            new(proposal.ResolutionOperationIdentity + "-checkpoint-" + journal.Sequence, journal.ContentSha256), journal.Backup, string.Empty);
        return result with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(result)
        };
    }

    private static ArticleVaultOperationCheckpoint Next(ArticleVaultOperationCheckpoint previous, VaultOperationState state,
        VaultServerCommitDisposition commit = VaultServerCommitDisposition.NotStarted, string? reason = null, long? time = null)
    {
        ArticleVaultOperationCheckpoint result = previous with
        {
            Sequence = previous.Sequence + 1,
            PreviousCheckpointSha256 = previous.ContentSha256,
            RecordedAtUnixMs = time ?? previous.RecordedAtUnixMs,
            State = state,
            ServerCommit = commit,
            ReasonCode = reason
        };
        return result with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(result)
        };
    }

    private static async Task<long> CountAsync(Database database, string table)
    {
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("SELECT count(*) FROM " + table, connection);
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }

    private sealed class ControlledProtection : IArticleVaultRecoveryBackupProtectionAuthority
    {
        internal bool Refuse
        {
            get; set;
        }
        internal int Calls
        {
            get; private set;
        }
        public Task VerifyAsync(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlyMemory<byte> ciphertext,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            if (Refuse || ArticleVaultManifestCodec.ComputeSha256(ciphertext.Span) != receipt.CiphertextSha256)
            {
                throw new ArticleVaultExecutionRejectedException("diagnostic_protection_unavailable");
            }
            return Task.CompletedTask;
        }
    }

    private sealed class AfterStage(IArticleVaultTransactionalRecoveryJournalStore inner, Action action)
        : IArticleVaultTransactionalRecoveryJournalStore
    {
        public async Task StageAsync(NpgsqlTransaction transaction, ArticleVaultResolutionOperationPlan operationPlan,
            ArticleVaultResolutionPlan proposal, ArticleVaultResolutionPlanInput current, ArticleVaultRecoveryJournal journal,
            ArticleVaultOperationCheckpoint checkpoint, ArticleVaultOperationCheckpoint? previousCheckpoint,
            ArticleVaultRecoveryJournalAssociation association, CancellationToken cancellationToken = default)
        {
            await inner.StageAsync(transaction, operationPlan, proposal, current, journal, checkpoint,
                previousCheckpoint, association, cancellationToken);
            action();
        }
    }

    private sealed class TestClock(DateTimeOffset now) : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Database(string ConnectionString, NpgsqlDataSource Source, SqlSugarClient Db, TestClock Clock,
        PostgresArticleVaultExecutionStore Execution, PostgresArticleVaultOperationCheckpointStore Operations,
        PostgresArticleVaultRecoveryStorage Storage, ControlledProtection Protection, ArticleVaultResolutionPlanInput Input,
        ArticleVaultResolutionPlan Proposal, ArticleVaultResolutionOperationPlan Plan, ArticleVaultRecoveryBackupReceipt Backup,
        ArticleVaultRecoveryJournal Journal, ArticleVaultOperationCheckpoint Checkpoint, ArticleVaultRecoveryJournalAssociation Association)
        : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Source.DisposeAsync();
            Db.Dispose();
        }
    }
}
