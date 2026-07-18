using System.Diagnostics.Metrics;
using System.Globalization;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public static class ActiveReleaseFenceStatuses
{
    public const string Active = "active";
    public const string Revoked = "revoked";
    public const string Missing = "missing";
    public const string Unavailable = "unavailable";
}

public sealed record ActiveReleaseFenceSnapshot(
    bool Exists,
    string Status,
    string ReleaseId,
    string Slot,
    long Generation,
    string ImageDigest,
    DateTimeOffset? ActivatedAtUtc,
    DateTimeOffset? RevokedAtUtc);

public sealed record ActiveReleaseFenceAcquireRequest(
    string ReleaseId,
    string Slot,
    long Generation,
    string ImageDigest,
    string? ExpectedReleaseId,
    string? ExpectedSlot,
    long? ExpectedGeneration,
    bool DryRun = false);

public sealed record ActiveReleaseFenceRevokeRequest(
    string ReleaseId,
    string Slot,
    long Generation,
    bool DryRun = false);

public sealed record ActiveReleaseFenceVerifyRequest(
    string? ReleaseId = null,
    string? Slot = null,
    long? Generation = null,
    bool RequireActive = true);

public sealed record ActiveReleaseFenceOperationResult(
    bool Accepted,
    bool Idempotent,
    string Status,
    string? ErrorCode,
    bool DryRun,
    ActiveReleaseFenceSnapshot Snapshot);

public sealed record ActiveReleaseFenceRuntimeSnapshot(
    ActiveReleaseFenceSnapshot Fence,
    bool StoreReachable,
    bool LocalReleaseIsActive,
    DateTimeOffset RefreshedAtUtc,
    string? ErrorCode);

public sealed record ActiveReleaseExecutionTicket(
    string ReleaseId,
    string Slot,
    long Generation,
    string ImageDigest,
    string ProcessInstanceId)
{
    public string LeaseOwner => string.Create(
        CultureInfo.InvariantCulture,
        $"{ReleaseId}:{Slot}:{Generation}:{ProcessInstanceId}");
}

public interface IActiveReleaseFenceStore
{
    Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default);

    Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);
}

public interface IActiveReleaseFenceReplicaStore : IActiveReleaseFenceStore
{
    Task ReconcileAsync(
        ActiveReleaseFenceSnapshot snapshot,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);
}

public sealed class ActiveReleaseFenceStoreException(string errorCode, string message, Exception? innerException = null)
    : InvalidOperationException(message, innerException)
{
    public string ErrorCode { get; } = errorCode;
}

public sealed class RedisActiveReleaseFenceStore(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope keyScope) : IActiveReleaseFenceReplicaStore
{
    private const string FenceKey = "fsus:deployment:active-release-fence:v1";
    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashEntry[] entries = await _database.HashGetAllAsync(Key()).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return Parse(entries);
    }

    public async Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        ValidateAcquireRequest(request);
        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local exists = redis.call('EXISTS', KEYS[1])
local current_release = redis.call('HGET', KEYS[1], 'release_id') or ''
local current_slot = redis.call('HGET', KEYS[1], 'slot') or ''
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'generation') or '0')
local current_digest = redis.call('HGET', KEYS[1], 'image_digest') or ''
local current_status = redis.call('HGET', KEYS[1], 'status') or 'missing'
local current_activated = redis.call('HGET', KEYS[1], 'activated_at_unix_ms') or ''
local current_revoked = redis.call('HGET', KEYS[1], 'revoked_at_unix_ms') or ''
local target_generation = tonumber(ARGV[3])

local function result(accepted, idempotent, status, error_code, release_id, slot, generation, digest, fence_status, activated, revoked)
  return {accepted, idempotent, status, error_code, release_id, slot, tostring(generation), digest, fence_status, activated, revoked}
end

if exists == 1 and target_generation == current_generation
  and current_release == ARGV[1] and current_slot == ARGV[2]
  and current_digest == ARGV[4] and current_status == 'active' then
  return result(1, 1, 'already-active', '', current_release, current_slot, current_generation, current_digest, current_status, current_activated, current_revoked)
end

if exists == 1 then
  if ARGV[5] == '' or ARGV[6] == '' or ARGV[7] == '' then
    return result(0, 0, 'rejected', 'expected_current_required', current_release, current_slot, current_generation, current_digest, current_status, current_activated, current_revoked)
  end
  if current_release ~= ARGV[5] or current_slot ~= ARGV[6] or current_generation ~= tonumber(ARGV[7]) then
    return result(0, 0, 'rejected', 'active_release_compare_failed', current_release, current_slot, current_generation, current_digest, current_status, current_activated, current_revoked)
  end
end

if exists == 1 and target_generation < current_generation then
  return result(0, 0, 'rejected', 'active_release_generation_stale', current_release, current_slot, current_generation, current_digest, current_status, current_activated, current_revoked)
end
if exists == 1 and target_generation == current_generation then
  return result(0, 0, 'rejected', 'active_release_generation_not_monotonic', current_release, current_slot, current_generation, current_digest, current_status, current_activated, current_revoked)
end

if ARGV[9] == '1' then
  return result(1, 0, 'would-acquire', '', ARGV[1], ARGV[2], target_generation, ARGV[4], 'active', ARGV[8], '')
end

redis.call('HSET', KEYS[1],
  'release_id', ARGV[1],
  'slot', ARGV[2],
  'generation', ARGV[3],
  'image_digest', ARGV[4],
  'status', 'active',
  'activated_at_unix_ms', ARGV[8],
  'revoked_at_unix_ms', '')
return result(1, 0, 'acquired', '', ARGV[1], ARGV[2], target_generation, ARGV[4], 'active', ARGV[8], '')
""";
        RedisResult raw = await _database.ScriptEvaluateAsync(
                script,
                [Key()],
                [
                    Normalize(request.ReleaseId),
                    Normalize(request.Slot),
                    request.Generation,
                    Normalize(request.ImageDigest),
                    Normalize(request.ExpectedReleaseId),
                    Normalize(request.ExpectedSlot),
                    request.ExpectedGeneration?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                    now.ToUnixTimeMilliseconds(),
                    request.DryRun ? "1" : "0"
                ])
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return ParseOperation(raw, request.DryRun);
    }

    public async Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentity(request.ReleaseId, request.Slot, request.Generation);
        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local exists = redis.call('EXISTS', KEYS[1])
local current_release = redis.call('HGET', KEYS[1], 'release_id') or ''
local current_slot = redis.call('HGET', KEYS[1], 'slot') or ''
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'generation') or '0')
local current_digest = redis.call('HGET', KEYS[1], 'image_digest') or ''
local current_status = redis.call('HGET', KEYS[1], 'status') or 'missing'
local current_activated = redis.call('HGET', KEYS[1], 'activated_at_unix_ms') or ''
local current_revoked = redis.call('HGET', KEYS[1], 'revoked_at_unix_ms') or ''

local function result(accepted, idempotent, status, error_code, fence_status, revoked)
  return {accepted, idempotent, status, error_code, current_release, current_slot, tostring(current_generation), current_digest, fence_status, current_activated, revoked}
end

if exists == 0 then
  return result(1, 1, 'already-absent', '', 'missing', '')
end
if current_release ~= ARGV[1] or current_slot ~= ARGV[2] or current_generation ~= tonumber(ARGV[3]) then
  return result(1, 1, 'already-superseded', '', current_status, current_revoked)
end
if current_status == 'revoked' then
  return result(1, 1, 'already-revoked', '', current_status, current_revoked)
end
if ARGV[5] == '1' then
  return result(1, 0, 'would-revoke', '', 'revoked', ARGV[4])
end
redis.call('HSET', KEYS[1], 'status', 'revoked', 'revoked_at_unix_ms', ARGV[4])
return result(1, 0, 'revoked', '', 'revoked', ARGV[4])
""";
        RedisResult raw = await _database.ScriptEvaluateAsync(
                script,
                [Key()],
                [
                    Normalize(request.ReleaseId),
                    Normalize(request.Slot),
                    request.Generation,
                    now.ToUnixTimeMilliseconds(),
                    request.DryRun ? "1" : "0"
                ])
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return ParseOperation(raw, request.DryRun);
    }

    public async Task ReconcileAsync(
        ActiveReleaseFenceSnapshot snapshot,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        if (!snapshot.Exists)
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local exists = redis.call('EXISTS', KEYS[1])
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'generation') or '0')
local current_release = redis.call('HGET', KEYS[1], 'release_id') or ''
local current_slot = redis.call('HGET', KEYS[1], 'slot') or ''
local current_digest = redis.call('HGET', KEYS[1], 'image_digest') or ''
local current_status = redis.call('HGET', KEYS[1], 'status') or 'missing'
local target_generation = tonumber(ARGV[3])

if exists == 1 and current_generation > target_generation then
  return 'newer'
end
if exists == 1 and current_generation == target_generation then
  if current_release ~= ARGV[1] or current_slot ~= ARGV[2] or current_digest ~= ARGV[4] then
    return 'diverged'
  end
  if current_status == 'revoked' and ARGV[5] == 'active' then
    return 'revoked-dominates'
  end
  if current_status == ARGV[5] then
    return 'current'
  end
end

redis.call('HSET', KEYS[1],
  'release_id', ARGV[1],
  'slot', ARGV[2],
  'generation', ARGV[3],
  'image_digest', ARGV[4],
  'status', ARGV[5],
  'activated_at_unix_ms', ARGV[6],
  'revoked_at_unix_ms', ARGV[7])
return exists == 0 and 'restored' or 'updated'
""";
        RedisResult raw = await _database.ScriptEvaluateAsync(
                script,
                [Key()],
                [
                    Normalize(snapshot.ReleaseId),
                    Normalize(snapshot.Slot),
                    snapshot.Generation,
                    Normalize(snapshot.ImageDigest),
                    Normalize(snapshot.Status),
                    snapshot.ActivatedAtUtc?.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                    snapshot.RevokedAtUtc?.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                    now.ToUnixTimeMilliseconds()
                ])
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        string result = raw.ToString() ?? string.Empty;
        if (result is "diverged" or "newer")
        {
            throw new ActiveReleaseFenceStoreException(
                "active_release_fence_witness_diverged",
                $"Redis active release fence reconciliation rejected the durable snapshot: {result}.");
        }
    }

    private RedisKey Key() => keyScope.PrefixKey(FenceKey);

    private static ActiveReleaseFenceOperationResult ParseOperation(RedisResult raw, bool dryRun)
    {
        RedisResult[] values = (RedisResult[])raw!;
        if (values.Length != 11)
        {
            throw new InvalidOperationException("Redis returned an invalid active release fence result.");
        }

        bool accepted = Text(values[0]) == "1";
        bool idempotent = Text(values[1]) == "1";
        string status = Text(values[2]);
        string errorCode = Text(values[3]);
        var snapshot = new ActiveReleaseFenceSnapshot(
            Exists: Text(values[8]) != ActiveReleaseFenceStatuses.Missing,
            Status: Text(values[8]),
            ReleaseId: Text(values[4]),
            Slot: Text(values[5]),
            Generation: long.TryParse(Text(values[6]), NumberStyles.None, CultureInfo.InvariantCulture, out long generation) ? generation : 0,
            ImageDigest: Text(values[7]),
            ActivatedAtUtc: ParseTimestamp(Text(values[9])),
            RevokedAtUtc: ParseTimestamp(Text(values[10])));
        return new ActiveReleaseFenceOperationResult(
            accepted,
            idempotent,
            status,
            errorCode.Length == 0 ? null : errorCode,
            dryRun,
            snapshot);
    }

    private static ActiveReleaseFenceSnapshot Parse(HashEntry[] entries)
    {
        if (entries.Length == 0)
        {
            return MissingSnapshot();
        }

        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (HashEntry entry in entries)
        {
            fields[entry.Name.ToString()] = entry.Value.ToString();
        }

        _ = long.TryParse(Get("generation"), NumberStyles.None, CultureInfo.InvariantCulture, out long generation);
        return new ActiveReleaseFenceSnapshot(
            true,
            Get("status") is { Length: > 0 } status ? status : ActiveReleaseFenceStatuses.Unavailable,
            Get("release_id"),
            Get("slot"),
            generation,
            Get("image_digest"),
            ParseTimestamp(Get("activated_at_unix_ms")),
            ParseTimestamp(Get("revoked_at_unix_ms")));

        string Get(string key) => fields.TryGetValue(key, out string? value) ? value : string.Empty;
    }

    internal static ActiveReleaseFenceSnapshot MissingSnapshot()
        => new(false, ActiveReleaseFenceStatuses.Missing, string.Empty, string.Empty, 0, string.Empty, null, null);

    private static DateTimeOffset? ParseTimestamp(string value)
        => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long milliseconds) && milliseconds > 0
            ? DateTimeOffset.FromUnixTimeMilliseconds(milliseconds)
            : null;

    private static string Text(RedisResult value) => value.ToString() ?? string.Empty;

    private static string Normalize(string? value) => (value ?? string.Empty).Trim();

    private static void ValidateAcquireRequest(ActiveReleaseFenceAcquireRequest request)
    {
        ValidateIdentity(request.ReleaseId, request.Slot, request.Generation);
        if (string.IsNullOrWhiteSpace(request.ImageDigest))
        {
            throw new ArgumentException("Active release image digest is required.", nameof(request));
        }
    }

    private static void ValidateIdentity(string releaseId, string slot, long generation)
    {
        if (string.IsNullOrWhiteSpace(releaseId) || string.IsNullOrWhiteSpace(slot) || generation <= 0)
        {
            throw new ArgumentException("Active release identity and a positive generation are required.");
        }
    }
}

public interface IActiveReleaseFence
{
    ActiveReleaseFenceRuntimeSnapshot Current
    {
        get;
    }

    Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseFenceRuntimeSnapshot> RefreshAsync(
        bool forceStoreRead = false,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseFenceOperationResult> VerifyAsync(
        ActiveReleaseFenceVerifyRequest request,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseExecutionTicket?> TryCaptureExecutionTicketAsync(
        CancellationToken cancellationToken = default);

    Task<bool> IsCurrentAsync(
        ActiveReleaseExecutionTicket ticket,
        bool forceStoreRead,
        CancellationToken cancellationToken = default);
}

public sealed class ActiveReleaseFence(
    IActiveReleaseFenceStore store,
    IReleaseIdentityProvider releaseIdentity,
    DeploymentRuntimeState deploymentRuntime,
    IWebHostEnvironment environment,
    IConfiguration configuration,
    TimeProvider timeProvider,
    ILogger<ActiveReleaseFence> logger) : IActiveReleaseFence
{
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly ReleaseIdentitySnapshot _local = releaseIdentity.Current;
    private readonly string _processInstanceId = $"{Environment.MachineName}-{Environment.ProcessId}-{Guid.NewGuid():N}";
    private ActiveReleaseFenceRuntimeSnapshot _current = Unavailable(TimeProvider.System.GetUtcNow(), "active_release_fence_not_refreshed");

    public ActiveReleaseFenceRuntimeSnapshot Current => Volatile.Read(ref _current);

    public async Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        CancellationToken cancellationToken = default)
    {
        string? identityError = ValidateLocalAcquireIdentity(request);
        if (identityError is not null)
        {
            return Rejected(identityError, request.DryRun);
        }

        ActiveReleaseFenceOperationResult result;
        try
        {
            result = await store.AcquireAsync(
                request,
                timeProvider.GetUtcNow(),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string errorCode = StoreErrorCode(ex);
            logger.LogWarning(ex, "active-release-fence-acquire-store-unavailable");
            ActiveReleaseFenceRuntimeSnapshot unavailable = Unavailable(
                timeProvider.GetUtcNow(),
                errorCode);
            Volatile.Write(ref _current, unavailable);
            ActiveReleaseFenceMetrics.RecordOperation("acquire", "rejected", errorCode);
            return new ActiveReleaseFenceOperationResult(
                false,
                false,
                "rejected",
                errorCode,
                request.DryRun,
                unavailable.Fence);
        }
        ActiveReleaseFenceMetrics.RecordOperation("acquire", result.Accepted ? "accepted" : "rejected", result.ErrorCode ?? result.Status);
        if (result.Accepted && !request.DryRun)
        {
            Publish(result.Snapshot, storeReachable: true, errorCode: null);
        }
        return result;
    }

    public async Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceOperationResult result;
        try
        {
            result = await store.RevokeAsync(
                request,
                timeProvider.GetUtcNow(),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string errorCode = StoreErrorCode(ex);
            logger.LogWarning(ex, "active-release-fence-revoke-store-unavailable");
            ActiveReleaseFenceRuntimeSnapshot unavailable = Unavailable(
                timeProvider.GetUtcNow(),
                errorCode);
            Volatile.Write(ref _current, unavailable);
            ActiveReleaseFenceMetrics.RecordOperation("revoke", "rejected", errorCode);
            return new ActiveReleaseFenceOperationResult(
                false,
                false,
                "rejected",
                errorCode,
                request.DryRun,
                unavailable.Fence);
        }
        ActiveReleaseFenceMetrics.RecordOperation("revoke", result.Accepted ? "accepted" : "rejected", result.ErrorCode ?? result.Status);
        if (result.Accepted && !request.DryRun)
        {
            Publish(result.Snapshot, storeReachable: true, errorCode: null);
        }
        return result;
    }

    public async Task<ActiveReleaseFenceRuntimeSnapshot> RefreshAsync(
        bool forceStoreRead = false,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceRuntimeSnapshot cached = Current;
        if (!forceStoreRead && cached.StoreReachable && timeProvider.GetUtcNow() - cached.RefreshedAtUtc < RefreshInterval())
        {
            return cached;
        }

        await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            cached = Current;
            if (!forceStoreRead && cached.StoreReachable && timeProvider.GetUtcNow() - cached.RefreshedAtUtc < RefreshInterval())
            {
                return cached;
            }

            if (UseSyntheticLocalFence())
            {
                DeploymentRuntimeSnapshot runtime = deploymentRuntime.CreateSnapshot(0);
                var synthetic = new ActiveReleaseFenceSnapshot(
                    true,
                    ActiveReleaseFenceStatuses.Active,
                    _local.ReleaseId,
                    _local.ReleaseSlot,
                    Math.Max(1, runtime.Generation),
                    _local.ImageDigest,
                    runtime.ActivatedAtUtc ?? timeProvider.GetUtcNow(),
                    null);
                return Publish(synthetic, storeReachable: true, errorCode: null);
            }

            try
            {
                ActiveReleaseFenceSnapshot snapshot = await store.ReadAsync(cancellationToken).ConfigureAwait(false);
                ActiveReleaseFenceMetrics.RecordOperation("refresh", "accepted", snapshot.Status);
                return Publish(snapshot, storeReachable: true, errorCode: null);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                string errorCode = StoreErrorCode(ex);
                logger.LogWarning(ex, "active-release-fence-refresh-failed");
                ActiveReleaseFenceMetrics.RecordOperation("refresh", "rejected", errorCode);
                ActiveReleaseFenceRuntimeSnapshot unavailable = Unavailable(timeProvider.GetUtcNow(), errorCode);
                Volatile.Write(ref _current, unavailable);
                return unavailable;
            }
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    public async Task<ActiveReleaseFenceOperationResult> VerifyAsync(
        ActiveReleaseFenceVerifyRequest request,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceRuntimeSnapshot runtime = await RefreshAsync(true, cancellationToken).ConfigureAwait(false);
        string? error = !runtime.StoreReachable
            ? runtime.ErrorCode
            : request.RequireActive && runtime.Fence.Status != ActiveReleaseFenceStatuses.Active
                ? "active_release_fence_not_active"
                : request.ReleaseId is { Length: > 0 } releaseId && !string.Equals(releaseId, runtime.Fence.ReleaseId, StringComparison.Ordinal)
                    ? "active_release_release_mismatch"
                    : request.Slot is { Length: > 0 } slot && !string.Equals(slot, runtime.Fence.Slot, StringComparison.Ordinal)
                        ? "active_release_slot_mismatch"
                        : request.Generation.HasValue && request.Generation.Value != runtime.Fence.Generation
                            ? "active_release_generation_mismatch"
                            : null;
        return error is null
            ? new ActiveReleaseFenceOperationResult(true, true, "verified", null, false, runtime.Fence)
            : new ActiveReleaseFenceOperationResult(false, false, "rejected", error, false, runtime.Fence);
    }

    public async Task<ActiveReleaseExecutionTicket?> TryCaptureExecutionTicketAsync(
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceRuntimeSnapshot runtime = await RefreshAsync(forceStoreRead: true, cancellationToken).ConfigureAwait(false);
        if (!runtime.LocalReleaseIsActive || !deploymentRuntime.CanClaimBackgroundWork)
        {
            ActiveReleaseFenceMetrics.RecordEligibility("rejected", runtime.ErrorCode ?? runtime.Fence.Status);
            return null;
        }

        ActiveReleaseFenceMetrics.RecordEligibility("accepted", "active");
        return new ActiveReleaseExecutionTicket(
            _local.ReleaseId,
            _local.ReleaseSlot,
            runtime.Fence.Generation,
            _local.ImageDigest,
            _processInstanceId);
    }

    public async Task<bool> IsCurrentAsync(
        ActiveReleaseExecutionTicket ticket,
        bool forceStoreRead,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceRuntimeSnapshot runtime = await RefreshAsync(forceStoreRead, cancellationToken).ConfigureAwait(false);
        bool current = runtime.LocalReleaseIsActive
            && deploymentRuntime.CanClaimBackgroundWork
            && string.Equals(ticket.ReleaseId, runtime.Fence.ReleaseId, StringComparison.Ordinal)
            && string.Equals(ticket.Slot, runtime.Fence.Slot, StringComparison.Ordinal)
            && ticket.Generation == runtime.Fence.Generation
            && string.Equals(ticket.ImageDigest, runtime.Fence.ImageDigest, StringComparison.Ordinal);
        ActiveReleaseFenceMetrics.RecordEligibility(current ? "accepted" : "rejected", current ? "current" : "stale");
        return current;
    }

    private ActiveReleaseFenceRuntimeSnapshot Publish(
        ActiveReleaseFenceSnapshot snapshot,
        bool storeReachable,
        string? errorCode)
    {
        DeploymentRuntimeSnapshot deployment = deploymentRuntime.CreateSnapshot(0);
        bool localIsActive = storeReachable
            && snapshot.Exists
            && snapshot.Status == ActiveReleaseFenceStatuses.Active
            && string.Equals(snapshot.ReleaseId, _local.ReleaseId, StringComparison.Ordinal)
            && string.Equals(snapshot.Slot, _local.ReleaseSlot, StringComparison.Ordinal)
            && string.Equals(snapshot.ImageDigest, _local.ImageDigest, StringComparison.Ordinal)
            && snapshot.Generation == Math.Max(1, deployment.Generation);
        var runtime = new ActiveReleaseFenceRuntimeSnapshot(
            snapshot,
            storeReachable,
            localIsActive,
            timeProvider.GetUtcNow(),
            errorCode);
        Volatile.Write(ref _current, runtime);
        return runtime;
    }

    private string? ValidateLocalAcquireIdentity(ActiveReleaseFenceAcquireRequest request)
    {
        DeploymentRuntimeSnapshot runtime = deploymentRuntime.CreateSnapshot(0);
        if (!string.Equals(request.ReleaseId?.Trim(), _local.ReleaseId, StringComparison.Ordinal))
        {
            return "active_release_local_release_mismatch";
        }
        if (!string.Equals(request.Slot?.Trim(), _local.ReleaseSlot, StringComparison.Ordinal))
        {
            return "active_release_local_slot_mismatch";
        }
        if (!string.Equals(request.ImageDigest?.Trim(), _local.ImageDigest, StringComparison.Ordinal))
        {
            return "active_release_local_digest_mismatch";
        }
        if (request.Generation <= 0 || request.Generation != runtime.Generation)
        {
            return "active_release_local_generation_mismatch";
        }
        if (runtime.State is not DeploymentLifecycleStates.Ready and not DeploymentLifecycleStates.Active)
        {
            return "active_release_candidate_not_ready";
        }
        return null;
    }

    private bool UseSyntheticLocalFence()
        => environment.IsDevelopment()
            && configuration.GetValue(ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey, false)
            && !_local.Configured
            && string.Equals(_local.ReleaseSlot, "local", StringComparison.Ordinal);

    private TimeSpan RefreshInterval()
        => ActiveReleaseFenceAvailabilityPolicy.RefreshInterval(configuration);

    private static string StoreErrorCode(Exception exception)
        => exception is ActiveReleaseFenceStoreException storeException
            ? storeException.ErrorCode
            : "active_release_fence_store_unavailable";

    private ActiveReleaseFenceOperationResult Rejected(string errorCode, bool dryRun)
        => new(false, false, "rejected", errorCode, dryRun, Current.Fence);

    private static ActiveReleaseFenceRuntimeSnapshot Unavailable(DateTimeOffset now, string errorCode)
        => new(
            new ActiveReleaseFenceSnapshot(false, ActiveReleaseFenceStatuses.Unavailable, string.Empty, string.Empty, 0, string.Empty, null, null),
            false,
            false,
            now,
            errorCode);
}

public sealed class ActiveReleaseFenceRefreshWorker(
    IActiveReleaseFence fence,
    IConfiguration configuration,
    TimeProvider timeProvider,
    IWebHostEnvironment environment,
    IHostApplicationLifetime applicationLifetime,
    ILogger<ActiveReleaseFenceRefreshWorker> logger) : BackgroundService
{
    private int _consecutiveFailures;
    private DateTimeOffset _lastSuccessfulRefreshAtUtc = fence.Current.StoreReachable
        ? fence.Current.RefreshedAtUtc
        : timeProvider.GetUtcNow();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!await RefreshOnceAsync(stoppingToken).ConfigureAwait(false))
            {
                return;
            }

            TimeSpan interval = ActiveReleaseFenceAvailabilityPolicy.RefreshInterval(configuration);
            await Task.Delay(interval, timeProvider, stoppingToken).ConfigureAwait(false);
        }
    }

    internal async Task<bool> RefreshOnceAsync(CancellationToken cancellationToken)
    {
        ActiveReleaseFenceRuntimeSnapshot snapshot;
        Exception? failure = null;
        try
        {
            snapshot = await fence.RefreshAsync(
                forceStoreRead: true,
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            failure = ex;
            snapshot = fence.Current;
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        if (snapshot.StoreReachable)
        {
            if (_consecutiveFailures > 0)
            {
                logger.LogInformation(
                    "active-release-fence-refresh-recovered consecutiveFailures={ConsecutiveFailures} staleSeconds={StaleSeconds}",
                    _consecutiveFailures,
                    Math.Max(0, (now - _lastSuccessfulRefreshAtUtc).TotalSeconds));
            }
            _consecutiveFailures = 0;
            _lastSuccessfulRefreshAtUtc = snapshot.RefreshedAtUtc;
            return true;
        }

        _consecutiveFailures++;
        TimeSpan staleFor = now > _lastSuccessfulRefreshAtUtc
            ? now - _lastSuccessfulRefreshAtUtc
            : TimeSpan.Zero;
        int failureLimit = ActiveReleaseFenceAvailabilityPolicy.FailuresBeforeShutdown(configuration);
        int escalationFailure = Math.Max(2, (int)Math.Ceiling(failureLimit / 2d));
        bool hardStale = _consecutiveFailures >= failureLimit
            || staleFor >= ActiveReleaseFenceAvailabilityPolicy.StaleThreshold(configuration);
        string errorCode = snapshot.ErrorCode ?? "active_release_fence_store_unavailable";
        ActiveReleaseFenceMetrics.RecordRefreshFailure(
            errorCode,
            _consecutiveFailures,
            staleFor,
            hardStale ? "hard" : "soft");

        if (_consecutiveFailures == 1)
        {
            logger.LogWarning(
                failure,
                "active-release-fence-refresh-failed errorCode={ErrorCode} consecutiveFailures={ConsecutiveFailures}",
                errorCode,
                _consecutiveFailures);
        }
        else if (!hardStale && _consecutiveFailures == escalationFailure)
        {
            logger.LogError(
                failure,
                "active-release-fence-refresh-stale-warning errorCode={ErrorCode} consecutiveFailures={ConsecutiveFailures} staleSeconds={StaleSeconds}",
                errorCode,
                _consecutiveFailures,
                staleFor.TotalSeconds);
        }

        if (!hardStale || !environment.IsProduction())
        {
            return true;
        }

        logger.LogCritical(
            failure,
            "active-release-fence-refresh-hard-stale errorCode={ErrorCode} consecutiveFailures={ConsecutiveFailures} staleSeconds={StaleSeconds}; requesting graceful shutdown",
            errorCode,
            _consecutiveFailures,
            staleFor.TotalSeconds);
        ActiveReleaseFenceMetrics.RecordRefreshShutdown(errorCode);
        applicationLifetime.StopApplication();
        return false;
    }
}

internal static class ActiveReleaseFenceMetricNames
{
    internal const string Operations = "fsus.active_release_fence.operations";
    internal const string Eligibility = "fsus.active_release_fence.eligibility";
    internal const string WitnessReconcile = "fsus.active_release_fence.witness_reconcile";
    internal const string WitnessGenerationGap = "fsus.active_release_fence.witness_generation_gap";
    internal const string RefreshFailures = "fsus.active_release_fence.refresh_failures";
    internal const string ConsecutiveRefreshFailures = "fsus.active_release_fence.refresh_consecutive_failures";
    internal const string RefreshStaleSeconds = "fsus.active_release_fence.refresh_stale_seconds";
    internal const string RefreshShutdowns = "fsus.active_release_fence.refresh_shutdowns";
}

public static class ActiveReleaseFenceMetrics
{
    private static readonly Meter Meter = new(FsusObservability.MeterName, "1.0.0");
    private static readonly Counter<long> Operations = Meter.CreateCounter<long>(ActiveReleaseFenceMetricNames.Operations);
    private static readonly Counter<long> Eligibility = Meter.CreateCounter<long>(ActiveReleaseFenceMetricNames.Eligibility);
    private static readonly Counter<long> WitnessReconcile = Meter.CreateCounter<long>(ActiveReleaseFenceMetricNames.WitnessReconcile);
    private static readonly Histogram<long> WitnessGenerationGap = Meter.CreateHistogram<long>(ActiveReleaseFenceMetricNames.WitnessGenerationGap);
    private static readonly Counter<long> RefreshFailures = Meter.CreateCounter<long>(ActiveReleaseFenceMetricNames.RefreshFailures);
    private static readonly Histogram<long> ConsecutiveRefreshFailures = Meter.CreateHistogram<long>(ActiveReleaseFenceMetricNames.ConsecutiveRefreshFailures);
    private static readonly Histogram<double> RefreshStaleSeconds = Meter.CreateHistogram<double>(ActiveReleaseFenceMetricNames.RefreshStaleSeconds);
    private static readonly Counter<long> RefreshShutdowns = Meter.CreateCounter<long>(ActiveReleaseFenceMetricNames.RefreshShutdowns);

    public static void RecordOperation(string operation, string result, string reason)
        => Operations.Add(1, new("operation", operation), new("result", result), new("reason", NormalizeReason(reason)));

    public static void RecordEligibility(string result, string reason)
        => Eligibility.Add(1, new("result", result), new("reason", NormalizeReason(reason)));

    public static void RecordWitnessReconcile(string result, string reason, long generationGap = 0)
    {
        WitnessReconcile.Add(1, new("result", result), new("reason", NormalizeReason(reason)));
        WitnessGenerationGap.Record(
            Math.Abs(generationGap),
            new KeyValuePair<string, object?>[]
            {
                new("result", result)
            });
    }

    public static void RecordRefreshFailure(
        string reason,
        int consecutiveFailures,
        TimeSpan staleFor,
        string severity)
    {
        var tags = new KeyValuePair<string, object?>[]
        {
            new("reason", NormalizeReason(reason)),
            new("severity", severity)
        };
        RefreshFailures.Add(1, tags);
        ConsecutiveRefreshFailures.Record(consecutiveFailures, tags);
        RefreshStaleSeconds.Record(Math.Max(0, staleFor.TotalSeconds), tags);
    }

    public static void RecordRefreshShutdown(string reason)
        => RefreshShutdowns.Add(
            1,
            new KeyValuePair<string, object?>[]
            {
                new("reason", NormalizeReason(reason))
            });

    private static string NormalizeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason) ? "unspecified" : reason.Trim().ToLowerInvariant();
}
