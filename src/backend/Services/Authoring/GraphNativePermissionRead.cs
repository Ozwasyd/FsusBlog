using System.Data;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Borrows one concrete permission supplier and its exact caller session for allocated reads.
/// This establishes custody and accounting only; Pin's article.write policy is not a complete
/// Graph privacy policy. It supplies no host admission, grant, transaction or connection owner.
/// </summary>
internal sealed class GraphNativePermissionRead(ISqlSugarClient db, SqlAuthorArticlePinPermissionAuthority permissions)
{
    private NpgsqlConnection? _connection;
    private NpgsqlTransaction? _transaction;
    private bool _captured;
    private int _backendId;
    private string? _transactionId;
    private int _entered;
    private CancellationToken _priorCancellation;

    internal IDisposable Enter(CancellationToken token, out CancellationToken priorCancellation)
    {
        priorCancellation = default;
        token.ThrowIfCancellationRequested();
        Require(Interlocked.CompareExchange(ref _entered, 1, 0) == 0);
        try
        {
            // Capture after acquiring our gate, before custody can refuse. The out value
            // belongs to this invocation and survives disposal for cancellation attribution.
            priorCancellation = db.Ado.CancellationToken ?? default;
            token.ThrowIfCancellationRequested();
            priorCancellation.ThrowIfCancellationRequested();
            Validate(token);
            _priorCancellation = priorCancellation;
            return new Borrow(this);
        }
        catch
        {
            _priorCancellation = default;
            Interlocked.Exchange(ref _entered, 0);
            throw;
        }
    }

    internal void Validate(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Require(permissions.IsBoundTo(db) && System.Transactions.Transaction.Current is null
            && db.CurrentConnectionConfig.DbType == SqlSugar.DbType.PostgreSQL
            && !db.CurrentConnectionConfig.IsAutoCloseConnection
            && db.Ado.Connection is NpgsqlConnection { State: ConnectionState.Open }
            && (db.Ado.Transaction is null || db.Ado.Transaction is NpgsqlTransaction));
        var connection = (NpgsqlConnection)db.Ado.Connection;
        var transaction = db.Ado.Transaction as NpgsqlTransaction;
        if (!_captured)
        {
            _connection = connection;
            _backendId = connection.ProcessID;
            _transaction = transaction;
            _captured = true;
        }
        Require(ReferenceEquals(_connection, connection) && _backendId == connection.ProcessID
            && ReferenceEquals(_transaction, transaction)
            && (transaction is null || transaction.IsolationLevel == IsolationLevel.ReadCommitted
                && ReferenceEquals(transaction.Connection, connection)));
    }

    internal void ObserveSession(SqlArticleGraphPersistedMetadataReader.SessionStamp stamp)
    {
        // Npgsql can reuse the same transaction object after caller rollback/begin. Keep
        // the server incarnation across batches and Verify, not just the CLR reference.
        if (stamp.CallerTransaction)
        {
            Require(_transactionId is null || _transactionId == stamp.TransactionId);
            _transactionId ??= stamp.TransactionId;
        }
    }

    internal async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
        AuthorArticlePinPermissionBatchRequest request, Action take, CancellationToken token)
    {
        Validate(token);
        AuthorArticlePinPermissionSnapshot result = await permissions.ResolveAllocatedAsync(request, token, () =>
        {
            Validate(token);
            take();
        }).ConfigureAwait(false);
        Validate(token);
        Require((db.Ado.CancellationToken ?? default) == _priorCancellation);
        return result;
    }

    private static void Require(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException("graph_metadata_unavailable");
        }
    }

    private sealed class Borrow(GraphNativePermissionRead owner) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                owner._priorCancellation = default;
                Interlocked.Exchange(ref owner._entered, 0);
            }
        }
    }
}
