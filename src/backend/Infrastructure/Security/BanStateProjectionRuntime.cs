using System.Data.Common;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Distributed;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Reports one completed authority scan, not a count of newly inserted entries alone.</summary>
/// <param name="RowsRead">Rows visited, including rows subsequently dropped.</param>
/// <param name="Applied">Facts applied or rejected as already duplicate or stale.</param>
/// <param name="Dropped">Rows with missing subjects, unsupported statuses or other rejected applications.</param>
/// <param name="Commands">Keyset queries issued, including the terminating query when needed.</param>
public readonly record struct BanStateProjectionAuthorityLoadResult(
    int RowsRead,
    int Applied,
    int Dropped,
    int Commands);

/// <summary>
/// Exposes process-local initialization status and cumulative diagnostics, not authority facts
/// or proof of cross-node convergence. Counters may advance independently of the status snapshot.
/// </summary>
/// <param name="Ready">Whether the most recently recorded authority-load outcome succeeded.</param>
/// <param name="Degraded">Whether that outcome dropped rows or failed.</param>
/// <param name="Detail">Load counts or the failure exception type; not an authorization decision.</param>
/// <param name="AuthorityLoadCommands">Cumulative commands from completed authority loads.</param>
/// <param name="AuthorityLoadRows">Cumulative rows from completed authority loads.</param>
/// <param name="LocalMutationUpdates">Local mutation applications recorded by the coordinator, including stale or duplicate facts.</param>
/// <param name="DurableEventsPrepared">Recorded successful outbox preparations, not committed or delivered events.</param>
/// <param name="DurablePublishFailures">Recorded degraded publication results or publication exceptions.</param>
public readonly record struct BanStateProjectionRuntimeSnapshot(
    bool Ready,
    bool Degraded,
    string Detail,
    long AuthorityLoadCommands,
    long AuthorityLoadRows,
    long LocalMutationUpdates,
    long DurableEventsPrepared,
    long DurablePublishFailures);

/// <summary>
/// Owns local load status and cumulative counters. Status fields share a lock; counter updates
/// are independent and do not establish transaction commit, delivery or expiry guarantees.
/// </summary>
public sealed class BanStateProjectionRuntimeState
{
    private readonly object _sync = new();
    private bool _ready;
    private bool _degraded;
    private string _detail = "not_initialized";
    private long _authorityLoadCommands;
    private long _authorityLoadRows;
    private long _localMutationUpdates;
    private long _durableEventsPrepared;
    private long _durablePublishFailures;

    /// <summary>
    /// Records a completed scan as ready, marking it degraded when any rows were dropped.
    /// A later successful load replaces failure status; cumulative load counters are retained.
    /// </summary>
    /// <param name="result">The completed scan's row, disposition and command counts.</param>
    public void RecordAuthorityLoad(BanStateProjectionAuthorityLoadResult result)
    {
        Interlocked.Add(ref _authorityLoadCommands, result.Commands);
        Interlocked.Add(ref _authorityLoadRows, result.RowsRead);
        lock (_sync)
        {
            _ready = true;
            _degraded = result.Dropped > 0;
            _detail = $"rows:{result.RowsRead};applied:{result.Applied};dropped:{result.Dropped};commands:{result.Commands}";
        }
    }

    /// <summary>Marks initialization not ready and degraded without clearing projection entries or counters.</summary>
    /// <param name="exception">The load failure whose type, but not message, is retained in diagnostics.</param>
    public void RecordAuthorityLoadFailure(Exception exception)
    {
        lock (_sync)
        {
            _ready = false;
            _degraded = true;
            _detail = $"authority_load_failed:{exception.GetType().Name}";
        }
    }

    /// <summary>Records one accepted local mutation application, not a new generation or transaction acknowledgement.</summary>
    public void RecordLocalMutation() => Interlocked.Increment(ref _localMutationUpdates);

    /// <summary>Records successful outbox preparation without claiming authority commit or remote delivery.</summary>
    public void RecordDurablePrepared() => Interlocked.Increment(ref _durableEventsPrepared);

    /// <summary>Records degraded publication without changing readiness, retrying or completing an obligation.</summary>
    public void RecordPublishFailure() => Interlocked.Increment(ref _durablePublishFailures);

    /// <summary>Reads locked load status and independently sampled cumulative counters for diagnostics.</summary>
    /// <returns>A local snapshot; it is neither an authorization result nor an atomic cross-counter observation.</returns>
    public BanStateProjectionRuntimeSnapshot Snapshot()
    {
        lock (_sync)
        {
            return new BanStateProjectionRuntimeSnapshot(
                _ready,
                _degraded,
                _detail,
                Volatile.Read(ref _authorityLoadCommands),
                Volatile.Read(ref _authorityLoadRows),
                Volatile.Read(ref _localMutationUpdates),
                Volatile.Read(ref _durableEventsPrepared),
                Volatile.Read(ref _durablePublishFailures));
        }
    }
}

/// <summary>
/// Owns observable projection instruments and their meter. Resident bytes measure the projection's
/// accounted UTF-8 payload, not total managed heap; disposal releases telemetry, not projection state.
/// </summary>
public sealed class BanStateProjectionTelemetry : IDisposable
{
    private readonly BanStateProjection _projection;
    private readonly BanStateProjectionRuntimeState _runtime;
    private readonly Meter _meter = new("FsusBlog.Server", "2.0.0");

    /// <summary>Registers observations backed by the existing projection and runtime snapshots.</summary>
    /// <param name="projection">The projection observed for entries, payload bytes, reads, generations and dispositions.</param>
    /// <param name="runtime">The runtime counters combined with source loads for authority-command observations.</param>
    public BanStateProjectionTelemetry(
        BanStateProjection projection,
        BanStateProjectionRuntimeState runtime)
    {
        _projection = projection;
        _runtime = runtime;
        _meter.CreateObservableGauge<long>("fsus.security.ban_projection.entries", ObserveEntries, "{entry}");
        _meter.CreateObservableGauge<long>("fsus.security.ban_projection.resident_bytes", ObserveBytes, "By");
        _meter.CreateObservableCounter<long>("fsus.security.ban_projection.unknown_reads", ObserveUnknownReads, "{read}");
        _meter.CreateObservableGauge<long>("fsus.security.ban_projection.version_lag", ObserveVersionLag, "{generation}");
        _meter.CreateObservableCounter<long>("fsus.security.ban_projection.updates", ObserveUpdates, "{update}");
        _meter.CreateObservableCounter<long>("fsus.security.ban_projection.drops", ObserveDrops, "{update}");
        _meter.CreateObservableCounter<long>("fsus.security.ban_projection.authority_load_commands", ObserveAuthorityCommands, "{command}");
    }

    private long ObserveEntries() => _projection.Snapshot().Entries;
    private long ObserveBytes() => _projection.Snapshot().Utf8ResidentBytes;
    private long ObserveUnknownReads() => _projection.Snapshot().UnknownReads;
    private long ObserveVersionLag() => _projection.Snapshot().VersionLag;
    private long ObserveUpdates() => _projection.Snapshot().AppliedUpdates;
    private long ObserveDrops()
    {
        BanStateProjectionSnapshot snapshot = _projection.Snapshot();
        return snapshot.InvalidUpdates + snapshot.StaleUpdates + snapshot.DuplicateUpdates
            + snapshot.Conflicts + snapshot.OverBudgetUpdates;
    }
    private long ObserveAuthorityCommands()
        => _runtime.Snapshot().AuthorityLoadCommands + _projection.Snapshot().SourceLoads;

    /// <summary>Releases this meter's instruments without draining work, clearing facts or stopping authority services.</summary>
    public void Dispose() => _meter.Dispose();
}

/// <summary>
/// Loads a cold subject's authoritative fact through a disposable service scope and reader.
/// Known projection reads do not use this source; it does not introduce a cached TTL or expiry rule.
/// </summary>
public sealed class SqlBanStateProjectionSource(IServiceScopeFactory scopeFactory) : IBanStateProjectionSource
{
    /// <summary>Reads one account and requires its physical subject hash to match ordinally before returning a fact.</summary>
    /// <param name="accountId">The physical account identifier; nonpositive values return null without querying.</param>
    /// <param name="accountSubjectHash">The expected canonical subject identity, not an alternative lookup key.</param>
    /// <param name="cancellationToken">Cancellation passed to reader iteration; not to the query command API.</param>
    /// <returns>Normal, banned or deleted authority state, or null for a missing row/subject, mismatch or unsupported status.</returns>
    /// <remarks>
    /// Database and reader failures, including reader cancellation, propagate; generation is returned unchanged.
    /// Null does not establish a normal account or alter existing projection facts; the caller
    /// determines the resulting lookup from current local state.
    /// </remarks>
    public async ValueTask<BanStateProjectionUpdate?> LoadAsync(
        int accountId,
        string accountSubjectHash,
        CancellationToken cancellationToken = default)
    {
        if (accountId <= 0)
        {
            return null;
        }

        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT account_subject_hash, status, ban_state_generation
            FROM sys_user
            WHERE id = @AccountId;
            """,
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.IsNull("account_subject_hash"))
        {
            return null;
        }

        string physicalSubjectHash = reader.ReadString("account_subject_hash");
        if (!string.Equals(physicalSubjectHash, accountSubjectHash, StringComparison.Ordinal))
        {
            return null;
        }

        int status = reader.ReadInt32("status");
        return TryMapStatus(status, out BanStateProjectionStatus projectionStatus)
            ? new BanStateProjectionUpdate(
                physicalSubjectHash,
                projectionStatus,
                projectionStatus == BanStateProjectionStatus.Banned ? BanStateProjectionFacts.ManualReasonCode : null,
                reader.ReadInt64("ban_state_generation"))
            : null;
    }

    internal static bool TryMapStatus(int status, out BanStateProjectionStatus projectionStatus)
    {
        projectionStatus = status switch
        {
            BanStateProjectionFacts.NormalStatus => BanStateProjectionStatus.Normal,
            BanStateProjectionFacts.BannedStatus => BanStateProjectionStatus.Banned,
            BanStateProjectionFacts.DeletedStatus => BanStateProjectionStatus.Deleted,
            _ => BanStateProjectionStatus.Unknown
        };
        return projectionStatus is not BanStateProjectionStatus.Unknown;
    }
}

/// <summary>
/// Defines startup loading of authority facts into the local projection. Implementations report
/// load dispositions; initialization does not acknowledge remote events or own shutdown draining.
/// </summary>
public interface IBanStateProjectionAuthorityLoader
{
    Task<BanStateProjectionAuthorityLoadResult> InitializeAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Scans authority rows in ID-ordered batches of at most 1,000 and applies each through the
/// projection's generation and payload-budget checks. Batching is not a total heap limit or
/// a transactionally consistent snapshot of concurrent authority mutations.
/// </summary>
public sealed class BanStateProjectionAuthorityLoader(
    ISqlSugarClient db,
    BanStateProjection projection,
    BanStateProjectionRuntimeState runtimeState,
    BanStateProjectionTelemetry telemetry) : IBanStateProjectionAuthorityLoader
{
    private const int BatchSize = 1_000;

    /// <summary>
    /// Loads normal, banned and deleted facts by keyset scan. Duplicate and stale applications
    /// count as accepted; missing subjects, unsupported statuses and other rejections count as drops.
    /// </summary>
    /// <param name="cancellationToken">Cancellation checked before each batch and passed to reader iteration.</param>
    /// <returns>Completed scan counts, recorded as ready and degraded if any rows were dropped.</returns>
    /// <remarks>
    /// Failures, including cancellation, mark runtime state not ready and degraded, then propagate.
    /// Already applied facts remain; retry starts from the first ID and relies on generation checks.
    /// This operation does not drain the delivery ledger or impose a lifetime on loaded facts.
    /// </remarks>
    public async Task<BanStateProjectionAuthorityLoadResult> InitializeAsync(
        CancellationToken cancellationToken = default)
    {
        _ = telemetry;
        int afterId = 0;
        int rows = 0;
        int applied = 0;
        int dropped = 0;
        int commands = 0;
        try
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                commands++;
                using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    SELECT id, account_subject_hash, status, ban_state_generation
                    FROM sys_user
                    WHERE id > @AfterId
                    ORDER BY id
                    LIMIT @BatchSize;
                    """,
                    new SugarParameter("@AfterId", afterId),
                    new SugarParameter("@BatchSize", BatchSize));
                int batchRows = 0;
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    batchRows++;
                    rows++;
                    afterId = reader.ReadInt32("id");
                    if (reader.IsNull("account_subject_hash")
                        || !SqlBanStateProjectionSource.TryMapStatus(reader.ReadInt32("status"), out BanStateProjectionStatus status))
                    {
                        dropped++;
                        continue;
                    }

                    var update = new BanStateProjectionUpdate(
                        reader.ReadString("account_subject_hash"),
                        status,
                        status == BanStateProjectionStatus.Banned ? BanStateProjectionFacts.ManualReasonCode : null,
                        reader.ReadInt64("ban_state_generation"));
                    BanStateProjectionApplyResult applyResult = projection.Apply(update);
                    if (applyResult is BanStateProjectionApplyResult.Applied
                        or BanStateProjectionApplyResult.RejectedDuplicate
                        or BanStateProjectionApplyResult.RejectedStale)
                    {
                        applied++;
                    }
                    else
                    {
                        dropped++;
                    }
                }

                if (batchRows < BatchSize)
                {
                    break;
                }
            }

            var loadResult = new BanStateProjectionAuthorityLoadResult(rows, applied, dropped, commands);
            runtimeState.RecordAuthorityLoad(loadResult);
            return loadResult;
        }
        catch (Exception exception)
        {
            runtimeState.RecordAuthorityLoadFailure(exception);
            throw;
        }
    }
}

/// <summary>Maps physical account statuses 0/1/2 to projection facts, using the canonical manual reason for bans.</summary>
public static class BanStateProjectionFacts
{
    public const int NormalStatus = 0;
    public const int BannedStatus = 1;
    public const int DeletedStatus = 2;
    public const string ManualReasonCode = "manual_ban";

    /// <summary>Builds a fact from a supported physical status without validating subject identity or generation.</summary>
    /// <param name="accountSubjectHash">The subject identity retained unchanged for later projection validation.</param>
    /// <param name="status">The physical normal, banned or deleted status, not the projection enum's numeric value.</param>
    /// <param name="generation">The authority generation retained unchanged for monotonic application checks.</param>
    /// <returns>A fact with the manual reason only for banned status; it has no independent expiry.</returns>
    /// <exception cref="InvalidDataException">The physical status is unsupported.</exception>
    public static BanStateProjectionUpdate Create(
        string accountSubjectHash,
        int status,
        long generation)
    {
        if (!SqlBanStateProjectionSource.TryMapStatus(status, out BanStateProjectionStatus projectionStatus))
        {
            throw new InvalidDataException($"Unsupported account ban status: {status}.");
        }

        return new BanStateProjectionUpdate(
            accountSubjectHash,
            projectionStatus,
            projectionStatus == BanStateProjectionStatus.Banned ? ManualReasonCode : null,
            generation);
    }
}
