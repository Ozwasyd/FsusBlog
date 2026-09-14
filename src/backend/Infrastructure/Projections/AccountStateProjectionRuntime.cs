using System.Data.Common;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Distributed;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Projections;

public readonly record struct AccountStateProjectionHealthSnapshot(
    bool Ready,
    bool Degraded,
    string Detail,
    long DbCommands,
    long RedisCommands,
    long DurablePublishes,
    long DurablePublishFailures,
    long VersionLag,
    double LastInvalidationLatencyMilliseconds);

public sealed class AccountStateProjectionRuntimeState
{
    private readonly object _sync = new();
    private bool _ready;
    private bool _degraded;
    private string _detail = "not_loaded";
    private long _dbCommands;
    private long _durablePublishes;
    private long _durablePublishFailures;
    private long _versionLag;
    private double _lastInvalidationLatencyMilliseconds;

    public void RecordSourceSuccess()
    {
        Interlocked.Increment(ref _dbCommands);
        lock (_sync)
        {
            _ready = true;
            _degraded = false;
            _detail = "postgres_authority_available";
        }
    }

    public void RecordSourceFailure(Exception exception)
    {
        Interlocked.Increment(ref _dbCommands);
        lock (_sync)
        {
            _degraded = true;
            _detail = string.Concat("postgres_authority_failed:", exception.GetType().Name);
        }
    }

    public void RecordConvergence(long requestedGeneration, long observedGeneration, TimeSpan latency)
    {
        Interlocked.Exchange(ref _versionLag, Math.Max(0, requestedGeneration - observedGeneration));
        lock (_sync)
        {
            _lastInvalidationLatencyMilliseconds = Math.Max(0, latency.TotalMilliseconds);
        }
    }

    public void RecordPublish(DistributedInvalidationPublishStatus status)
    {
        Interlocked.Increment(ref _durablePublishes);
        if (status == DistributedInvalidationPublishStatus.Degraded)
        {
            Interlocked.Increment(ref _durablePublishFailures);
            lock (_sync)
            {
                _degraded = true;
                _detail = "durable_publish_degraded";
            }
        }
    }

    public AccountStateProjectionHealthSnapshot Snapshot()
    {
        lock (_sync)
        {
            return new AccountStateProjectionHealthSnapshot(
                _ready,
                _degraded,
                _detail,
                Volatile.Read(ref _dbCommands),
                RedisCommands: 0,
                Volatile.Read(ref _durablePublishes),
                Volatile.Read(ref _durablePublishFailures),
                Volatile.Read(ref _versionLag),
                _lastInvalidationLatencyMilliseconds);
        }
    }
}

public sealed class SqlAccountStateProjectionSource(
    IServiceScopeFactory scopeFactory,
    AccountStateProjectionRuntimeState runtime) : IAccountStateProjectionSource
{
    private static readonly SemaphoreSlim s_dbGate = new(initialCount: 32, maxCount: 32);

    public async ValueTask<AccountStateSnapshot> LoadAsync(
        int accountId,
        CancellationToken cancellationToken)
    {
        await s_dbGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT id AS "Id",
                       xmin::text::bigint AS "Generation",
                       status AS "Status",
                       banreason AS "BanReason",
                       COALESCE(mfaenabled, false) AS "MfaEnabled",
                       deleted_at AS "DeletedAt",
                       public_handle AS "PublicHandle",
                       identity_kind AS "IdentityKind",
                       COALESCE(passkey_enabled, false) AS "PasskeyEnabled",
                       COALESCE(recovery_enabled, false) AS "RecoveryEnabled",
                       anonymous_credential_status AS "AnonymousCredentialStatus",
                       anonymous_credential_level AS "AnonymousCredentialLevel",
                       account_subject_hash AS "AccountSubjectHash",
                       registration_state AS "RegistrationState"
                FROM sys_user
                WHERE id = @Id
                LIMIT 1;
                """,
                new SugarParameter[] { new("@Id", accountId) }).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                runtime.RecordSourceSuccess();
                return new AccountStateSnapshot
                {
                    AccountId = accountId,
                    Generation = 0,
                    Knowledge = AccountStateKnowledge.Missing
                };
            }

            int status = reader.GetInt32(reader.GetOrdinal("Status"));
            DateTime? deletedAt = reader.IsDBNull(reader.GetOrdinal("DeletedAt"))
                ? null
                : reader.GetDateTime(reader.GetOrdinal("DeletedAt"));
            runtime.RecordSourceSuccess();
            return new AccountStateSnapshot
            {
                AccountId = reader.GetInt32(reader.GetOrdinal("Id")),
                Generation = reader.GetInt64(reader.GetOrdinal("Generation")),
                Knowledge = status == 2 || deletedAt.HasValue
                    ? AccountStateKnowledge.Deleted
                    : AccountStateKnowledge.Present,
                AccountSubjectHash = ReadNullableString(reader, "AccountSubjectHash"),
                Status = status,
                BanReason = ReadNullableString(reader, "BanReason"),
                DeletedAt = deletedAt,
                IdentityKind = ReadNullableString(reader, "IdentityKind") ?? AnonymousIdentityRuntime.AnonymousAccountKind,
                RegistrationState = ReadNullableString(reader, "RegistrationState") ?? AccountRegistrationStates.Active,
                MfaEnabled = reader.GetBoolean(reader.GetOrdinal("MfaEnabled")),
                PasskeyEnabled = reader.GetBoolean(reader.GetOrdinal("PasskeyEnabled")),
                RecoveryEnabled = reader.GetBoolean(reader.GetOrdinal("RecoveryEnabled")),
                PublicHandle = ReadNullableString(reader, "PublicHandle"),
                AnonymousCredentialStatus = ReadNullableString(reader, "AnonymousCredentialStatus"),
                AnonymousCredentialLevel = ReadNullableString(reader, "AnonymousCredentialLevel")
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            runtime.RecordSourceFailure(exception);
            throw;
        }
        finally
        {
            s_dbGate.Release();
        }
    }

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }
}

public interface IAccountStateProjectionMutationPublisher
{
    Task ProjectCommittedMutationAsync(int accountId, CancellationToken cancellationToken = default);
}

public sealed class AccountStateProjectionMutationPublisher(
    IAccountStateProjection projection,
    IDistributedInvalidationPublisher publisher,
    AccountStateProjectionRuntimeState runtime,
    AccountStateProjectionTelemetry telemetry,
    TimeProvider timeProvider) : IAccountStateProjectionMutationPublisher
{
    public const string ArtifactPrefix = "account-state-v1:";

    public async Task ProjectCommittedMutationAsync(
        int accountId,
        CancellationToken cancellationToken = default)
    {
        _ = telemetry;
        _ = timeProvider;
        long started = Stopwatch.GetTimestamp();
        AccountStateReadResult refreshed = await projection
            .RefreshAsync(accountId, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        long generation = refreshed.Snapshot?.Generation ?? 0;
        if (refreshed.Outcome is AccountStateReadOutcome.Unknown
            or AccountStateReadOutcome.Conflict
            or AccountStateReadOutcome.SubjectMismatch)
        {
            projection.FailClosed(accountId);
        }

        string artifact = string.Concat(
            ArtifactPrefix,
            accountId.ToString(CultureInfo.InvariantCulture),
            ":g",
            generation.ToString(CultureInfo.InvariantCulture));
        DistributedInvalidationPublishResult result = await publisher.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.AccountStateProjectionMutation,
                CacheTags: [],
                RouteKeys: [],
                ArtifactKeys: [artifact]),
            cancellationToken).ConfigureAwait(false);
        runtime.RecordPublish(result.Status);
        runtime.RecordConvergence(generation, refreshed.Snapshot?.Generation ?? 0, Stopwatch.GetElapsedTime(started));
    }

    public static bool TryParseArtifact(string value, out int accountId, out long generation)
    {
        accountId = 0;
        generation = 0;
        if (string.IsNullOrWhiteSpace(value) || !value.StartsWith(ArtifactPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> remainder = value.AsSpan(ArtifactPrefix.Length);
        int separator = remainder.IndexOf(":g", StringComparison.Ordinal);
        return separator > 0
            && int.TryParse(remainder[..separator], NumberStyles.None, CultureInfo.InvariantCulture, out accountId)
            && accountId > 0
            && long.TryParse(remainder[(separator + 2)..], NumberStyles.None, CultureInfo.InvariantCulture, out generation)
            && generation >= 0;
    }
}

public sealed class AccountStateProjectionTelemetry : IDisposable
{
    private readonly IAccountStateProjection _projection;
    private readonly AccountStateProjectionRuntimeState _runtime;
    private readonly Meter _meter = new("FsusBlog.Server.AccountStateProjection", "1.0.0");

    public AccountStateProjectionTelemetry(
        IAccountStateProjection projection,
        AccountStateProjectionRuntimeState runtime)
    {
        _projection = projection;
        _runtime = runtime;
        _meter.CreateObservableGauge("fsus.account_state.entries", () => _projection.Snapshot().Entries, "{entry}");
        _meter.CreateObservableGauge("fsus.account_state.logical_bytes", () => _projection.Snapshot().LogicalBytes, "By");
        _meter.CreateObservableGauge("fsus.account_state.capacity_bytes", () => _projection.Snapshot().CapacityBytes, "By");
        _meter.CreateObservableCounter("fsus.account_state.hits", () => _projection.Snapshot().LocalHits, "{read}");
        _meter.CreateObservableCounter("fsus.account_state.source_loads", () => _projection.Snapshot().SourceLoads, "{load}");
        _meter.CreateObservableCounter("fsus.account_state.refreshes", () => _projection.Snapshot().AuthoritativeRefreshes, "{refresh}");
        _meter.CreateObservableCounter("fsus.account_state.db_commands", () => _runtime.Snapshot().DbCommands, "{command}");
        _meter.CreateObservableCounter("fsus.account_state.redis_commands", () => _runtime.Snapshot().RedisCommands, "{command}");
        _meter.CreateObservableGauge("fsus.account_state.version_lag", () => _runtime.Snapshot().VersionLag, "{generation}");
        _meter.CreateObservableGauge("fsus.account_state.invalidation_latency", () => _runtime.Snapshot().LastInvalidationLatencyMilliseconds, "ms");
    }

    public void Dispose() => _meter.Dispose();
}
