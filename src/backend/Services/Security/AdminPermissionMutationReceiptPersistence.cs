using System.Data;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// Immutable database-observed transition, identified only within its PostgreSQL transaction.
/// The JSON snapshots contain an explicit authority-field allowlist, never credentials or hashes.
/// Transaction IDs and ordinals are receipt identity, not authority generations or commit order.
/// </summary>
public sealed record AdminPermissionMutationReceipt(
    string TransactionId,
    int Ordinal,
    string SubjectKind,
    string MutationKind,
    string? BeforeJson,
    string? AfterJson,
    bool CredentialChanged);

/// <summary>
/// Seals the complete set of database-triggered transitions on the caller's existing transaction.
/// Does not start/commit transactions, allocate authority versions, publish events, or read a clock.
/// Migration registration and every live writer hookup belong to the original source owner.
/// At base 8c822c5295b6dcd9ab2d1ea5d87cebe989a42942, AdminPrincipalService hookup inventory:
/// bootstrap UseTranAsync: principal identity insert + session insert (two transitions);
/// IssueCommittedAdminSessionAsync: LastLoginAtUtc is metadata, session insert is one transition;
/// DisableAdminPrincipalAsync: active-status UPDATE count == 1, otherwise zero;
/// RevokeAdminSessionAsync: candidate ownership + unrevoked + xmin CAS count == 1;
/// LogoutAdminSessionAsync: delegates to that same revoke transaction, no duplicate receipt;
/// RevokeOtherAdminSessionsAsync: every actual UPDATE RETURNING row, never the requested set;
/// RotateAdminSessionAccessTokenAsync: validation-version/unrevoked CAS count == 1;
/// IAdminSessionIssuancePort compensation and CleanupAsync: same revoke transaction when changed;
/// CleanupAsync conflict recovery: read-only transaction, zero new transitions, reuse durable facts.
/// Prepare is inside each original transaction and Publish follows its commit. Keep those owners.
/// The current touch scheduler changes only LastSeenAtUtc (metadata, zero transitions). Any future
/// idle/absolute lifetime writer must complete its own batch through the separate lifetime owner.
/// Fixture direct seed/cleanup and physical deletion also need explicit complete-batch hookup
/// before registration; the deferred guard deliberately fails closed for any missing participant.
/// SqlSugarAuthFixtureLifecycleRepository.InsertOwnedAdminAsync is currently an autocommit insert;
/// RuntimeCacheScenarioEvidenceEndpoints creates/deletes sessions directly. Both need original
/// owner transaction boundaries. DemoFixtureSeeder deletes in replica mode in its existing
/// transaction, so this migration's capture/integrity triggers run ALWAYS, including that mode.
/// Expiry without a write emits nothing: live authentication must still evaluate current time.
/// </summary>
public static class AdminPermissionMutationReceiptPersistence
{
    /// <summary>
    /// Bind before the first authority mutation. Call CompleteAsync after all actual CAS results
    /// are known and before committing. A returned receipt remains provisional until that commit.
    /// A failed/rolled-back attempt has no durable receipt; retry on a new transaction/binding.
    /// </summary>
    public static async Task<AdminPermissionMutationReceiptBatch> BeginAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken = default)
    {
        NpgsqlTransaction transaction = RequireTransaction(db);
        await using var command = new NpgsqlCommand("""
            SELECT pg_current_xact_id()::text,
                (SELECT count(*) FROM public.admin_permission_mutation_receipt
                 WHERE transaction_id = pg_current_xact_id()),
                EXISTS (SELECT 1 FROM public.admin_permission_mutation_receipt_batch
                        WHERE transaction_id = pg_current_xact_id());
            """, transaction.Connection, transaction);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        if (reader.GetInt64(1) != 0 || reader.GetBoolean(2))
        {
            throw new InvalidOperationException("admin_receipt_begin_after_mutation");
        }
        return new AdminPermissionMutationReceiptBatch(db, transaction, reader.GetString(0));
    }

    internal static NpgsqlTransaction RequireTransaction(ISqlSugarClient db)
    {
        ArgumentNullException.ThrowIfNull(db);
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || db.Ado.Transaction is not NpgsqlTransaction transaction
            || transaction.Connection is not { State: ConnectionState.Open } connection
            || !ReferenceEquals(db.Ado.Connection, connection))
        {
            throw new InvalidOperationException("admin_receipt_original_transaction_required");
        }
        return transaction;
    }
}

/// <summary>
/// A binding to one concrete original transaction. CompleteAsync is idempotent only on that
/// transaction and with the same count; it never replays a mutation or accepts caller snapshots.
/// </summary>
public sealed class AdminPermissionMutationReceiptBatch
{
    private readonly ISqlSugarClient _db;
    private readonly NpgsqlTransaction _transaction;

    internal AdminPermissionMutationReceiptBatch(ISqlSugarClient db, NpgsqlTransaction transaction, string transactionId)
    {
        _db = db;
        _transaction = transaction;
        TransactionId = transactionId;
    }

    public string TransactionId
    {
        get;
    }

    /// <summary>
    /// expectedTransitionCount is the total number of actual authority transitions, including
    /// repeated writes to the same row, not attempted rows or a preselected subset of IDs.
    /// Zero seals a no-op without emitting a receipt. After sealing, later authority writes fail.
    /// The database also rejects commit of any captured transition without a complete seal.
    /// Publish or enroll the returned immutable facts only through the source owner's path.
    /// </summary>
    public async Task<IReadOnlyList<AdminPermissionMutationReceipt>> CompleteAsync(
        int expectedTransitionCount,
        CancellationToken cancellationToken = default)
    {
        if (expectedTransitionCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedTransitionCount));
        }
        NpgsqlTransaction transaction = AdminPermissionMutationReceiptPersistence.RequireTransaction(_db);
        if (!ReferenceEquals(transaction, _transaction))
        {
            throw new InvalidOperationException("admin_receipt_wrong_transaction");
        }

        // The BEFORE INSERT guard checks the whole journal even on an idempotent conflict.
        // A mismatch is a PostgreSQL error and aborts this transaction, not a partial success.
        await using (var command = new NpgsqlCommand("""
            INSERT INTO public.admin_permission_mutation_receipt_batch(transaction_id, transition_count)
            VALUES (pg_current_xact_id(), @Count)
            ON CONFLICT (transaction_id) DO NOTHING;
            """, transaction.Connection, transaction))
        {
            command.Parameters.AddWithValue("Count", expectedTransitionCount);
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await using var read = new NpgsqlCommand("""
            SELECT transaction_id::text, ordinal, subject_kind, mutation_kind,
                before_state::text, after_state::text, credential_changed
            FROM public.admin_permission_mutation_receipt
            WHERE transaction_id = pg_current_xact_id()
            ORDER BY ordinal;
            """, transaction.Connection, transaction);
        await using NpgsqlDataReader reader = await read.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var receipts = new List<AdminPermissionMutationReceipt>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            receipts.Add(new AdminPermissionMutationReceipt(
                reader.GetString(0), reader.GetInt32(1), reader.GetString(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.IsDBNull(5) ? null : reader.GetString(5), reader.GetBoolean(6)));
        }
        return receipts.AsReadOnly();
    }
}
