using System.Data.Common;
using System.Runtime.ExceptionServices;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Persists the existing per-extension lifecycle chain in the application's PostgreSQL database.
/// Each operation owns its transaction and verifies the complete chain before returning or appending.
/// Schema migration and host registration belong to the composition owner.
/// </summary>
public sealed class PostgresAuthoringLifecycleReceiptStore(ISqlSugarClient db) : IAuthoringLifecycleReceiptStore
{
    private const string Columns =
        "schema_version, sequence, extension_id, package_sha256, version, state_schema_version, "
        + "data_schema_version, previous_state, state, generation, scope_digest, failure_code, "
        + "previous_receipt_sha256, receipt_sha256";

    public async ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        ValidateExtensionId(extensionId);
        AuthoringLifecycleReceipt? latest = null;
        await ExecuteAsync(extensionId, async () =>
        {
            latest = await ReadChainAsync(extensionId, cancellationToken).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        return latest;
    }

    public async ValueTask AppendAsync(
        AuthoringLifecycleReceipt receipt,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ValidateReceipt(receipt);
        await ExecuteAsync(receipt.ExtensionId, async () =>
        {
            AuthoringLifecycleReceipt? previous = await ReadChainAsync(
                receipt.ExtensionId, cancellationToken).ConfigureAwait(false);
            ValidateSuccessor(previous, receipt);
            cancellationToken.ThrowIfCancellationRequested();
            int inserted = await db.Ado.ExecuteCommandAsync(
                $"INSERT INTO authoring_lifecycle_receipt ({Columns}) VALUES "
                + "(@SchemaVersion, @Sequence, @ExtensionId, @PackageSha256, @Version, @StateSchemaVersion, "
                + "@DataSchemaVersion, @PreviousState, @State, @Generation, @ScopeDigest, @FailureCode, "
                + "@PreviousReceiptSha256, @ReceiptSha256);",
                new SugarParameter("@SchemaVersion", receipt.SchemaVersion),
                new SugarParameter("@Sequence", receipt.Sequence),
                new SugarParameter("@ExtensionId", receipt.ExtensionId),
                new SugarParameter("@PackageSha256", receipt.PackageSha256),
                new SugarParameter("@Version", receipt.Version),
                new SugarParameter("@StateSchemaVersion", receipt.StateSchemaVersion),
                new SugarParameter("@DataSchemaVersion", receipt.DataSchemaVersion),
                new SugarParameter("@PreviousState", (int)receipt.PreviousState),
                new SugarParameter("@State", (int)receipt.State),
                new SugarParameter("@Generation", receipt.Generation),
                new SugarParameter("@ScopeDigest", receipt.ScopeDigest),
                new SugarParameter("@FailureCode", (object?)receipt.FailureCode ?? DBNull.Value),
                new SugarParameter("@PreviousReceiptSha256", receipt.PreviousReceiptSha256),
                new SugarParameter("@ReceiptSha256", receipt.ReceiptSha256)).ConfigureAwait(false);
            if (inserted != 1)
            {
                throw new AuthoringExtensionContractException("Lifecycle receipt append did not insert exactly one row.");
            }
        }, cancellationToken).ConfigureAwait(false);
    }

    private async Task ExecuteAsync(
        string extensionId,
        Func<Task> operation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL || db.Ado.Transaction is not null)
        {
            throw new AuthoringExtensionContractException("Lifecycle receipts require an owned PostgreSQL transaction.");
        }

        CancellationToken? previousCancellationToken = db.Ado.CancellationToken;
        try
        {
            // The operation-scoped client must bind every SQL await, including lock acquisition.
            // UseTranAsync awaits the driver and its non-cancelable rollback before returning.
            db.Ado.CancellationToken = cancellationToken;
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                _ = await db.Ado.ExecuteCommandAsync("SET TRANSACTION ISOLATION LEVEL READ COMMITTED;").ConfigureAwait(false);
                // The lock also covers an empty chain, where SELECT FOR UPDATE cannot exclude another first append.
                _ = await db.Ado.GetScalarAsync(
                    "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                    new SugarParameter("@Identity", $"authoring-lifecycle-receipt:{extensionId}")).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                await operation().ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
            }).ConfigureAwait(false);
            if (!transaction.IsSuccess)
            {
                if (transaction.ErrorException is not null)
                {
                    ExceptionDispatchInfo.Capture(transaction.ErrorException).Throw();
                }
                throw new InvalidOperationException("Lifecycle receipt transaction failed.");
            }
        }
        finally
        {
            db.Ado.CancellationToken = previousCancellationToken;
        }
    }

    private async Task<AuthoringLifecycleReceipt?> ReadChainAsync(
        string extensionId,
        CancellationToken cancellationToken)
    {
        await using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"SELECT {Columns} FROM authoring_lifecycle_receipt WHERE extension_id = @ExtensionId ORDER BY sequence;",
            new SugarParameter("@ExtensionId", extensionId)).ConfigureAwait(false);
        AuthoringLifecycleReceipt? previous = null;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var receipt = new AuthoringLifecycleReceipt(
                reader.GetInt32(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3),
                reader.GetString(4), reader.GetInt32(5), reader.GetInt32(6),
                (AuthoringLifecycleState)reader.GetInt32(7), (AuthoringLifecycleState)reader.GetInt32(8),
                reader.GetInt64(9), reader.GetString(10), reader.IsDBNull(11) ? null : reader.GetString(11),
                reader.GetString(12), reader.GetString(13));
            ValidateReceipt(receipt);
            if (!string.Equals(receipt.ExtensionId, extensionId, StringComparison.Ordinal))
            {
                throw new AuthoringExtensionContractException("Lifecycle receipt extension identity drifted.");
            }
            ValidateSuccessor(previous, receipt);
            previous = receipt;
        }
        return previous;
    }

    private static void ValidateSuccessor(AuthoringLifecycleReceipt? previous, AuthoringLifecycleReceipt receipt)
    {
        if (previous?.Sequence == long.MaxValue || previous?.Generation == long.MaxValue ||
            receipt.Sequence != (previous?.Sequence ?? 0) + 1 ||
            receipt.Generation != (previous?.Generation ?? 0) + 1 ||
            receipt.PreviousState != (previous?.State ?? AuthoringLifecycleState.Installed) ||
            !string.Equals(receipt.PreviousReceiptSha256, previous?.ReceiptSha256 ?? new string('0', 64), StringComparison.Ordinal) ||
            !AuthoringExtensionLifecycleCoordinator.IsTransitionAllowed(receipt.PreviousState, receipt.State))
        {
            throw new AuthoringExtensionContractException("Lifecycle receipt is not the next closed hash-chained generation.");
        }
    }

    private static void ValidateReceipt(AuthoringLifecycleReceipt receipt)
    {
        ValidateExtensionId(receipt.ExtensionId);
        if (receipt.SchemaVersion != 1 || receipt.Sequence < 1 || receipt.Generation != receipt.Sequence ||
            !IsBoundedField(receipt.Version, 256) || receipt.StateSchemaVersion < 1 || receipt.DataSchemaVersion < 1 ||
            !Enum.IsDefined(receipt.PreviousState) || !Enum.IsDefined(receipt.State) ||
            !IsSha256(receipt.PackageSha256) || !IsSha256(receipt.ScopeDigest) ||
            !IsSha256(receipt.PreviousReceiptSha256) || !IsSha256(receipt.ReceiptSha256) ||
            receipt.FailureCode is not null && !IsBoundedField(receipt.FailureCode, 128) ||
            !string.Equals(receipt.ReceiptSha256,
                AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt), StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Lifecycle receipt contains malformed or tampered fields.");
        }
    }

    private static void ValidateExtensionId(string extensionId)
    {
        if (!IsBoundedField(extensionId, 256))
        {
            throw new AuthoringExtensionContractException("Lifecycle receipt extension identity is invalid or unbounded.");
        }
    }

    private static bool IsBoundedField(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && value == value.Trim() &&
        !value.ContainsAny(['\0', '\r', '\n']);

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
