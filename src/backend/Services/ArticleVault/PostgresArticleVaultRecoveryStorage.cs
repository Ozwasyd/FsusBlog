using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Persists only encrypted backup payloads and immutable journal associations. Operation checkpoints
/// remain the canonical owner's writes. Backup authentication is delegated to the real dedicated key
/// authority; storage, receipts or a successful transaction cannot admit native resume or base commit.
/// </summary>
public sealed class PostgresArticleVaultRecoveryStorage(
    NpgsqlDataSource dataSource,
    IArticleVaultResolutionProposalStore proposalStore,
    IArticleVaultOperationCheckpointStore checkpointStore,
    IArticleVaultRecoveryBackupProtectionAuthority protectionAuthority,
    TimeProvider timeProvider) : IArticleVaultTransactionalRecoveryJournalStore
{
    public async Task SealBackupAsync(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlyMemory<byte> ciphertext,
        CancellationToken cancellationToken = default)
    {
        RequireValid(ArticleVaultRecoveryStorageVerifier.ValidateBackup(receipt));
        if (ciphertext.Length != receipt.CiphertextBytes)
        {
            throw Rejected("backup_ciphertext_drift");
        }
        ciphertext = ciphertext.ToArray();
        VerifyCiphertext(receipt, ciphertext.Span);
        RequireAvailable(receipt);
        ArticleVaultResolutionPlan proposal = await proposalStore.ReadExactAsync(receipt.Binding.Proposal.Identity,
            receipt.Binding.Proposal.ContentSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("stored_proposal_missing");
        if (proposal.State != VaultResolutionPlanState.Prepared
            || timeProvider.GetUtcNow().ToUnixTimeMilliseconds() >= proposal.ExpiresAtUnixMs
            || receipt.Binding.OriginalSyncPlan != new VaultRecoveryReference(proposal.Binding.PlanCandidateIdentity, proposal.Binding.PlanSha256)
            || receipt.Binding.SiteIdentity != proposal.Binding.SiteIdentity || receipt.Binding.VaultIdentity != proposal.Binding.VaultIdentity
            || receipt.Binding.DeviceIdentity != proposal.Binding.DeviceIdentity || receipt.Binding.PortableArticleIdentity != proposal.Binding.PortableArticleIdentity
            || receipt.Binding.RootManifestSha256 != proposal.RootManifestSha256
            || receipt.Binding.BeforeBaseSha256 != proposal.Binding.Coordinates.Base.ContentSha256)
        {
            throw Rejected("backup_original_scope_drift");
        }

        await protectionAuthority.VerifyAsync(receipt, ciphertext, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // The authority must not retain the array that will be persisted across later awaits.
        ciphertext = ciphertext.ToArray();
        VerifyCiphertext(receipt, ciphertext.Span);
        RequireAvailable(receipt);
        RequireProposalAvailable(proposal);
        byte[] receiptBytes = ArticleVaultOperationCodec.Serialize(receipt);
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
        await LockAsync(connection, transaction, receipt.Binding.SiteIdentity + ":" + receipt.Binding.VaultIdentity,
            cancellationToken).ConfigureAwait(false);
        RequireAvailable(receipt);
        RequireProposalAvailable(proposal);
        await using (var existing = new NpgsqlCommand(
            "SELECT receipt_bytes FROM article_vault_recovery_backup WHERE backup_identity = @identity", connection, transaction))
        {
            existing.Parameters.AddWithValue("identity", receipt.BackupIdentity);
            object? bytes = await existing.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            if (bytes is byte[] stored)
            {
                if (!stored.AsSpan().SequenceEqual(receiptBytes))
                {
                    throw Rejected("backup_append_conflict");
                }
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return;
            }
        }

        await using (var quota = new NpgsqlCommand("""
            SELECT COALESCE(SUM(octet_length(payload.ciphertext)), 0)
            FROM article_vault_recovery_backup backup
            JOIN article_vault_recovery_backup_payload payload USING (backup_identity)
            WHERE backup.site_identity = @site AND backup.vault_identity = @vault
            """, connection, transaction))
        {
            quota.Parameters.AddWithValue("site", receipt.Binding.SiteIdentity);
            quota.Parameters.AddWithValue("vault", receipt.Binding.VaultIdentity);
            long allocated = Convert.ToInt64(await quota.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false));
            if (allocated > ArticleVaultRecoveryStorageVerifier.MaxCiphertextBytes - ciphertext.Length)
            {
                throw Rejected("backup_capacity_exceeded");
            }
        }

        await using var insert = new NpgsqlCommand("""
            INSERT INTO article_vault_recovery_backup
                (backup_identity, content_sha256, proposal_identity, site_identity, vault_identity, device_identity,
                 delete_after_unix_ms, receipt_bytes)
            VALUES (@identity, @digest, @proposal, @site, @vault, @device, @expiry, @receipt);
            INSERT INTO article_vault_recovery_backup_payload (backup_identity, ciphertext)
            VALUES (@identity, @ciphertext)
            """, connection, transaction);
        insert.Parameters.AddWithValue("identity", receipt.BackupIdentity);
        insert.Parameters.AddWithValue("digest", receipt.ContentSha256);
        insert.Parameters.AddWithValue("proposal", receipt.Binding.Proposal.Identity);
        insert.Parameters.AddWithValue("site", receipt.Binding.SiteIdentity);
        insert.Parameters.AddWithValue("vault", receipt.Binding.VaultIdentity);
        insert.Parameters.AddWithValue("device", receipt.Binding.DeviceIdentity);
        insert.Parameters.AddWithValue("expiry", receipt.Policy.DeleteAfterUnixMs);
        insert.Parameters.AddWithValue("receipt", receiptBytes);
        insert.Parameters.AddWithValue("ciphertext", ciphertext.ToArray());
        RequireAvailable(receipt);
        RequireProposalAvailable(proposal);
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<ArticleVaultRecoveryEncryptedBackup> ReadBackupAsync(VaultRecoveryReference exactBackup,
        CancellationToken cancellationToken = default)
    {
        RequireReference(exactBackup);
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        ArticleVaultRecoveryEncryptedBackup backup = await LoadBackupAsync(connection, null, exactBackup,
            cancellationToken).ConfigureAwait(false);
        await connection.DisposeAsync().ConfigureAwait(false);
        await protectionAuthority.VerifyAsync(backup.Receipt, backup.Ciphertext, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        byte[] verifiedCiphertext = backup.Ciphertext.ToArray();
        VerifyCiphertext(backup.Receipt, verifiedCiphertext);
        RequireAvailable(backup.Receipt);
        return new(backup.Receipt, verifiedCiphertext);
    }

    public async Task<int> EraseExpiredPayloadsAsync(string siteIdentity, string vaultIdentity, string deviceIdentity,
        CancellationToken cancellationToken = default)
    {
        if (new[] { siteIdentity, vaultIdentity, deviceIdentity }.Any(static value =>
            string.IsNullOrWhiteSpace(value) || value.Length > 128))
        {
            throw Rejected("cleanup_scope_invalid");
        }

        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using var erase = new NpgsqlCommand("""
            UPDATE article_vault_recovery_backup_payload payload
            SET ciphertext = NULL, erased_at_unix_ms = @now
            FROM article_vault_recovery_backup backup
            WHERE payload.backup_identity = backup.backup_identity
                AND backup.site_identity = @site AND backup.vault_identity = @vault AND backup.device_identity = @device
                AND backup.delete_after_unix_ms <= @now AND payload.ciphertext IS NOT NULL
            """, connection);
        erase.Parameters.AddWithValue("site", siteIdentity);
        erase.Parameters.AddWithValue("vault", vaultIdentity);
        erase.Parameters.AddWithValue("device", deviceIdentity);
        erase.Parameters.AddWithValue("now", timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
        return await erase.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task StageAsync(NpgsqlTransaction transaction,
        ArticleVaultResolutionOperationPlan operationPlan, ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current, ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint, ArticleVaultOperationCheckpoint? previousCheckpoint,
        ArticleVaultRecoveryJournalAssociation association, CancellationToken cancellationToken = default)
    {
        NpgsqlConnection connection = transaction.Connection ?? throw Rejected("writer_transaction_missing");
        // New execution preparation requires current admission. Obligations after an uncertain or
        // accepted server stage remain appendable when a proposal expires; this never admits resume.
        bool requiresCurrent = journal.State is VaultRecoveryState.Prepared or VaultRecoveryState.ServerCommitting;
        RequireValid(requiresCurrent
            ? ArticleVaultResolutionOperationPlanner.VerifyCurrent(operationPlan, proposal, current)
            : ArticleVaultResolutionOperationPlanner.ValidateStructure(operationPlan));
        if (requiresCurrent)
        {
            RequireProposalAvailable(proposal);
        }
        if (journal.CreatedAtUnixMs > timeProvider.GetUtcNow().ToUnixTimeMilliseconds())
        {
            throw Rejected("journal_future_time");
        }
        await using (var exactProposal = new NpgsqlCommand("""
            SELECT content_sha256 FROM article_vault_resolution_proposal
            WHERE resolution_operation_identity = @identity
            """, connection, transaction))
        {
            exactProposal.Parameters.AddWithValue("identity", proposal.ResolutionOperationIdentity);
            if (await exactProposal.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) as string != proposal.ContentSha256)
            {
                throw Rejected("stored_proposal_binding_drift");
            }
        }
        bool metadataOnly = journal.State is VaultRecoveryState.RecoveryRequired or VaultRecoveryState.Cancelled or VaultRecoveryState.Failed;
        ArticleVaultRecoveryBackupReceipt receipt;
        if (metadataOnly)
        {
            receipt = await LoadReceiptAsync(connection, journal.Backup, cancellationToken, transaction).ConfigureAwait(false);
        }
        else
        {
            ArticleVaultRecoveryEncryptedBackup backup = await LoadBackupAsync(connection, transaction, journal.Backup,
                cancellationToken).ConfigureAwait(false);
            await protectionAuthority.VerifyAsync(backup.Receipt, backup.Ciphertext, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            VerifyCiphertext(backup.Receipt, backup.Ciphertext.Span);
            RequireAvailable(backup.Receipt);
            receipt = backup.Receipt;
        }
        RequireValid(ArticleVaultRecoveryStorageVerifier.VerifyAssociation(association, operationPlan, proposal,
            journal, checkpoint, previousCheckpoint, receipt));
        await LockAsync(connection, transaction, proposal.ResolutionOperationIdentity, cancellationToken).ConfigureAwait(false);
        if (!metadataOnly)
        {
            RequireAvailable(receipt);
        }
        if (requiresCurrent)
        {
            RequireProposalAvailable(proposal);
        }
        List<ArticleVaultRecoveryStoredJournal> stored = await ReadRowsAsync(connection, transaction,
            proposal.ResolutionOperationIdentity, journal.Sequence, cancellationToken).ConfigureAwait(false);
        ArticleVaultRecoveryStoredJournal? replay = stored.SingleOrDefault(row => row.Journal.Sequence == journal.Sequence);
        byte[] journalBytes = ArticleVaultOperationCodec.Serialize(journal);
        byte[] associationBytes = ArticleVaultOperationCodec.Serialize(association);
        if (replay is not null)
        {
            if (!ArticleVaultOperationCodec.Serialize(replay.Journal).AsSpan().SequenceEqual(journalBytes)
                || !ArticleVaultOperationCodec.Serialize(replay.Association).AsSpan().SequenceEqual(associationBytes))
            {
                throw Rejected("journal_append_conflict");
            }
            return;
        }

        RequireValid(ArticleVaultRecoveryJournalVerifier.VerifyHistory(proposal,
            stored.Select(static row => row.Journal).Append(journal).ToImmutableArray(), association.Journal));
        await using var insert = new NpgsqlCommand("""
            INSERT INTO article_vault_recovery_journal
                (resolution_identity, sequence, content_sha256, association_sha256, operation_identity,
                 operation_sequence, operation_checkpoint_sha256, backup_identity, journal_bytes, association_bytes)
            VALUES (@resolution, @sequence, @digest, @association_digest, @operation,
                @operation_sequence, @checkpoint_digest, @backup, @journal, @association)
            """, connection, transaction);
        insert.Parameters.AddWithValue("resolution", proposal.ResolutionOperationIdentity);
        insert.Parameters.AddWithValue("sequence", journal.Sequence);
        insert.Parameters.AddWithValue("digest", journal.ContentSha256);
        insert.Parameters.AddWithValue("association_digest", association.ContentSha256);
        insert.Parameters.AddWithValue("operation", operationPlan.Operation.OperationIdentity);
        insert.Parameters.AddWithValue("operation_sequence", checkpoint.Sequence);
        insert.Parameters.AddWithValue("checkpoint_digest", checkpoint.ContentSha256);
        insert.Parameters.AddWithValue("backup", receipt.BackupIdentity);
        insert.Parameters.AddWithValue("journal", journalBytes);
        insert.Parameters.AddWithValue("association", associationBytes);
        if (!metadataOnly)
        {
            RequireAvailable(receipt);
        }
        if (requiresCurrent)
        {
            RequireProposalAvailable(proposal);
        }
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ArticleVaultRecoveryStoredJournal>> ReadThroughAsync(
        ArticleVaultResolutionOperationPlan operationPlan, ArticleVaultResolutionPlan proposal,
        long exactSequence, string exactJournalSha256, CancellationToken cancellationToken = default)
    {
        RequireValid(ArticleVaultResolutionOperationPlanner.ValidateStructure(operationPlan));
        RequireValid(ArticleVaultResolutionPlanner.ValidateStructure(proposal));
        RequireReference(new(proposal.ResolutionOperationIdentity + "-checkpoint-" + exactSequence, exactJournalSha256));
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        List<ArticleVaultRecoveryStoredJournal> rows = await ReadRowsAsync(connection, null,
            proposal.ResolutionOperationIdentity, exactSequence, cancellationToken).ConfigureAwait(false);
        var backups = new Dictionary<string, ArticleVaultRecoveryBackupReceipt>(StringComparer.Ordinal);
        foreach (ArticleVaultRecoveryStoredJournal row in rows)
        {
            backups[row.Journal.Backup.Identity] = await LoadReceiptAsync(connection, row.Journal.Backup,
                cancellationToken).ConfigureAwait(false);
        }
        await connection.DisposeAsync().ConfigureAwait(false);
        RequireValid(ArticleVaultRecoveryJournalVerifier.VerifyHistory(proposal, rows.Select(static row => row.Journal).ToImmutableArray(),
            new(proposal.ResolutionOperationIdentity + "-checkpoint-" + exactSequence, exactJournalSha256)));
        foreach (ArticleVaultRecoveryStoredJournal row in rows)
        {
            ArticleVaultRecoveryJournalAssociation association = row.Association;
            IReadOnlyList<ArticleVaultOperationCheckpoint> history = await checkpointStore.ReadThroughAsync(operationPlan.Operation,
                operationPlan.SyncPlan, association.OperationSequence, association.OperationCheckpointSha256,
                cancellationToken).ConfigureAwait(false);
            RequireValid(ArticleVaultRecoveryStorageVerifier.VerifyAssociation(association, operationPlan, proposal, row.Journal,
                history[^1], history.Count > 1 ? history[^2] : null, backups[row.Journal.Backup.Identity]));
        }
        return rows;
    }

    private async Task<ArticleVaultRecoveryEncryptedBackup> LoadBackupAsync(NpgsqlConnection connection,
        NpgsqlTransaction? transaction, VaultRecoveryReference exactBackup, CancellationToken cancellationToken)
    {
        RequireReference(exactBackup);
        await using var command = new NpgsqlCommand("""
            SELECT backup.receipt_bytes, payload.ciphertext FROM article_vault_recovery_backup backup
            JOIN article_vault_recovery_backup_payload payload USING (backup_identity)
            WHERE backup.backup_identity = @identity AND backup.content_sha256 = @digest
            """, connection, transaction);
        command.Parameters.AddWithValue("identity", exactBackup.Identity);
        command.Parameters.AddWithValue("digest", exactBackup.ContentSha256);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.IsDBNull(1))
        {
            throw Rejected("backup_missing_or_erased");
        }
        ArticleVaultRecoveryBackupReceipt receipt = DecodeReceipt(reader.GetFieldValue<byte[]>(0), exactBackup);
        RequireAvailable(receipt);
        byte[] ciphertext = reader.GetFieldValue<byte[]>(1);
        VerifyCiphertext(receipt, ciphertext);
        return new(receipt, ciphertext);
    }

    private static async Task<ArticleVaultRecoveryBackupReceipt> LoadReceiptAsync(NpgsqlConnection connection,
        VaultRecoveryReference exactBackup, CancellationToken cancellationToken, NpgsqlTransaction? transaction = null)
    {
        RequireReference(exactBackup);
        await using var command = new NpgsqlCommand("""
            SELECT receipt_bytes FROM article_vault_recovery_backup
            WHERE backup_identity = @identity AND content_sha256 = @digest
            """, connection, transaction);
        command.Parameters.AddWithValue("identity", exactBackup.Identity);
        command.Parameters.AddWithValue("digest", exactBackup.ContentSha256);
        byte[] bytes = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) as byte[]
            ?? throw Rejected("backup_receipt_missing");
        return DecodeReceipt(bytes, exactBackup);
    }

    private static ArticleVaultRecoveryBackupReceipt DecodeReceipt(byte[] bytes, VaultRecoveryReference reference)
    {
        ArticleVaultRecoveryBackupReceipt receipt = ArticleVaultOperationCodec.Deserialize<ArticleVaultRecoveryBackupReceipt>(bytes);
        RequireValid(ArticleVaultRecoveryStorageVerifier.ValidateBackup(receipt));
        if (receipt.BackupIdentity != reference.Identity || receipt.ContentSha256 != reference.ContentSha256
            || !ArticleVaultOperationCodec.Serialize(receipt).AsSpan().SequenceEqual(bytes))
        {
            throw Rejected("backup_receipt_binding_drift");
        }
        return receipt;
    }

    private static async Task<List<ArticleVaultRecoveryStoredJournal>> ReadRowsAsync(NpgsqlConnection connection,
        NpgsqlTransaction? transaction, string resolutionIdentity, long exactSequence, CancellationToken cancellationToken)
    {
        if (exactSequence is < 0 or > 9_999)
        {
            throw Rejected("journal_sequence_invalid");
        }
        await using var command = new NpgsqlCommand("""
            SELECT sequence, content_sha256, association_sha256, journal_bytes, association_bytes
            FROM article_vault_recovery_journal WHERE resolution_identity = @resolution AND sequence <= @sequence
            ORDER BY sequence
            """, connection, transaction);
        command.Parameters.AddWithValue("resolution", resolutionIdentity);
        command.Parameters.AddWithValue("sequence", exactSequence);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        List<ArticleVaultRecoveryStoredJournal> rows = [];
        long retainedBytes = 0;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            byte[] journalBytes = reader.GetFieldValue<byte[]>(3);
            byte[] associationBytes = reader.GetFieldValue<byte[]>(4);
            retainedBytes += journalBytes.Length + associationBytes.Length;
            if (retainedBytes > ArticleVaultRecoveryJournalVerifier.MaxBackupBytes)
            {
                throw Rejected("journal_history_byte_limit");
            }
            ArticleVaultRecoveryJournal journal = ArticleVaultOperationCodec.Deserialize<ArticleVaultRecoveryJournal>(journalBytes);
            ArticleVaultRecoveryJournalAssociation association = ArticleVaultOperationCodec.Deserialize<ArticleVaultRecoveryJournalAssociation>(associationBytes);
            RequireValid(ArticleVaultRecoveryJournalVerifier.ValidateStructure(journal));
            if (journal.Sequence != reader.GetInt64(0) || journal.ContentSha256 != reader.GetString(1)
                || association.ContentSha256 != reader.GetString(2)
                || association.ContentSha256 != ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(association)
                || !ArticleVaultOperationCodec.Serialize(journal).AsSpan().SequenceEqual(journalBytes)
                || !ArticleVaultOperationCodec.Serialize(association).AsSpan().SequenceEqual(associationBytes))
            {
                throw Rejected("journal_bytes_or_binding_drift");
            }
            rows.Add(new(journal, association));
        }
        return rows;
    }

    private static async Task LockAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string scope, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended(@scope, 0))", connection, transaction);
        command.Parameters.AddWithValue("scope", scope);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    private void RequireAvailable(ArticleVaultRecoveryBackupReceipt receipt)
    {
        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (receipt.CreatedAtUnixMs > now || receipt.Policy.DeleteAfterUnixMs <= now)
        {
            throw Rejected("backup_expired_or_future");
        }
    }

    private void RequireProposalAvailable(ArticleVaultResolutionPlan proposal)
    {
        if (timeProvider.GetUtcNow().ToUnixTimeMilliseconds() >= proposal.ExpiresAtUnixMs)
        {
            throw Rejected("proposal_expired");
        }
    }

    private static void VerifyCiphertext(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlySpan<byte> ciphertext)
    {
        if (ciphertext.Length != receipt.CiphertextBytes
            || ArticleVaultManifestCodec.ComputeSha256(ciphertext) != receipt.CiphertextSha256)
        {
            throw Rejected("backup_ciphertext_drift");
        }
    }

    private static void RequireReference(VaultRecoveryReference reference)
    {
        if (reference is null || string.IsNullOrWhiteSpace(reference.Identity) || reference.Identity.Length > 128
            || reference.ContentSha256 is not { Length: 64 }
            || !reference.ContentSha256.All(static value => value is >= '0' and <= '9' or >= 'a' and <= 'f'))
        {
            throw Rejected("exact_reference_invalid");
        }
    }

    private static void RequireValid(ArticleVaultValidationResult result)
    {
        if (!result.IsValid)
        {
            throw new ArticleVaultExecutionRejectedException(result.ReasonCode ?? "article_vault_recovery_storage_invalid");
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_recovery_storage_" + reason);
}
