using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Persists operation facts, never article mutations. Registration uniqueness and a locked immutable
/// identity serialize competing processes; every read names an exact checkpoint, never a latest scan.
/// Native resume and synced admission remain blocked until their actual verification capabilities exist.
/// </summary>
public sealed class PostgresArticleVaultOperationCheckpointStore(
    NpgsqlDataSource dataSource,
    IArticleVaultExecutionStore executionStore,
    TimeProvider timeProvider) : IArticleVaultOperationCheckpointStore, IArticleVaultRecoveryOperationCheckpointWriter
{
    public async Task RegisterAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(identity, plan));

        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        if (timeProvider.GetUtcNow().ToUnixTimeMilliseconds() > identity.DeadlineUnixMs)
        {
            // Expiry must not prevent replaying an identity that was already durably registered.
            await RequireIdentityAsync(connection, null, identity, false, cancellationToken);
            return;
        }

        await using var command = new NpgsqlCommand("""
            INSERT INTO article_vault_operation_identity (
                operation_identity, site_identity, vault_identity, device_identity, agent_identity,
                request_sha256, idempotency_sha256, identity_sha256, identity_json)
            VALUES (@operation, @site, @vault, @device, @agent, @request, @idempotency, @digest, @json)
            ON CONFLICT DO NOTHING
            """, connection);
        command.Parameters.AddWithValue("operation", identity.OperationIdentity);
        command.Parameters.AddWithValue("site", identity.SiteIdentity);
        command.Parameters.AddWithValue("vault", identity.VaultIdentity);
        command.Parameters.AddWithValue("device", identity.DeviceIdentity);
        command.Parameters.AddWithValue("agent", identity.AgentIdentity);
        command.Parameters.AddWithValue("request", identity.RequestSha256);
        command.Parameters.AddWithValue("idempotency", identity.IdempotencySha256);
        command.Parameters.AddWithValue("digest", identity.ContentSha256);
        command.Parameters.AddWithValue("json", Encode(identity));
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 1)
        {
            return;
        }

        await RequireIdentityAsync(connection, null, identity, false, cancellationToken);
    }

    public Task AppendAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        ArticleVaultOperationCheckpoint checkpoint,
        CancellationToken cancellationToken = default)
        => AppendCoreAsync(identity, plan, checkpoint, null, cancellationToken);

    /// <summary>
    /// Stages the canonical journal in the same locked operation transaction, then appends its
    /// exact checkpoint. Replays revalidate the journal binding. This is fact persistence only;
    /// backup authentication, current decision admission and native/base verification stay owned.
    /// </summary>
    public Task AppendAsync(
        ArticleVaultResolutionOperationPlan operationPlan,
        ArticleVaultResolutionPlan proposal,
        ArticleVaultResolutionPlanInput current,
        ArticleVaultRecoveryJournal journal,
        ArticleVaultOperationCheckpoint checkpoint,
        ArticleVaultRecoveryJournalAssociation association,
        IArticleVaultTransactionalRecoveryJournalStore journalStore,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operationPlan);
        ArgumentNullException.ThrowIfNull(proposal);
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(journal);
        ArgumentNullException.ThrowIfNull(association);
        ArgumentNullException.ThrowIfNull(journalStore);
        ArticleVaultOperationVerifier.Require(ArticleVaultResolutionOperationPlanner.ValidateStructure(operationPlan));
        return AppendCoreAsync(operationPlan.Operation, operationPlan.SyncPlan, checkpoint,
            new(operationPlan, proposal, current, journal, association, journalStore), cancellationToken);
    }

    private async Task AppendCoreAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        ArticleVaultOperationCheckpoint checkpoint,
        RecoveryAppend? recovery,
        CancellationToken cancellationToken)
    {
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(identity, plan));
        if (checkpoint.Sequence < 0)
        {
            throw Rejected("article_vault_operation_checkpoint_invalid");
        }

        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(cancellationToken);
        await RequireIdentityAsync(connection, transaction, identity, true, cancellationToken);

        IReadOnlyList<ArticleVaultOperationCheckpoint> stored = await ReadAsync(
            connection, transaction, identity.OperationIdentity, checkpoint.Sequence, cancellationToken);
        ArticleVaultOperationCheckpoint? replay = stored.SingleOrDefault(item => item.Sequence == checkpoint.Sequence);
        if (replay is not null)
        {
            ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.VerifyHistory(
                identity, plan, stored, checkpoint.Sequence, checkpoint.ContentSha256));
            if (!ArticleVaultOperationCodec.Serialize(replay).AsSpan().SequenceEqual(
                ArticleVaultOperationCodec.Serialize(checkpoint)))
            {
                throw Rejected("article_vault_operation_append_conflict");
            }

            await StageRecoveryAsync(transaction, recovery, checkpoint,
                stored.Count > 1 ? stored[^2] : null, cancellationToken);
            if (!ArticleVaultOperationCodec.Serialize(replay).AsSpan().SequenceEqual(
                ArticleVaultOperationCodec.Serialize(checkpoint)))
            {
                throw Rejected("article_vault_operation_append_conflict");
            }

            await transaction.CommitAsync(cancellationToken);
            return;
        }

        ArticleVaultOperationCheckpoint? previous = stored.LastOrDefault();
        if (previous is not null)
        {
            ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.VerifyHistory(
                identity, plan, stored, checkpoint.Sequence - 1,
                checkpoint.PreviousCheckpointSha256 ?? string.Empty));
        }

        ArticleVaultValidationResult appendValidation = ArticleVaultOperationVerifier.ValidateAppend(identity, plan, previous, checkpoint);
        if (appendValidation.ReasonCode == "article_vault_operation_resume_capability_missing")
        {
            throw Rejected(appendValidation.ReasonCode);
        }

        ArticleVaultOperationVerifier.Require(appendValidation);
        RequireAppendWindow(identity, checkpoint);

        if (checkpoint.ServerResult is not null)
        {
            await VerifyServerResultAsync(identity, checkpoint, cancellationToken);
        }

        await StageRecoveryAsync(transaction, recovery, checkpoint, previous, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, previous, checkpoint));
        RequireAppendWindow(identity, checkpoint);

        await using var insert = new NpgsqlCommand("""
            INSERT INTO article_vault_operation_checkpoint (
                operation_identity, sequence, previous_sha256, content_sha256, checkpoint_json)
            VALUES (@operation, @sequence, @previous, @digest, @json)
            """, connection, transaction);
        insert.Parameters.AddWithValue("operation", identity.OperationIdentity);
        insert.Parameters.AddWithValue("sequence", checkpoint.Sequence);
        insert.Parameters.AddWithValue("previous", (object?)checkpoint.PreviousCheckpointSha256 ?? DBNull.Value);
        insert.Parameters.AddWithValue("digest", checkpoint.ContentSha256);
        insert.Parameters.AddWithValue("json", Encode(checkpoint));
        await insert.ExecuteNonQueryAsync(cancellationToken);
        // Checkpoint SQL may wait after journal admission. Reuse the canonical exact replay
        // verifier before commit so backup/proposal expiry and protection remain its authority.
        await StageRecoveryAsync(transaction, recovery, checkpoint, previous, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateAppend(identity, plan, previous, checkpoint));
        RequireAppendWindow(identity, checkpoint);
        await transaction.CommitAsync(cancellationToken);
    }

    private static Task StageRecoveryAsync(NpgsqlTransaction transaction, RecoveryAppend? recovery,
        ArticleVaultOperationCheckpoint checkpoint, ArticleVaultOperationCheckpoint? previous,
        CancellationToken cancellationToken)
        => recovery is null ? Task.CompletedTask : recovery.Store.StageAsync(transaction, recovery.Plan,
            recovery.Proposal, recovery.Current, recovery.Journal, checkpoint, previous,
            recovery.Association, cancellationToken);

    private void RequireAppendWindow(ArticleVaultOperationIdentity identity, ArticleVaultOperationCheckpoint checkpoint)
    {
        long nowUnixMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (checkpoint.RecordedAtUnixMs > nowUnixMs
            || nowUnixMs > identity.DeadlineUnixMs
                && checkpoint.State is not (VaultOperationState.Cancelled or VaultOperationState.RecoveryRequired or VaultOperationState.Blocked))
        {
            throw Rejected("article_vault_operation_current_deadline_invalid");
        }
    }

    private sealed record RecoveryAppend(ArticleVaultResolutionOperationPlan Plan, ArticleVaultResolutionPlan Proposal,
        ArticleVaultResolutionPlanInput Current, ArticleVaultRecoveryJournal Journal,
        ArticleVaultRecoveryJournalAssociation Association, IArticleVaultTransactionalRecoveryJournalStore Store);

    public async Task<IReadOnlyList<ArticleVaultOperationCheckpoint>> ReadThroughAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultSyncPlan plan,
        long sequence,
        string checkpointSha256,
        CancellationToken cancellationToken = default)
    {
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(identity, plan));
        await using NpgsqlConnection connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await RequireIdentityAsync(connection, null, identity, false, cancellationToken);
        IReadOnlyList<ArticleVaultOperationCheckpoint> history = await ReadAsync(
            connection, null, identity.OperationIdentity, sequence, cancellationToken);
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.VerifyHistory(
            identity, plan, history, sequence, checkpointSha256));
        foreach (ArticleVaultOperationCheckpoint checkpoint in history.Where(static item => item.ServerResult is not null))
        {
            await VerifyServerResultAsync(identity, checkpoint, cancellationToken);
        }

        return history;
    }

    private async Task VerifyServerResultAsync(
        ArticleVaultOperationIdentity identity,
        ArticleVaultOperationCheckpoint checkpoint,
        CancellationToken cancellationToken)
    {
        ArticleVaultSealedExecutionBundle bundle = await executionStore.LoadSealedAsync(
            identity.PlanReference, identity.PlanSha256, cancellationToken)
                ?? throw Rejected("article_vault_operation_plan_receipt_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultExecutionResult result = await executionStore.LoadResultAsync(
            checkpoint.ServerResult!.Reference, cancellationToken)
                ?? throw Rejected("article_vault_operation_server_receipt_missing");
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, result);
        bool accepted = result.Outcome is ArticleVaultExecutionOutcome.Completed or ArticleVaultExecutionOutcome.NoOp
            || result.Groups.Any(static group => group.Committed);
        if (result.ContentSha256 != checkpoint.ServerResult.ContentSha256
            || bundle.Plan.DeviceIdentity != identity.DeviceIdentity
            || checkpoint.ServerCommit != (accepted
                ? VaultServerCommitDisposition.Accepted : VaultServerCommitDisposition.Rejected))
        {
            throw Rejected("article_vault_operation_server_receipt_mismatch");
        }
    }

    private static async Task RequireIdentityAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        ArticleVaultOperationIdentity identity,
        bool forUpdate,
        CancellationToken cancellationToken)
    {
        string sql = "SELECT identity_sha256, identity_json FROM article_vault_operation_identity WHERE operation_identity = @operation";
        if (forUpdate)
        {
            sql += " FOR UPDATE";
        }

        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("operation", identity.OperationIdentity);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)
            || reader.GetString(0) != identity.ContentSha256
            || reader.GetString(1) != Encode(identity))
        {
            throw Rejected("article_vault_operation_registration_conflict");
        }
    }

    private static async Task<IReadOnlyList<ArticleVaultOperationCheckpoint>> ReadAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string operationIdentity,
        long throughSequence,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT sequence, previous_sha256, content_sha256, checkpoint_json
            FROM article_vault_operation_checkpoint
            WHERE operation_identity = @operation AND sequence <= @sequence
            ORDER BY sequence ASC
            """, connection, transaction);
        command.Parameters.AddWithValue("operation", operationIdentity);
        command.Parameters.AddWithValue("sequence", throughSequence);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken);
        var history = new List<ArticleVaultOperationCheckpoint>();
        while (await reader.ReadAsync(cancellationToken))
        {
            ArticleVaultOperationCheckpoint checkpoint = ArticleVaultOperationCodec.Deserialize<ArticleVaultOperationCheckpoint>(
                Encoding.UTF8.GetBytes(reader.GetString(3)));
            if (checkpoint.OperationIdentity != operationIdentity
                || checkpoint.Sequence != reader.GetInt64(0)
                || checkpoint.PreviousCheckpointSha256 != (reader.IsDBNull(1) ? null : reader.GetString(1))
                || checkpoint.ContentSha256 != reader.GetString(2))
            {
                throw Rejected("article_vault_operation_store_tampered");
            }

            history.Add(checkpoint);
        }

        return history;
    }

    private static string Encode<T>(T value)
        => Encoding.UTF8.GetString(ArticleVaultOperationCodec.Serialize(value));

    private static ArticleVaultExecutionRejectedException Rejected(string reasonCode)
        => new(reasonCode);
}
