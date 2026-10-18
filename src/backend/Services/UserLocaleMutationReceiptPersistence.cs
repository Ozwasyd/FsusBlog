using System.Text.Json;

using FsusBlog.Server.Services.Articles;

using Npgsql;

using NpgsqlTypes;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>The persisted display preference only; neither content locale nor definition-label locale.</summary>
public sealed record UserLocalePreferenceReceiptState(
    string Mode, string? FixedLocale, long Revision, DateTime UpdatedAt);

/// <summary>Immutable transition facts. Preference revisions are not source generations.</summary>
public sealed record UserLocaleMutationReceipt(
    Guid ReceiptId, int AccountId, string MutationKind, Guid? CompensatesReceiptId,
    UserLocalePreferenceReceiptState? Before, UserLocalePreferenceReceiptState? After);

/// <summary>
/// Borrows the original owner's native transaction. The owner acquires the original source
/// family lock before CaptureBeforeAsync / ReadForUpdate, performs its existing CAS SQL,
/// calls PersistActualAfterAsync with its actual affected count, enrolls the receipt through
/// the original source authority, then commits. Compensation uses its own original transaction
/// and references the successful update receipt. Any exception requires owner rollback.
/// No connection, transaction, schema, clock, endpoint or commit is created here.
/// </summary>
public static class UserLocaleMutationReceiptPersistence
{
    /// <summary>An unforgeable capture bound to one client, native connection, transaction and account.</summary>
    public sealed class Capture
    {
        internal Capture(ISqlSugarClient db, NpgsqlConnection connection, NpgsqlTransaction transaction,
            int accountId, UserLocalePreferenceReceiptState? before, UserLocaleMutationReceipt? original)
        {
            Db = db;
            Connection = connection;
            Transaction = transaction;
            AccountId = accountId;
            Before = before;
            Original = original;
        }

        internal ISqlSugarClient Db
        {
            get;
        }
        internal NpgsqlConnection Connection
        {
            get;
        }
        internal NpgsqlTransaction Transaction
        {
            get;
        }
        internal UserLocaleMutationReceipt? Original
        {
            get;
        }
        public Guid ReceiptId { get; } = Guid.NewGuid();
        public int AccountId
        {
            get;
        }
        public UserLocalePreferenceReceiptState? Before
        {
            get;
        }
    }

    /// <summary>
    /// Captures actual locked before state, never caller-supplied preference DTOs. A missing
    /// row remains absent (not a synthetic auto/revision-zero row). The family lock also
    /// serializes the original absent-row insert path. No receipt is emitted by capture.
    /// </summary>
    public static async Task<Capture> CaptureBeforeAsync(ISqlSugarClient db, int accountId,
        Guid? compensatesReceiptId = null, CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(accountId);
        cancellationToken.ThrowIfCancellationRequested();
        (NpgsqlConnection connection, NpgsqlTransaction transaction) =
            ArticleSourceGenerationAuthority.RequireTransaction(db);
        await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        UserLocaleMutationReceipt? original = null;
        if (compensatesReceiptId.HasValue)
        {
            original = await ReadReceiptAsync(connection, transaction, compensatesReceiptId.Value,
                cancellationToken).ConfigureAwait(false);
            if (original is null || original.AccountId != accountId || original.MutationKind != "update")
            {
                throw new InvalidOperationException("locale_receipt_compensation_owner_mismatch");
            }
        }
        (UserLocalePreferenceReceiptState? before, _) = await ReadStateAsync(
            connection, transaction, accountId, cancellationToken).ConfigureAwait(false);
        return new Capture(db, connection, transaction, accountId, before, original);
    }

    /// <summary>
    /// Emits only a successful, actual transition read after the original SQL on the captured
    /// transaction. Returns null for CAS conflict/no change. Repeating this call on the same
    /// capture is idempotent; retry after transaction rollback requires a fresh capture.
    /// Returned facts remain transaction-local until the original owner commits.
    /// </summary>
    public static async Task<UserLocaleMutationReceipt?> PersistActualAfterAsync(
        ISqlSugarClient db, Capture capture, int affectedRows, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(capture);
        cancellationToken.ThrowIfCancellationRequested();
        (NpgsqlConnection connection, NpgsqlTransaction transaction) =
            ArticleSourceGenerationAuthority.RequireTransaction(db);
        if (!ReferenceEquals(db, capture.Db) || !ReferenceEquals(connection, capture.Connection)
            || !ReferenceEquals(transaction, capture.Transaction))
        {
            throw new InvalidOperationException("locale_receipt_transaction_owner_mismatch");
        }
        await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        (UserLocalePreferenceReceiptState? after, bool writtenHere) = await ReadStateAsync(
            connection, transaction, capture.AccountId, cancellationToken).ConfigureAwait(false);
        bool changed = capture.Before != after;
        if (affectedRows is < 0 or > 1 || (affectedRows == 0 && changed))
        {
            throw new InvalidOperationException("locale_receipt_affected_rows_mismatch");
        }
        if (affectedRows == 0 || !changed)
        {
            return null;
        }
        // xmin is used solely to reject an unrelated transaction's absent-row insert.
        // It is neither persisted as a coordinate nor converted into a source generation.
        if (after is not null && !writtenHere)
        {
            throw new InvalidOperationException("locale_receipt_original_write_required");
        }
        UserLocaleMutationReceipt? original = capture.Original;
        if (original is null)
        {
            if (after is null || after.Revision != checked((capture.Before?.Revision ?? 0) + 1))
            {
                throw new InvalidOperationException("locale_receipt_update_transition_invalid");
            }
        }
        else if (capture.Before != original.After || after != original.Before)
        {
            throw new InvalidOperationException("locale_receipt_compensation_transition_invalid");
        }
        var receipt = new UserLocaleMutationReceipt(capture.ReceiptId, capture.AccountId,
            original is null ? "update" : "compensation", original?.ReceiptId, capture.Before, after);
        await using NpgsqlCommand insert = new("""
            INSERT INTO user_locale_mutation_receipt (
                receipt_id, account_id, mutation_kind, compensates_receipt_id, before_state, after_state)
            VALUES (@Id, @AccountId, @Kind, @Original, @Before, @After)
            ON CONFLICT (receipt_id) DO NOTHING;
            """, connection, transaction);
        insert.Parameters.AddWithValue("Id", receipt.ReceiptId);
        insert.Parameters.AddWithValue("AccountId", receipt.AccountId);
        insert.Parameters.AddWithValue("Kind", receipt.MutationKind);
        insert.Parameters.AddWithValue("Original", NpgsqlDbType.Uuid,
            (object?)receipt.CompensatesReceiptId ?? DBNull.Value);
        AddState(insert, "Before", receipt.Before);
        AddState(insert, "After", receipt.After);
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        UserLocaleMutationReceipt? persisted = await ReadReceiptAsync(
            connection, transaction, receipt.ReceiptId, cancellationToken).ConfigureAwait(false);
        if (persisted != receipt)
        {
            throw new InvalidOperationException("locale_receipt_immutable_replay_mismatch");
        }
        return persisted;
    }

    private static async Task<(UserLocalePreferenceReceiptState? State, bool WrittenHere)> ReadStateAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, int accountId, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT mode, fixed_locale, revision, updated_at, xmin = pg_current_xact_id()::xid
            FROM user_locale_preference WHERE account_id = @AccountId FOR UPDATE;
            """, connection, transaction);
        command.Parameters.AddWithValue("AccountId", accountId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return (null, false);
        }
        return (new UserLocalePreferenceReceiptState(reader.GetString(0),
            reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetInt64(2),
            DateTime.SpecifyKind(reader.GetDateTime(3), DateTimeKind.Utc)), reader.GetBoolean(4));
    }

    private static void AddState(NpgsqlCommand command, string name, UserLocalePreferenceReceiptState? state)
        => command.Parameters.AddWithValue(name, NpgsqlDbType.Jsonb,
            state is null ? DBNull.Value : JsonSerializer.Serialize(state));

    private static async Task<UserLocaleMutationReceipt?> ReadReceiptAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Guid receiptId, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT receipt_id, account_id, mutation_kind, compensates_receipt_id, before_state, after_state
            FROM user_locale_mutation_receipt WHERE receipt_id = @Id;
            """, connection, transaction);
        command.Parameters.AddWithValue("Id", receiptId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        return new UserLocaleMutationReceipt(reader.GetGuid(0), reader.GetInt32(1), reader.GetString(2),
            reader.IsDBNull(3) ? null : reader.GetGuid(3),
            reader.IsDBNull(4) ? null : JsonSerializer.Deserialize<UserLocalePreferenceReceiptState>(reader.GetString(4)),
            reader.IsDBNull(5) ? null : JsonSerializer.Deserialize<UserLocalePreferenceReceiptState>(reader.GetString(5)));
    }
}
