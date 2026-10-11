using System.Data;
using System.Runtime.ExceptionServices;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Services.Authoring;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    Task<TResult> IAuthorArticleQuerySourceReader.ReadInSnapshotAsync<TResult>(
        Func<IAuthorArticleQuerySourceReader, CancellationToken, Task<TResult>> read,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(read);
        CancellationToken effective = ResolveCancellationToken(cancellationToken);
        effective.ThrowIfCancellationRequested();
        return _dbConcurrencyGate.ExecuteClassifiedAsync(
            DbWorkloadClass.AdminHeavyRead,
            "author-article-query-source-snapshot",
            async gateCt =>
            {
                gateCt.ThrowIfCancellationRequested();
                RequireSnapshotClient(_db);
                // Data gets a separate client. The original live permission authority must
                // never inherit this transaction's historical session/permission snapshot.
                using SqlSugarClient snapshotDb = _db.CopyNew();
                return await ReadQuerySnapshotCoreAsync(snapshotDb, read, gateCt).ConfigureAwait(false);
            },
            _ => Task.FromException<TResult>(
                new TimeoutException("db-gate-timeout:author-article-query-source-snapshot")),
            effective);
    }

    /// <summary>The production entry owns the isolated client and gate; tests substitute only its ADO.</summary>
    internal async Task<TResult> ReadQuerySnapshotCoreAsync<TResult>(
        ISqlSugarClient snapshotDb,
        Func<IAuthorArticleQuerySourceReader, CancellationToken, Task<TResult>> read,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(snapshotDb);
        ArgumentNullException.ThrowIfNull(read);
        cancellationToken.ThrowIfCancellationRequested();
        RequireSnapshotClient(_db);
        RequireSnapshotClient(snapshotDb);
        if (ReferenceEquals(_db, snapshotDb) || ReferenceEquals(_db.Ado, snapshotDb.Ado)
            || snapshotDb.Ado.Connection is null
            || ReferenceEquals(_db.Ado.Connection, snapshotDb.Ado.Connection))
        {
            throw new InvalidOperationException("author_article_query_source_snapshot_requires_isolated_client");
        }
        CancellationToken? previousCancellation = snapshotDb.Ado.CancellationToken;
        using var ownedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        CancellationToken scopeToken = ownedCancellation.Token;
        SnapshotReaderLease? lease = null;
        bool started = false;
        snapshotDb.Ado.CancellationToken = scopeToken;
        try
        {
            await snapshotDb.Ado.BeginTranAsync(IsolationLevel.RepeatableRead).ConfigureAwait(false);
            started = true;
            IDbTransaction? transaction = snapshotDb.Ado.Transaction;
            if (transaction is null || transaction.IsolationLevel != IsolationLevel.RepeatableRead
                || transaction.Connection is null
                || !ReferenceEquals(transaction.Connection, snapshotDb.Ado.Connection))
            {
                throw new InvalidOperationException("author_article_query_source_snapshot_transaction_invalid");
            }
            scopeToken.ThrowIfCancellationRequested();
            await snapshotDb.Ado.ExecuteCommandAsync("SET TRANSACTION READ ONLY;").ConfigureAwait(false);
            scopeToken.ThrowIfCancellationRequested();
            // This is still the same ArticleService SQL owner, with the same bounded
            // projections and input validation. No second SQL/index/ranking path exists.
            lease = new(CreateSnapshotSource(snapshotDb), snapshotDb.Ado, scopeToken, () =>
            {
                if (!ReferenceEquals(snapshotDb.Ado.Transaction, transaction)
                    || !ReferenceEquals(transaction.Connection, snapshotDb.Ado.Connection)
                    || transaction.IsolationLevel != IsolationLevel.RepeatableRead)
                {
                    throw new InvalidOperationException("author_article_query_source_snapshot_transaction_changed");
                }
            });
            TResult result = await read(lease, scopeToken).ConfigureAwait(false);
            scopeToken.ThrowIfCancellationRequested();
            if (await lease.CloseAsync(ownedCancellation.Cancel).ConfigureAwait(false))
            {
                throw new InvalidOperationException("author_article_query_source_snapshot_read_not_awaited");
            }
            lease.ThrowIfReadFailed();
            return result;
        }
        finally
        {
            try
            {
                try
                {
                    ownedCancellation.Cancel();
                }
                finally
                {
                    if (lease is not null)
                    {
                        _ = await lease.CloseAsync().ConfigureAwait(false);
                    }
                }
            }
            finally
            {
                try
                {
                    // Cancellation cannot skip rollback of an owned read-only transaction.
                    // This follows the original ADO cleanup convention; no commit is issued.
                    snapshotDb.Ado.CancellationToken = null;
                    if (started || snapshotDb.Ado.Transaction is not null)
                    {
                        await snapshotDb.Ado.RollbackTranAsync().ConfigureAwait(false);
                    }
                }
                finally
                {
                    snapshotDb.Ado.CancellationToken = previousCancellation;
                }
            }
        }
    }

    private static void RequireSnapshotClient(ISqlSugarClient db)
    {
        if (System.Transactions.Transaction.Current is not null)
        {
            throw new InvalidOperationException("author_article_query_source_snapshot_ambient_transaction_unavailable");
        }
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL)
        {
            throw new NotSupportedException("author_article_query_source_snapshot_provider_unavailable");
        }
        if (db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("author_article_query_source_snapshot_requires_fresh_transaction");
        }
    }

    private IAuthorArticleQuerySourceReader CreateSnapshotSource(ISqlSugarClient snapshotDb)
        => new ArticleService(snapshotDb, _searchIndex, _redisOperations, _cacheReader, _cacheWriter,
            _stringReader, _stringWriter, _cacheMissCoordinator, _dbConcurrencyGate, _runtimeKeyScope,
            _httpContextAccessor, _logger, _publicAotInvalidationService, _cacheInvalidationDispatcher,
            _mutationFence, _mutationSideEffects, _viewWriteBuffer, _publicationValidator, _articleBodyRepairQueue,
            _timeProvider, _vaultAuditLogStore, _vaultExecutionStore, _vaultGroupResultStore,
            _articleDetailViewProjection, _articleListCursorCodec, _articleViewProjectionObligations);

    private sealed class SnapshotReaderLease(
        IAuthorArticleQuerySourceReader source,
        IAdo snapshotAdo,
        CancellationToken scopeToken,
        Action requireTransaction) : IAuthorArticleQuerySourceReader
    {
        private readonly object _sync = new();
        private bool _closed;
        private TaskCompletionSource? _readFinished;
        private ExceptionDispatchInfo? _readFailure;

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses,
            CancellationToken cancellationToken)
            => ReadAsync(token => source.ReadCoordinatesAsync(statuses, token), cancellationToken);

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesAfterAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses,
            int afterArticleId,
            CancellationToken cancellationToken)
            => ReadAsync(token => source.ReadCoordinatesAfterAsync(statuses, afterArticleId, token), cancellationToken);

        public Task<AuthorArticleQuerySourceBatch> ReadCoordinatesForIdsAsync(
            IReadOnlyList<AuthorArticleQueryStatus> statuses,
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken)
            => ReadAsync(token => source.ReadCoordinatesForIdsAsync(statuses, articleIds, token), cancellationToken);

        public Task<IReadOnlyList<AuthorArticleQuerySourceFields>> ReadFieldsAsync(
            IReadOnlyList<int> admittedArticleIds,
            CancellationToken cancellationToken)
            => ReadAsync(token => source.ReadFieldsAsync(admittedArticleIds, token), cancellationToken);

        private Task<TResult> ReadAsync<TResult>(Func<CancellationToken, Task<TResult>> read, CancellationToken readToken)
        {
            lock (_sync)
            {
                ObjectDisposedException.ThrowIf(_closed, this);
                if (_readFinished is not null)
                {
                    throw new InvalidOperationException("author_article_query_source_snapshot_concurrent_read");
                }
                _readFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
            }
            Task<TResult> result = ReadCoreAsync(read, readToken);
            _ = ObserveReadFailureAsync(result);
            return result;
        }

        private static async Task ObserveReadFailureAsync(Task read)
        {
            try
            {
                await read.ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Observe even a discarded, already-completed Task. ReadCore retains
                // its first failure separately so callback success cannot hide it.
            }
        }

        internal void ThrowIfReadFailed()
        {
            ExceptionDispatchInfo? failure;
            lock (_sync)
            {
                failure = _readFailure;
            }
            failure?.Throw();
        }

        private async Task<TResult> ReadCoreAsync<TResult>(
            Func<CancellationToken, Task<TResult>> read,
            CancellationToken readToken)
        {
            try
            {
                using CancellationTokenSource? linked = readToken.CanBeCanceled && readToken != scopeToken
                    ? CancellationTokenSource.CreateLinkedTokenSource(scopeToken, readToken) : null;
                CancellationToken effective = linked?.Token ?? scopeToken;
                CancellationToken? previousCancellation = snapshotAdo.CancellationToken;
                try
                {
                    snapshotAdo.CancellationToken = effective;
                    effective.ThrowIfCancellationRequested();
                    requireTransaction();
                    TResult result = await read(effective).ConfigureAwait(false);
                    effective.ThrowIfCancellationRequested();
                    requireTransaction();
                    return result;
                }
                finally
                {
                    snapshotAdo.CancellationToken = previousCancellation;
                }
            }
            catch (Exception error)
            {
                lock (_sync)
                {
                    _readFailure ??= ExceptionDispatchInfo.Capture(error);
                }
                throw;
            }
            finally
            {
                TaskCompletionSource finished;
                lock (_sync)
                {
                    finished = _readFinished!;
                    _readFinished = null;
                }
                finished.SetResult();
            }
        }

        internal async Task<bool> CloseAsync(Action? cancelPending = null)
        {
            Task? pending;
            lock (_sync)
            {
                _closed = true;
                pending = _readFinished?.Task;
            }
            if (pending is not null)
            {
                try
                {
                    cancelPending?.Invoke();
                }
                finally
                {
                    await pending.ConfigureAwait(false);
                }
            }
            return pending is not null;
        }
    }
}
