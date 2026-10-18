using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Borrows the actual JWT producer's registered request authority. Nested Canvas calls own
/// only linked cancellation, never the enclosing authenticated lifetime. No claims-only or
/// session-ID acquisition path exists here.
/// </summary>
public sealed class AuthoringCanvasRequestLifetime(
    ISqlSugarClient? db = null,
    IHttpContextAccessor? contexts = null)
{
    private static readonly ConditionalWeakTable<ISqlSugarClient, SemaphoreSlim> s_publicationGates = new();

    internal Borrow Acquire(AuthoringCanvasOwner owner, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HttpContext context = (contexts ?? new HttpContextAccessor()).HttpContext
            ?? throw new AuthoringCanvasAccessDeniedException();
        if (context.Features.Get<IAdminAuthenticatedRequestFeature>() is not AdminAuthenticatedRequestFeature feature
            || context.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long principalId)
            || principalId != owner.AdminPrincipalId)
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
        AdminRequestBinding binding = feature.Lifetime.RequireBinding();
        if (binding.PrincipalId != owner.AdminPrincipalId
            || !string.Equals(context.User.GetAdminSessionId(), binding.SessionId, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
        CancellationToken previous = (db ?? context.RequestServices.GetService<ISqlSugarClient>())
            ?.Ado.CancellationToken ?? CancellationToken.None;
        var borrow = new Borrow(context, feature, cancellationToken, previous);
        try
        {
            borrow.EnsureCurrent();
            return borrow;
        }
        catch
        {
            borrow.Dispose();
            throw;
        }
    }

    internal IDisposable BindDatabaseCancellation(Borrow borrow)
        => new DatabaseCancellation(Database(borrow), borrow.Token);

    internal async Task<T> PublishAsync<T>(
        Borrow borrow,
        Func<CancellationToken, Task<T>> read,
        Action<T>? publish = null)
    {
        ISqlSugarClient database = Database(borrow);
        DbConnection connection = database.Ado.Connection as DbConnection
            ?? throw new InvalidOperationException("canvas_request_native_connection_required");
        SemaphoreSlim gate = s_publicationGates.GetValue(database, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(borrow.Token).ConfigureAwait(false);
        IDbTransaction? previousTransaction = database.Ado.Transaction;
        CancellationToken? previousToken = database.Ado.CancellationToken;
        bool opened = connection.State != ConnectionState.Open;
        try
        {
            borrow.EnsureCurrent();
            if (opened)
            {
                await connection.OpenAsync(borrow.Token).ConfigureAwait(false);
            }
            T result = default!;
            if (previousTransaction is DbTransaction existing)
            {
                database.Ado.CancellationToken = borrow.Token;
                await borrow.Lifetime.VerifyAndFenceAsync(connection, existing, borrow.Token).ConfigureAwait(false);
                result = await read(borrow.Token).ConfigureAwait(false);
                await borrow.Lifetime.VerifyAndFenceAsync(connection, existing, borrow.Token).ConfigureAwait(false);
                borrow.EnsureCurrent();
                publish?.Invoke(result);
                borrow.EnsureCurrent();
            }
            else
            {
                if (previousTransaction is not null)
                {
                    throw new InvalidOperationException("canvas_request_native_transaction_required");
                }
                await borrow.Lifetime.PublishReadAsync(
                    connection,
                    async (_, transaction, token) =>
                    {
                        database.Ado.Transaction = transaction;
                        database.Ado.CancellationToken = token;
                        return await read(token).ConfigureAwait(false);
                    },
                    (value, _) =>
                    {
                        borrow.EnsureCurrent();
                        publish?.Invoke(value);
                        borrow.EnsureCurrent();
                        result = value;
                        return Task.CompletedTask;
                    },
                    borrow.Token).ConfigureAwait(false);
            }
            borrow.EnsureCurrent();
            return result;
        }
        finally
        {
            database.Ado.Transaction = previousTransaction;
            database.Ado.CancellationToken = previousToken;
            try
            {
                if (opened)
                {
                    await connection.CloseAsync().ConfigureAwait(false);
                }
            }
            finally
            {
                gate.Release();
            }
        }
    }

    internal async Task FenceTransactionAsync(Borrow borrow)
    {
        ISqlSugarClient database = Database(borrow);
        DbConnection connection = database.Ado.Connection as DbConnection
            ?? throw new InvalidOperationException("canvas_request_native_connection_required");
        DbTransaction transaction = database.Ado.Transaction as DbTransaction
            ?? throw new InvalidOperationException("canvas_request_native_transaction_required");
        await borrow.Lifetime.VerifyAndFenceAsync(connection, transaction, borrow.Token).ConfigureAwait(false);
        borrow.EnsureCurrent();
    }

    private ISqlSugarClient Database(Borrow borrow)
        => db ?? borrow.Context.RequestServices.GetService<ISqlSugarClient>()
            ?? throw new AuthoringCanvasAccessDeniedException();

    internal sealed class Borrow : IDisposable
    {
        private readonly AdminAuthenticatedRequestFeature _feature;
        private readonly CancellationTokenSource _linked;

        internal Borrow(HttpContext context, AdminAuthenticatedRequestFeature feature, CancellationToken caller,
            CancellationToken databaseCancellation)
        {
            Context = context;
            _feature = feature;
            _linked = CancellationTokenSource.CreateLinkedTokenSource(
                caller, context.RequestAborted, feature.Lifetime.Invalidated, databaseCancellation);
        }

        internal HttpContext Context
        {
            get;
        }
        internal AdminAuthenticatedRequestLifetime Lifetime => _feature.Lifetime;
        internal CancellationToken Token => _linked.Token;
        internal string BindingDigest => Lifetime.BindingDigest;

        internal void EnsureCurrent()
        {
            Token.ThrowIfCancellationRequested();
            if (!ReferenceEquals(Context.Features.Get<IAdminAuthenticatedRequestFeature>(), _feature))
            {
                throw new AuthoringCanvasAccessDeniedException();
            }
            AdminRequestBinding binding = Lifetime.RequireBinding();
            if (Context.User.Identity?.IsAuthenticated != true || !Context.User.IsAdminPrincipal()
                || !Context.User.TryGetAdminPrincipalId(out long principalId) || principalId != binding.PrincipalId
                || !string.Equals(Context.User.GetAdminSessionId(), binding.SessionId, StringComparison.Ordinal))
            {
                throw new AuthoringCanvasAccessDeniedException();
            }
        }

        public void Dispose() => _linked.Dispose();
    }

    private sealed class DatabaseCancellation : IDisposable
    {
        private readonly ISqlSugarClient _database;
        private readonly CancellationToken? _previous;
        private readonly CancellationTokenSource _linked;

        internal DatabaseCancellation(ISqlSugarClient database, CancellationToken token)
        {
            _database = database;
            _previous = database.Ado.CancellationToken;
            _linked = CancellationTokenSource.CreateLinkedTokenSource(_previous ?? CancellationToken.None, token);
            database.Ado.CancellationToken = _linked.Token;
        }

        public void Dispose()
        {
            _database.Ado.CancellationToken = _previous;
            _linked.Dispose();
        }
    }
}
