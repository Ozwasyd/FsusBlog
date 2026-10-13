using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;

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
public sealed class ArticleVaultRecoveryStoragePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ExactBackupReplayAndReopen_PreserveOneOpaquePayloadAndReceipt()
    {
        await using Database database = await CreateAsync();
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        await using NpgsqlDataSource reopened = NpgsqlDataSource.Create(database.ConnectionString);
        var storage = new PostgresArticleVaultRecoveryStorage(reopened, database.Proposals, database.Operations,
            database.Protection, TimeProvider.System);
        ArticleVaultRecoveryEncryptedBackup read = await storage.ReadBackupAsync(database.Journal.Backup);
        Assert.Equal(database.Backup, read.Receipt);
        Assert.Equal(database.Ciphertext, read.Ciphertext.ToArray());
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_backup"));
        Assert.Equal(0, await CountAsync(database, "article_vault_execution_result"));
        Assert.Equal(VaultSyncPlanStatus.Blocked, database.Input.Metadata.Plan.Status);
    }

    [Fact]
    public async Task WriterTransaction_AssociationCannotCommitWithoutExactCanonicalCheckpoint()
    {
        await using Database database = await CreateAsync();
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        await database.Operations.RegisterAsync(database.Plan.Operation, database.Plan.SyncPlan);
        await using (NpgsqlConnection connection = await database.Source.OpenConnectionAsync())
        await using (NpgsqlTransaction transaction = await connection.BeginTransactionAsync())
        {
            await StageAsync(database, transaction);
            await Assert.ThrowsAsync<PostgresException>(() => transaction.CommitAsync());
        }
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, database.Checkpoint);
        await using (NpgsqlConnection connection = await database.Source.OpenConnectionAsync())
        await using (NpgsqlTransaction transaction = await connection.BeginTransactionAsync())
        {
            await StageAsync(database, transaction);
            await StageAsync(database, transaction);
            await transaction.CommitAsync();
        }
        IReadOnlyList<ArticleVaultRecoveryStoredJournal> rows = await database.Storage.ReadThroughAsync(
            database.Plan, database.Proposal, 0, database.Journal.ContentSha256);
        Assert.Equal(database.Association, Assert.Single(rows).Association);
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Equal(1, await CountAsync(database, "article_vault_operation_checkpoint"));
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.ReadThroughAsync(
            database.Plan, database.Proposal, 0, "latest"));
    }

    [Fact]
    public async Task MissingProtectionAuthorityAndCiphertextDrift_RefuseBeforeStorage()
    {
        await using Database database = await CreateAsync();
        database.Protection.Refuse = true;
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.SealBackupAsync(database.Backup, database.Ciphertext));
        database.Protection.Refuse = false;
        byte[] changed = database.Ciphertext.ToArray();
        changed[0] ^= 1;
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.SealBackupAsync(database.Backup, changed));
        ArticleVaultRecoveryBackupReceipt wrong = database.Backup with
        {
            Binding = database.Backup.Binding with
            {
                RootManifestSha256 = new('b', 64)
            }
        };
        wrong = wrong with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(wrong)
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.SealBackupAsync(wrong, database.Ciphertext));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_backup"));
    }

    [Fact]
    public async Task ActualSchema_RefusesMutationAndEarlyErasureThenErasesOnlyExpiredPayload()
    {
        await using Database database = await CreateAsync(retentionMs: 3_000);
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        foreach (string sql in new[]
        {
            "UPDATE article_vault_recovery_backup SET receipt_bytes = receipt_bytes",
            "DELETE FROM article_vault_recovery_backup",
            "TRUNCATE article_vault_recovery_backup CASCADE",
            "UPDATE article_vault_recovery_backup_payload SET ciphertext = NULL, erased_at_unix_ms = 9999999999999",
            "DELETE FROM article_vault_recovery_backup_payload"
        })
        {
            await Assert.ThrowsAsync<PostgresException>(() => fixture.ExecuteAsync(database.ConnectionString, sql));
        }
        Assert.Equal(0, await database.Storage.EraseExpiredPayloadsAsync("site-one", "vault-one", "device-one"));
        int remainingMs = checked((int)Math.Max(0, database.Backup.Policy.DeleteAfterUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        await Task.Delay(remainingMs + 30);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.ReadBackupAsync(database.Journal.Backup));
        Assert.Equal(1, await database.Storage.EraseExpiredPayloadsAsync("site-one", "vault-one", "device-one"));
        Assert.Equal(0, await database.Storage.EraseExpiredPayloadsAsync("site-one", "vault-one", "device-one"));
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_backup"));
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using var command = new NpgsqlCommand("""
            SELECT receipt_bytes, ciphertext IS NULL FROM article_vault_recovery_backup
            JOIN article_vault_recovery_backup_payload USING (backup_identity)
            """, connection);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.True(reader.GetBoolean(1));
        string retainedMetadata = Encoding.UTF8.GetString(reader.GetFieldValue<byte[]>(0));
        Assert.DoesNotContain("local title", retainedMetadata, StringComparison.Ordinal);
        Assert.DoesNotContain("source\\n", retainedMetadata, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UnadmittedResume_CannotStageCallerResealedAcceptedReferences()
    {
        await using Database database = await CreateAsync();
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        ArticleVaultOperationCheckpoint previous = database.Checkpoint with
        {
            State = VaultOperationState.RecoveryRequired,
            ServerCommit = VaultServerCommitDisposition.Unknown,
            ReasonCode = "diagnostic_recovery_required"
        };
        previous = previous with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(previous)
        };
        var fakeResult = new VaultOperationStageReference(database.Plan.SyncPlan.ResultCandidateIdentity, new('b', 64));
        ArticleVaultOperationCheckpoint next = database.Checkpoint with
        {
            Sequence = 1,
            PreviousCheckpointSha256 = previous.ContentSha256,
            State = VaultOperationState.MaterializingLocal,
            ServerCommit = VaultServerCommitDisposition.Accepted,
            ServerResult = fakeResult
        };
        next = next with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(next)
        };
        ArticleVaultRecoveryJournal journal = database.Journal with
        {
            Sequence = 1,
            PreviousCheckpointSha256 = database.Journal.ContentSha256,
            State = VaultRecoveryState.LocalMaterializing,
            ServerResult = new(fakeResult.Reference, fakeResult.ContentSha256)
        };
        journal = journal with
        {
            ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(journal)
        };
        ArticleVaultRecoveryJournalAssociation association = database.Association with
        {
            OperationSequence = 1,
            OperationCheckpointSha256 = next.ContentSha256,
            Journal = new(database.Proposal.ResolutionOperationIdentity + "-checkpoint-1", journal.ContentSha256)
        };
        association = association with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(association)
        };
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            database.Storage.StageAsync(transaction, database.Plan, database.Proposal, database.Input,
                journal, next, previous, association));
        Assert.Equal("article_vault_operation_resume_capability_missing", error.ReasonCode);
        await transaction.RollbackAsync();
        await connection.DisposeAsync();
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        Assert.Equal(0, await CountAsync(database, "article_vault_execution_result"));
    }

    [Fact]
    public async Task ActualCiphertextCapacity_IsBoundedAcrossBackupsInTheSameVault()
    {
        await using Database database = await CreateAsync();
        byte[] payload = new byte[checked((int)ArticleVaultRecoveryStorageVerifier.MaxCiphertextBytes)];
        ArticleVaultRecoveryBackupReceipt large = database.Backup with
        {
            BackupIdentity = "diagnostic-large-backup",
            Policy = database.Backup.Policy with
            {
                MaxBytes = ArticleVaultRecoveryJournalVerifier.MaxBackupBytes
            },
            PlaintextBytes = ArticleVaultRecoveryJournalVerifier.MaxBackupBytes,
            CiphertextBytes = payload.Length,
            CiphertextSha256 = ArticleVaultManifestCodec.ComputeSha256(payload)
        };
        large = large with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(large)
        };
        // Exercises actual stored ciphertext size only. The controlled protection authority
        // and opaque bytes still do not establish encrypted plaintext or native backup evidence.
        await database.Storage.SealBackupAsync(large, payload);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            database.Storage.SealBackupAsync(database.Backup, database.Ciphertext));
        Assert.Equal("article_vault_recovery_storage_backup_capacity_exceeded", error.ReasonCode);
        Assert.Equal(1, await CountAsync(database, "article_vault_recovery_backup"));
    }

    [Fact]
    public async Task ExpiredErasedBackup_PreservesUnknownServerObligationWithoutAdmittingRecovery()
    {
        await using Database database = await CreateAsync(retentionMs: 3_000);
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        await database.Operations.RegisterAsync(database.Plan.Operation, database.Plan.SyncPlan);
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, database.Checkpoint);
        await using (NpgsqlConnection connection = await database.Source.OpenConnectionAsync())
        await using (NpgsqlTransaction transaction = await connection.BeginTransactionAsync())
        {
            await StageAsync(database, transaction);
            await transaction.CommitAsync();
        }
        ArticleVaultOperationCheckpoint validating = NextCheckpoint(database.Checkpoint, VaultOperationState.Validating,
            VaultServerCommitDisposition.NotStarted);
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, validating);
        // Only a controlled unknown-outcome protocol fact is recorded. No server writer runs.
        ArticleVaultOperationCheckpoint committing = NextCheckpoint(validating, VaultOperationState.ExecutingServer,
            VaultServerCommitDisposition.Unknown);
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, committing);
        ArticleVaultRecoveryJournal committingJournal = NextJournal(database.Journal, VaultRecoveryState.ServerCommitting);
        await StageJournalAsync(database, committingJournal, committing, validating);
        int remainingMs = checked((int)Math.Max(0, database.Backup.Policy.DeleteAfterUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        await Task.Delay(remainingMs + 30);
        Assert.Equal(1, await database.Storage.EraseExpiredPayloadsAsync("site-one", "vault-one", "device-one"));
        database.Protection.Refuse = true;
        int protectionCalls = database.Protection.Calls;
        ArticleVaultOperationCheckpoint recovery = NextCheckpoint(committing, VaultOperationState.RecoveryRequired,
            VaultServerCommitDisposition.Unknown);
        await database.Operations.AppendAsync(database.Plan.Operation, database.Plan.SyncPlan, recovery);
        ArticleVaultRecoveryJournal recoveryJournal = NextJournal(committingJournal, VaultRecoveryState.RecoveryRequired);
        await StageJournalAsync(database, recoveryJournal, recovery, committing);
        IReadOnlyList<ArticleVaultRecoveryStoredJournal> history = await database.Storage.ReadThroughAsync(
            database.Plan, database.Proposal, 2, recoveryJournal.ContentSha256);
        Assert.Equal(3, history.Count);
        Assert.Equal(VaultRecoveryState.RecoveryRequired, history[^1].Journal.State);
        Assert.Equal(protectionCalls, database.Protection.Calls);
        Assert.All(history, row => Assert.Null(row.Journal.AfterBaseSha256));
        ArticleVaultResolutionPlanInput now = database.Input with
        {
            Metadata = database.Input.Metadata with
            {
                Context = database.Input.Metadata.Context with
                {
                    NowUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                }
            }
        };
        Assert.Equal("article_vault_recovery_backup_expired", ArticleVaultRecoveryJournalVerifier.RequireRecoveryAdmission(
            database.Proposal, now, history.Select(static row => row.Journal).ToImmutableArray(),
            new(database.Proposal.ResolutionOperationIdentity + "-checkpoint-2", recoveryJournal.ContentSha256)).ReasonCode);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => database.Storage.ReadBackupAsync(database.Journal.Backup));
        Assert.Equal(0, await CountAsync(database, "article_vault_execution_result"));
    }

    [Fact]
    public async Task ProtectionAuthorityChangingVerifiedBytes_RefusesReadAndActiveJournal()
    {
        await using Database database = await CreateAsync();
        await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        database.Protection.MutateAfterVerification = true;
        ArticleVaultExecutionRejectedException readError = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            database.Storage.ReadBackupAsync(database.Journal.Backup));
        Assert.Equal("article_vault_recovery_storage_backup_ciphertext_drift", readError.ReasonCode);
        await using (NpgsqlConnection connection = await database.Source.OpenConnectionAsync())
        await using (NpgsqlTransaction transaction = await connection.BeginTransactionAsync())
        {
            ArticleVaultExecutionRejectedException stageError = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
                StageAsync(database, transaction));
            Assert.Equal("article_vault_recovery_storage_backup_ciphertext_drift", stageError.ReasonCode);
            await transaction.RollbackAsync();
        }
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
        database.Protection.MutateAfterVerification = false;
        Assert.Equal(database.Ciphertext, (await database.Storage.ReadBackupAsync(database.Journal.Backup)).Ciphertext.ToArray());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task ActualAdvisoryLockWait_RechecksExpiryAndPreservesPrivateVerifiedBytes(int scenario)
    {
        await using Database database = await CreateAsync(retentionMs: scenario == 2 ? 86_400_000 : 60_000);
        bool stageJournal = scenario == 1;
        if (stageJournal)
        {
            await database.Storage.SealBackupAsync(database.Backup, database.Ciphertext);
        }
        var clock = new DiagnosticTimeProvider(DateTimeOffset.UtcNow);
        var storage = new PostgresArticleVaultRecoveryStorage(database.Source, database.Proposals, database.Operations,
            database.Protection, clock);
        // The actual PostgreSQL lock is held on a separate connection. Only the caller clock is
        // controlled; this is temporal validation evidence, not native or key qualification.
        await using var blocker = new NpgsqlConnection(database.ConnectionString);
        await blocker.OpenAsync();
        await using NpgsqlTransaction blockedTransaction = await blocker.BeginTransactionAsync();
        string scope = stageJournal ? database.Proposal.ResolutionOperationIdentity : "site-one:vault-one";
        await using (var takeLock = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@scope, 0))", blocker, blockedTransaction))
        {
            takeLock.Parameters.AddWithValue("scope", scope);
            await takeLock.ExecuteNonQueryAsync();
        }
        NpgsqlConnection? writer = stageJournal ? await database.Source.OpenConnectionAsync() : null;
        await using (writer)
        {
            NpgsqlTransaction? writerTransaction = writer is null ? null : await writer.BeginTransactionAsync();
            await using (writerTransaction)
            {
                Task pending = stageJournal
                    ? storage.StageAsync(writerTransaction!, database.Plan, database.Proposal, database.Input,
                        database.Journal, database.Checkpoint, null, database.Association)
                    : storage.SealBackupAsync(database.Backup, database.Ciphertext);
                bool waiting = false;
                for (int attempt = 0; attempt < 100 && !waiting && !pending.IsCompleted; attempt++)
                {
                    await using var clearSnapshot = new NpgsqlCommand("SELECT pg_stat_clear_snapshot()", blocker, blockedTransaction);
                    await clearSnapshot.ExecuteNonQueryAsync();
                    await using var observe = new NpgsqlCommand("""
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory')
                        """, blocker, blockedTransaction);
                    waiting = await observe.ExecuteScalarAsync() is true;
                    if (!waiting)
                    {
                        await Task.Delay(20);
                    }
                }
                Assert.True(waiting, "The actual storage command must wait on its PostgreSQL advisory lock.");
                if (scenario == 3)
                {
                    Assert.True(MemoryMarshal.TryGetArray(database.Protection.LastVerifiedMemory, out ArraySegment<byte> authorityArray));
                    authorityArray.AsSpan().Clear();
                }
                else
                {
                    clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(
                        (scenario == 2 ? database.Proposal.ExpiresAtUnixMs : database.Backup.Policy.DeleteAfterUnixMs) + 1);
                }
                await blockedTransaction.CommitAsync();
                if (scenario == 3)
                {
                    await pending;
                }
                else
                {
                    ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => pending);
                    Assert.Equal(scenario == 2 ? "article_vault_recovery_storage_proposal_expired"
                        : "article_vault_recovery_storage_backup_expired_or_future", error.ReasonCode);
                }
                if (writerTransaction is not null)
                {
                    await writerTransaction.RollbackAsync();
                }
            }
        }
        Assert.Equal(stageJournal || scenario == 3 ? 1 : 0, await CountAsync(database, "article_vault_recovery_backup"));
        Assert.Equal(0, await CountAsync(database, "article_vault_recovery_journal"));
        Assert.Equal(0, await CountAsync(database, "article_vault_operation_checkpoint"));
        if (scenario == 3)
        {
            Assert.Equal(database.Ciphertext, (await database.Storage.ReadBackupAsync(database.Journal.Backup)).Ciphertext.ToArray());
        }
    }

    private static ArticleVaultOperationCheckpoint NextCheckpoint(ArticleVaultOperationCheckpoint previous,
        VaultOperationState state, VaultServerCommitDisposition commit)
    {
        ArticleVaultOperationCheckpoint result = previous with
        {
            Sequence = previous.Sequence + 1,
            PreviousCheckpointSha256 = previous.ContentSha256,
            RecordedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            State = state,
            ServerCommit = commit,
            ReasonCode = state == VaultOperationState.RecoveryRequired ? "diagnostic_backup_expired" : null
        };
        return result with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(result)
        };
    }

    private static ArticleVaultRecoveryJournal NextJournal(ArticleVaultRecoveryJournal previous, VaultRecoveryState state)
    {
        ArticleVaultRecoveryJournal result = previous with
        {
            Sequence = previous.Sequence + 1,
            PreviousCheckpointSha256 = previous.ContentSha256,
            CreatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            State = state
        };
        return result with
        {
            ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(result)
        };
    }

    private static async Task StageJournalAsync(Database database, ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint, ArticleVaultOperationCheckpoint previous)
    {
        ArticleVaultRecoveryJournalAssociation association = database.Association with
        {
            OperationSequence = checkpoint.Sequence,
            OperationCheckpointSha256 = checkpoint.ContentSha256,
            Journal = new(database.Proposal.ResolutionOperationIdentity + "-checkpoint-" + journal.Sequence, journal.ContentSha256)
        };
        association = association with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(association)
        };
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
        await database.Storage.StageAsync(transaction, database.Plan, database.Proposal, database.Input, journal, checkpoint, previous, association);
        await transaction.CommitAsync();
    }

    private async Task<Database> CreateAsync(long retentionMs = 60_000)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        string[] ddl = ArticleVaultExecutionMigrationDefinitions.BuildMigration().Steps
            .Concat(ArticleVaultOperationMigrationDefinitions.BuildMigration().Steps)
            .Concat(ArticleVaultResolutionProposalMigrationDefinitions.BuildMigration().Steps)
            .Concat(ArticleVaultRecoveryStorageMigrationDefinitions.BuildMigration().Steps)
            .OfType<RawSqlStep>().Select(static step => step.Sql).ToArray();
        await fixture.ExecuteAsync(connectionString, string.Join('\n', ddl));
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        NpgsqlDataSource source = NpgsqlDataSource.Create(new NpgsqlConnectionStringBuilder(connectionString) { MaxPoolSize = 1 }.ConnectionString);
        var execution = new PostgresArticleVaultExecutionStore(db, TimeProvider.System);
        var proposals = new PostgresArticleVaultResolutionProposalStore(source, execution, TimeProvider.System);
        var operations = new PostgresArticleVaultOperationCheckpointStore(source, execution, TimeProvider.System);
        ArticleVaultResolutionPlanInput input = ArticleVaultResolutionProposalFixture.Create(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
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
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Opaque storage fixture and controlled authority only: no encryption, key custody,
        // native snapshot, device, admitted server mutation or recoverable backup is proved here.
        byte[] ciphertext = Enumerable.Repeat((byte)0x7f, 64).ToArray();
        VaultRecoveryBackupPolicy policy = new(1024, now + retentionMs, true, "private-source", "owned-encrypted-backup-expiry-v1");
        ArticleVaultRecoveryBackupReceipt backup = new(ArticleVaultRecoveryStorageVerifier.BackupSchema, 1, "diagnostic-backup",
            new(new(proposal.ResolutionOperationIdentity, proposal.ContentSha256), plan.OriginalSyncPlan,
                new(plan.Operation.OperationIdentity, plan.ContentSha256), new(plan.Operation.OperationIdentity, plan.Operation.ContentSha256),
                "site-one", "vault-one", "device-one", "article-one", proposal.RootManifestSha256, proposal.Binding.Coordinates.Base.ContentSha256,
                new("diagnostic-native-snapshot", ArticleVaultResolutionProposalFixture.Digest)), policy, now, 7,
            proposal.Binding.Coordinates.Local.Source!.Sha256, ciphertext.Length, ArticleVaultManifestCodec.ComputeSha256(ciphertext),
            "article-vault-recovery", new("diagnostic-key-reference", ArticleVaultResolutionProposalFixture.Digest), string.Empty);
        backup = backup with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(backup)
        };
        ArticleVaultRecoveryJournal journal = new(ArticleVaultRecoveryJournalVerifier.Schema, 1, proposal.ResolutionOperationIdentity,
            proposal.ContentSha256, "site-one", "vault-one", "device-one", 0, null, VaultRecoveryState.Prepared,
            new(backup.BackupIdentity, backup.ContentSha256), policy, null, null, null, proposal.Binding.Coordinates.Base.ContentSha256,
            null, now, string.Empty);
        journal = journal with
        {
            ContentSha256 = ArticleVaultRecoveryJournalVerifier.ComputeContentSha256(journal)
        };
        ArticleVaultOperationCheckpoint checkpoint = new(ArticleVaultOperationSchemas.Checkpoint, 1, plan.Operation.OperationIdentity,
            plan.Operation.ContentSha256, 0, null, now, VaultOperationState.Planned, VaultServerCommitDisposition.NotStarted,
            null, null, [new("article-one", proposal.Binding.Coordinates.Base.ContentSha256, proposal.Binding.Coordinates.Base.ContentSha256)],
            false, null, string.Empty);
        checkpoint = checkpoint with
        {
            ContentSha256 = ArticleVaultOperationCodec.ComputeContentSha256(checkpoint)
        };
        ArticleVaultRecoveryJournalAssociation association = new(ArticleVaultRecoveryStorageVerifier.AssociationSchema, 1,
            new(plan.Operation.OperationIdentity, plan.ContentSha256), new(plan.Operation.OperationIdentity, plan.Operation.ContentSha256),
            0, checkpoint.ContentSha256, new(proposal.ResolutionOperationIdentity + "-checkpoint-0", journal.ContentSha256),
            journal.Backup, string.Empty);
        association = association with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(association)
        };
        var protection = new DiagnosticProtectionAuthority();
        var storage = new PostgresArticleVaultRecoveryStorage(source, proposals, operations, protection, TimeProvider.System);
        return new(connectionString, source, db, proposals, operations, protection, storage, input, proposal, plan,
            backup, ciphertext, journal, checkpoint, association);
    }

    private static Task StageAsync(Database database, NpgsqlTransaction transaction)
        => database.Storage.StageAsync(transaction, database.Plan, database.Proposal, database.Input,
            database.Journal, database.Checkpoint, null, database.Association);

    private static async Task<long> CountAsync(Database database, string table)
    {
        await using NpgsqlConnection connection = await database.Source.OpenConnectionAsync();
        // Table names are test-owned constants, never production input.
        await using var command = new NpgsqlCommand("SELECT COUNT(*) FROM " + table, connection);
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }

    private sealed class DiagnosticProtectionAuthority : IArticleVaultRecoveryBackupProtectionAuthority
    {
        public int Calls
        {
            get; private set;
        }

        public bool Refuse
        {
            get; set;
        }

        public bool MutateAfterVerification
        {
            get; set;
        }

        public ReadOnlyMemory<byte> LastVerifiedMemory
        {
            get; private set;
        }

        public Task VerifyAsync(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlyMemory<byte> ciphertext,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            LastVerifiedMemory = ciphertext;
            if (Refuse || ArticleVaultManifestCodec.ComputeSha256(ciphertext.Span) != receipt.CiphertextSha256)
            {
                throw new ArticleVaultExecutionRejectedException("diagnostic_protection_authority_unavailable");
            }
            if (MutateAfterVerification && MemoryMarshal.TryGetArray(ciphertext, out ArraySegment<byte> array))
            {
                array.AsSpan().Clear();
            }
            return Task.CompletedTask;
        }
    }

    private sealed class DiagnosticTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now
        {
            get; set;
        } = now;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed record Database(string ConnectionString, NpgsqlDataSource Source, SqlSugarClient Db,
        PostgresArticleVaultResolutionProposalStore Proposals, PostgresArticleVaultOperationCheckpointStore Operations,
        DiagnosticProtectionAuthority Protection, PostgresArticleVaultRecoveryStorage Storage, ArticleVaultResolutionPlanInput Input,
        ArticleVaultResolutionPlan Proposal, ArticleVaultResolutionOperationPlan Plan, ArticleVaultRecoveryBackupReceipt Backup,
        byte[] Ciphertext, ArticleVaultRecoveryJournal Journal, ArticleVaultOperationCheckpoint Checkpoint,
        ArticleVaultRecoveryJournalAssociation Association) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Source.DisposeAsync();
            Db.Dispose();
        }
    }
}
