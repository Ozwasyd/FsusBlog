using System.Data;
using System.Diagnostics;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Operations;

internal sealed class InstanceLease : IAsyncDisposable
{
    internal const long OwnershipKey = PublicationLocks.Ownership;
    private const string OwnershipQuery = """
        select exists (
            select from pg_catalog.pg_locks l
            join pg_catalog.pg_stat_activity s on s.pid=l.pid
            where not pg_catalog.pg_is_in_recovery()
              and l.locktype='advisory' and l.database=s.datid and s.datname=current_database()
              and l.pid=$1 and s.backend_start=$2 and l.objsubid=1
              and ((l.classid::bigint << 32) | l.objid::bigint)=$3 and l.mode='ExclusiveLock' and l.granted
        )
        """;
    private static readonly TimeSpan ProbeInterval = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan Validity = TimeSpan.FromSeconds(1);
    private static readonly long ValidityTicks = (long)(Validity.TotalSeconds * Stopwatch.Frequency);
    private const long Pending = -1;
    private const long Expired = -2;
    private readonly NpgsqlConnection _owner;
    private readonly RuntimeEvidence? _evidence;
    private readonly CancellationTokenSource _stopped = new();
    private Task? _monitor;
    private int _pid;
    private DateTime _backendStart;
    private long _validUntil = Pending;

    internal InstanceLease(string connectionString, RuntimeEvidence? evidence = null)
    {
        _evidence = evidence;
        var settings = new NpgsqlConnectionStringBuilder(connectionString)
        {
            Pooling = false, Enlist = false, Multiplexing = false, CommandTimeout = 1, CancellationTimeout = -1
        };
        if (string.IsNullOrEmpty(settings.Host) || settings.Host.Contains(','))
            throw new InvalidOperationException("The single-server publication lease requires one PostgreSQL endpoint.");
        _owner = new NpgsqlConnection(settings.ConnectionString);
    }

    internal bool IsCurrent
    {
        get
        {
            while (true)
            {
                var deadline = Volatile.Read(ref _validUntil);
                if (deadline <= 0) return false;
                if (Stopwatch.GetTimestamp() < deadline) return true;
                if (Interlocked.CompareExchange(ref _validUntil, Expired, deadline) == deadline) return false;
            }
        }
    }

    internal int ObserveAgeMilliseconds()
    {
        while (true)
        {
            var deadline = Volatile.Read(ref _validUntil);
            var now = Stopwatch.GetTimestamp();
            if (deadline <= 0) throw new PublicUnavailableException();
            if (now < deadline) return (int)Stopwatch.GetElapsedTime(deadline - ValidityTicks, now).TotalMilliseconds;
            if (deadline == Volatile.Read(ref _validUntil)) throw new PublicUnavailableException();
        }
    }

    internal CancellationToken Stopped => _stopped.Token;

    internal async Task Start(ILogger log, CancellationToken ct, bool? requireSubscription = null, bool? requireRecoveryKey = null,
        bool? requireAdminInboxReply = null, bool? requireSitePageEditor = null, bool? requireSiteRefresh = null,
        bool? requireAdminArticleRollback = null, bool? requireAdminInboxStatus = null, bool? requireAdminInboxNotice = null, bool? requireAppearanceActivation = null, bool? requireAdminTagMetadata = null, bool? requireAdminInboxRead = null,
        bool? requirePublicationMedia = null)
    {
        await _owner.OpenAsync(ct);
        await using (var acquire = Store.Sql(_owner, null, "select pg_catalog.pg_try_advisory_lock($1)", OwnershipKey))
            if (await acquire.ExecuteScalarAsync(ct) is not true)
                throw new InvalidOperationException("Another v2 server already owns this database.");

        // Wait for already admitted transactions of a previous owner before reading the database.
        await using (var handoff = Store.Sql(_owner, null, "select pg_catalog.pg_advisory_xact_lock($1,$2)",
            PublicationLocks.HandoffClass, PublicationLocks.HandoffObject))
        {
            handoff.CommandTimeout = 5;
            await handoff.ExecuteNonQueryAsync(ct);
        }
        await CurrentSchema.VerifyAsync(_owner, ct, requireSubscription, requireRecoveryKey, requireAdminInboxReply,
            requireSitePageEditor: requireSitePageEditor, requireSiteRefresh: requireSiteRefresh,
            requireAdminArticleRollback: requireAdminArticleRollback, requireAdminInboxStatus: requireAdminInboxStatus, requireAdminInboxNotice: requireAdminInboxNotice, requireAppearanceActivation: requireAppearanceActivation, requireAdminTagMetadata: requireAdminTagMetadata, requireAdminInboxRead: requireAdminInboxRead,
            requirePublicationMedia: requirePublicationMedia);
        _pid = _owner.ProcessID;
        await using (var identity = new NpgsqlCommand("select backend_start from pg_catalog.pg_stat_activity where pid=pg_backend_pid()", _owner))
            _backendStart = (DateTime)(await identity.ExecuteScalarAsync(ct))!;
        var observedAt = Stopwatch.GetTimestamp();
        if (!await Owns(_owner, null, ct) || Stopwatch.GetElapsedTime(observedAt) >= Validity)
            throw new InvalidOperationException("The dedicated PostgreSQL session did not confirm lease ownership.");
        if (Interlocked.CompareExchange(ref _validUntil, observedAt + ValidityTicks, Pending) != Pending)
            throw new InvalidOperationException("The PostgreSQL lease has already stopped.");
        _monitor = Monitor(log);
        // Allow the old process's last successful heartbeat interval to expire before accepting HTTP.
        await Task.Delay(Validity, ct);
        RequireCurrent();
    }

    internal void RequireCurrent()
    {
        if (!IsCurrent) throw new PublicUnavailableException();
    }

    internal static async Task<NpgsqlTransaction> BeginProtected(NpgsqlConnection db, InstanceLease? lease,
        CancellationToken ct, IsolationLevel isolation = IsolationLevel.ReadCommitted)
    {
        lease?.RequireCurrent();
        var transaction = await db.BeginTransactionAsync(isolation, ct);
        try
        {
            if (lease is not null)
            {
                await using var handoff = Store.Sql(db, transaction, "select pg_catalog.pg_advisory_xact_lock_shared($1,$2)",
                    PublicationLocks.HandoffClass, PublicationLocks.HandoffObject);
                handoff.CommandTimeout = 1;
                await handoff.ExecuteNonQueryAsync(ct);
                if (!await lease.Owns(db, transaction, ct))
                {
                    lease.Stop();
                    throw new PublicUnavailableException();
                }
                lease.RequireCurrent();
            }
            return transaction;
        }
        catch
        {
            await transaction.DisposeAsync();
            throw;
        }
    }

    internal static async Task CommitProtected(NpgsqlTransaction transaction, InstanceLease? lease, CancellationToken ct)
    {
        lease?.RequireCurrent();
        await transaction.CommitAsync(ct);
        lease?.RequireCurrent();
    }

    internal void Stop()
    {
        if (Interlocked.Exchange(ref _validUntil, 0) != 0)
            _stopped.Cancel();
    }

    public async ValueTask DisposeAsync()
    {
        Stop();
        if (_monitor is not null) await _monitor;
        await _owner.DisposeAsync();
        _stopped.Dispose();
    }

    private async Task<bool> Owns(NpgsqlConnection connection, NpgsqlTransaction? transaction, CancellationToken ct)
    {
        await using var proof = Store.Sql(connection, transaction, OwnershipQuery, _pid, _backendStart, OwnershipKey);
        proof.CommandTimeout = 1;
        return await proof.ExecuteScalarAsync(ct) is true;
    }

    private async Task Monitor(ILogger log)
    {
        using var attribution = _evidence?.LeaseWork();
        using var timer = new PeriodicTimer(ProbeInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(Stopped))
            {
                var deadline = Volatile.Read(ref _validUntil);
                var started = Stopwatch.GetTimestamp();
                if (deadline <= 0 || started >= deadline || !await Owns(_owner, null, Stopped) ||
                    Stopwatch.GetTimestamp() >= deadline ||
                    Interlocked.CompareExchange(ref _validUntil, started + ValidityTicks, deadline) != deadline)
                    break;
            }
        }
        catch (OperationCanceledException) when (Stopped.IsCancellationRequested) { }
        catch (Exception error) when (!Stopped.IsCancellationRequested)
        {
            log.LogError(error, "PostgreSQL publication lease heartbeat failed.");
        }
        finally
        {
            var stopped = Stopped.IsCancellationRequested;
            Stop();
            if (!stopped)
            {
                log.LogError("PostgreSQL publication lease lost. Requests are disabled until the process is restarted.");
                await _owner.CloseAsync();
            }
        }
    }
}
