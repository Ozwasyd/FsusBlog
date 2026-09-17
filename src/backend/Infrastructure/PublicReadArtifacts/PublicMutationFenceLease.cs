using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;

using Microsoft.Extensions.Options;

using Npgsql;

using NpgsqlTypes;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public interface IPublicMutationFenceLease : IAsyncDisposable
{
    Task AcquireAsync(int articleId, CancellationToken cancellationToken = default);
    Task ReleaseAsync(int articleId, CancellationToken cancellationToken = default);
}

public sealed class PostgresPublicMutationFenceLease(
    IConfiguration configuration,
    IRuntimeKeyScope runtimeKeyScope,
    ILogger<PostgresPublicMutationFenceLease> logger) : IPublicMutationFenceLease
{
    private readonly Dictionary<int, HeldLease> _connections = [];
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task AcquireAsync(int articleId, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_connections.ContainsKey(articleId))
            {
                throw new InvalidOperationException("public mutation fence lease is already held by this scope");
            }

            string lockScope = PublicMutationFenceAdvisoryLock.ResolveScope(runtimeKeyScope);
            NpgsqlConnection? connection = await PublicMutationFenceAdvisoryLock
                .TryAcquireAsync(configuration, lockScope, articleId, cancellationToken)
                .ConfigureAwait(false);
            if (connection is null)
            {
                throw new InvalidOperationException("public mutation fence writer lock is already active");
            }

            _connections.Add(articleId, new HeldLease(lockScope, connection));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ReleaseAsync(int articleId, CancellationToken cancellationToken = default)
    {
        HeldLease? lease;
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!_connections.Remove(articleId, out lease))
            {
                return;
            }
        }
        finally
        {
            _gate.Release();
        }

        await PublicMutationFenceAdvisoryLock
            .ReleaseAndDisposeAsync(lease.Connection, lease.LockScope, articleId, logger, cancellationToken)
            .ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        KeyValuePair<int, HeldLease>[] held;
        await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            held = _connections.ToArray();
            _connections.Clear();
        }
        finally
        {
            _gate.Release();
        }

        foreach ((int articleId, HeldLease lease) in held)
        {
            try
            {
                await PublicMutationFenceAdvisoryLock
                    .ReleaseAndDisposeAsync(
                        lease.Connection,
                        lease.LockScope,
                        articleId,
                        logger,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "public-mutation-fence-lease-dispose-failed {ArticleId}", articleId);
            }
        }

        _gate.Dispose();
    }

    private sealed record HeldLease(string LockScope, NpgsqlConnection Connection);
}

internal static class PublicMutationFenceAdvisoryLock
{
    private const string LockScopeKey = "public-mutation-fence-lock";

    public static string ResolveScope(IRuntimeKeyScope runtimeKeyScope)
        => runtimeKeyScope.PrefixKey(LockScopeKey);

    public static async Task<NpgsqlConnection?> TryAcquireAsync(
        IConfiguration configuration,
        string lockScope,
        int articleId,
        CancellationToken cancellationToken)
    {
        NpgsqlConnection connection = CreateConnection(configuration);
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            await using var command = new NpgsqlCommand(
                "SELECT pg_try_advisory_lock(hashtext(@lock_scope), @article_id);",
                connection);
            command.Parameters.AddWithValue("lock_scope", NpgsqlDbType.Text, lockScope);
            command.Parameters.AddWithValue("article_id", NpgsqlDbType.Integer, articleId);
            bool acquired = (bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false)
                ?? false);
            if (acquired)
            {
                return connection;
            }
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }

        await connection.DisposeAsync().ConfigureAwait(false);
        return null;
    }

    public static async Task ReleaseAndDisposeAsync(
        NpgsqlConnection connection,
        string lockScope,
        int articleId,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        bool unlocked = false;
        try
        {
            await using var command = new NpgsqlCommand(
                "SELECT pg_advisory_unlock(hashtext(@lock_scope), @article_id);",
                connection);
            command.Parameters.AddWithValue("lock_scope", NpgsqlDbType.Text, lockScope);
            command.Parameters.AddWithValue("article_id", NpgsqlDbType.Integer, articleId);
            unlocked = (bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false)
                ?? false);
            if (!unlocked)
            {
                throw new InvalidOperationException("public mutation fence advisory lock was not owned by this session");
            }
        }
        catch
        {
            NpgsqlConnection.ClearPool(connection);
            throw;
        }
        finally
        {
            if (!unlocked)
            {
                logger.LogWarning(
                    "public-mutation-fence-connection-discarded-without-explicit-unlock {ArticleId}",
                    articleId);
            }

            await connection.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static NpgsqlConnection CreateConnection(IConfiguration configuration)
    {
        string connectionString = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("ConnectionStrings:DefaultConnection is required for public mutation fencing");
        var builder = new NpgsqlConnectionStringBuilder(
            SqlSugarInitializer.NormalizeConnectionString(connectionString))
        {
            Multiplexing = false,
            Enlist = false,
            ApplicationName = "FsusBlog.PublicMutationFence"
        };
        return new NpgsqlConnection(builder.ConnectionString);
    }
}

public sealed class PublicMutationFenceRecoveryWorker(
    IConfiguration configuration,
    IRuntimeKeyScope runtimeKeyScope,
    IPublicArtifactRevocationStateStore stateStore,
    IPublicArtifactRevocationCoordinator revocations,
    PublicHotArtifactUpdateQueue updateQueue,
    IOptions<PublicArtifactRevocationOptions> options,
    ILogger<PublicMutationFenceRecoveryWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RecoverOnceAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "public-mutation-fence-recovery-cycle-failed");
            }

            TimeSpan interval = TimeSpan.FromSeconds(
                Math.Clamp(options.Value.MutationFenceRecoveryIntervalSeconds, 1, 300));
            await Task.Delay(interval, stoppingToken).ConfigureAwait(false);
        }
    }

    public async Task<int> RecoverOnceAsync(CancellationToken cancellationToken)
    {
        int recovered = 0;
        string lockScope = PublicMutationFenceAdvisoryLock.ResolveScope(runtimeKeyScope);
        IReadOnlyList<PublicArtifactTombstone> active = await stateStore
            .LoadActiveAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (PublicArtifactTombstone tombstone in active.Where(static item => item.TransitionPending))
        {
            NpgsqlConnection? connection = await PublicMutationFenceAdvisoryLock
                .TryAcquireAsync(configuration, lockScope, tombstone.ArticleId, cancellationToken)
                .ConfigureAwait(false);
            if (connection is null)
            {
                continue;
            }

            try
            {
                bool promoted = await revocations
                    .RecoverPendingMutationFenceAsync(tombstone, cancellationToken)
                    .ConfigureAwait(false);
                if (!promoted)
                {
                    continue;
                }

                PublicHotArtifactEnqueueResult enqueue = await updateQueue.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.RequiredContent,
                    tombstone.ArticleId > 0 ? tombstone.ArticleId : null,
                    "public-mutation-fence-owner-ended",
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                PublicHotArtifactDeliveryReceipt.RequireDurable(enqueue, "mutation-fence-recovery");
                recovered++;
            }
            finally
            {
                await PublicMutationFenceAdvisoryLock
                    .ReleaseAndDisposeAsync(
                        connection,
                        lockScope,
                        tombstone.ArticleId,
                        logger,
                        CancellationToken.None)
                    .ConfigureAwait(false);
            }
        }

        return recovered;
    }
}
