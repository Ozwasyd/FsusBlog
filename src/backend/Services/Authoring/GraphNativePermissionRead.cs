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
    private int _entered;
    internal CancellationToken PriorCancellation
    {
        get; private set;
    }

    internal IDisposable Enter(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Require(Interlocked.CompareExchange(ref _entered, 1, 0) == 0);
        try
        {
            Validate(token);
            PriorCancellation = db.Ado.CancellationToken ?? default;
            PriorCancellation.ThrowIfCancellationRequested();
            return new Borrow(this);
        }
        catch
        {
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
        Require((db.Ado.CancellationToken ?? default) == PriorCancellation);
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
        public void Dispose() => Interlocked.Exchange(ref owner._entered, 0);
    }
}
