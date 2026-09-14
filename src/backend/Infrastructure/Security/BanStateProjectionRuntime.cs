using System.Data.Common;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Distributed;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Security;

public readonly record struct BanStateProjectionAuthorityLoadResult(
    int RowsRead,
    int Applied,
    int Dropped,
    int Commands);

public readonly record struct BanStateProjectionRuntimeSnapshot(
    bool Ready,
    bool Degraded,
    string Detail,
    long AuthorityLoadCommands,
    long AuthorityLoadRows,
    long LocalMutationUpdates,
    long DurableEventsPrepared,
    long DurablePublishFailures);

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

    public void RecordAuthorityLoadFailure(Exception exception)
    {
        lock (_sync)
        {
            _ready = false;
            _degraded = true;
            _detail = $"authority_load_failed:{exception.GetType().Name}";
        }
    }

    public void RecordLocalMutation() => Interlocked.Increment(ref _localMutationUpdates);

    public void RecordDurablePrepared() => Interlocked.Increment(ref _durableEventsPrepared);

    public void RecordPublishFailure() => Interlocked.Increment(ref _durablePublishFailures);

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

public sealed class BanStateProjectionTelemetry : IDisposable
{
    private readonly BanStateProjection _projection;
    private readonly BanStateProjectionRuntimeState _runtime;
    private readonly Meter _meter = new("FsusBlog.Server", "2.0.0");

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

    public void Dispose() => _meter.Dispose();
}

public sealed class SqlBanStateProjectionSource(IServiceScopeFactory scopeFactory) : IBanStateProjectionSource
{
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

public interface IBanStateProjectionAuthorityLoader
{
    Task<BanStateProjectionAuthorityLoadResult> InitializeAsync(CancellationToken cancellationToken = default);
}

public sealed class BanStateProjectionAuthorityLoader(
    ISqlSugarClient db,
    BanStateProjection projection,
    BanStateProjectionRuntimeState runtimeState,
    BanStateProjectionTelemetry telemetry) : IBanStateProjectionAuthorityLoader
{
    private const int BatchSize = 1_000;

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

public static class BanStateProjectionFacts
{
    public const int NormalStatus = 0;
    public const int BannedStatus = 1;
    public const int DeletedStatus = 2;
    public const string ManualReasonCode = "manual_ban";

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
