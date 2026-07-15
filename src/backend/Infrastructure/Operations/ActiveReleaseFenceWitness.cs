using System.Data.Common;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IActiveReleaseFenceDurableWitness : IActiveReleaseFenceStore
{
    Task ReconcileAsync(
        ActiveReleaseFenceSnapshot snapshot,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);
}

internal static class ActiveReleaseFenceTransitions
{
    public static ActiveReleaseFenceOperationResult Acquire(
        ActiveReleaseFenceSnapshot current,
        ActiveReleaseFenceAcquireRequest request,
        DateTimeOffset now)
    {
        ValidateIdentity(request.ReleaseId, request.Slot, request.Generation);
        if (string.IsNullOrWhiteSpace(request.ImageDigest))
        {
            throw new ArgumentException("Active release image digest is required.", nameof(request));
        }

        if (current.Exists
            && current.Generation == request.Generation
            && SameIdentity(current, request.ReleaseId, request.Slot, request.ImageDigest)
            && current.Status == ActiveReleaseFenceStatuses.Active)
        {
            return Accepted("already-active", current, request.DryRun, idempotent: true);
        }

        if (current.Exists)
        {
            if (string.IsNullOrWhiteSpace(request.ExpectedReleaseId)
                || string.IsNullOrWhiteSpace(request.ExpectedSlot)
                || !request.ExpectedGeneration.HasValue)
            {
                return Rejected("expected_current_required", current, request.DryRun);
            }

            if (!string.Equals(current.ReleaseId, request.ExpectedReleaseId.Trim(), StringComparison.Ordinal)
                || !string.Equals(current.Slot, request.ExpectedSlot.Trim(), StringComparison.Ordinal)
                || current.Generation != request.ExpectedGeneration.Value)
            {
                return Rejected("active_release_compare_failed", current, request.DryRun);
            }

            if (request.Generation < current.Generation)
            {
                return Rejected("active_release_generation_stale", current, request.DryRun);
            }
            if (request.Generation == current.Generation)
            {
                return Rejected("active_release_generation_not_monotonic", current, request.DryRun);
            }
        }

        var next = new ActiveReleaseFenceSnapshot(
            true,
            ActiveReleaseFenceStatuses.Active,
            request.ReleaseId.Trim(),
            request.Slot.Trim(),
            request.Generation,
            request.ImageDigest.Trim(),
            now,
            null);
        return Accepted(request.DryRun ? "would-acquire" : "acquired", next, request.DryRun);
    }

    public static ActiveReleaseFenceOperationResult Revoke(
        ActiveReleaseFenceSnapshot current,
        ActiveReleaseFenceRevokeRequest request,
        DateTimeOffset now)
    {
        ValidateIdentity(request.ReleaseId, request.Slot, request.Generation);
        if (!current.Exists)
        {
            return Accepted("already-absent", current, request.DryRun, idempotent: true);
        }
        if (!string.Equals(current.ReleaseId, request.ReleaseId.Trim(), StringComparison.Ordinal)
            || !string.Equals(current.Slot, request.Slot.Trim(), StringComparison.Ordinal)
            || current.Generation != request.Generation)
        {
            return Accepted("already-superseded", current, request.DryRun, idempotent: true);
        }
        if (current.Status == ActiveReleaseFenceStatuses.Revoked)
        {
            return Accepted("already-revoked", current, request.DryRun, idempotent: true);
        }

        ActiveReleaseFenceSnapshot next = current with
        {
            Status = ActiveReleaseFenceStatuses.Revoked,
            RevokedAtUtc = now
        };
        return Accepted(request.DryRun ? "would-revoke" : "revoked", next, request.DryRun);
    }

    public static ActiveReleaseFenceSnapshot Merge(
        ActiveReleaseFenceSnapshot first,
        ActiveReleaseFenceSnapshot second)
    {
        ValidateSnapshot(first);
        ValidateSnapshot(second);
        if (!first.Exists)
        {
            return second;
        }
        if (!second.Exists)
        {
            return first;
        }
        if (first.Generation != second.Generation)
        {
            return first.Generation > second.Generation ? first : second;
        }
        if (!SameIdentity(first, second.ReleaseId, second.Slot, second.ImageDigest))
        {
            throw new ActiveReleaseFenceStoreException(
                "active_release_fence_witness_diverged",
                "Active release fence witnesses contain different identities at the same generation.");
        }

        if (first.Status == second.Status)
        {
            return Latest(first, second);
        }
        if (first.Status == ActiveReleaseFenceStatuses.Revoked)
        {
            return first;
        }
        if (second.Status == ActiveReleaseFenceStatuses.Revoked)
        {
            return second;
        }

        throw new ActiveReleaseFenceStoreException(
            "active_release_fence_witness_diverged",
            "Active release fence witnesses contain incompatible statuses.");
    }

    private static ActiveReleaseFenceSnapshot Latest(
        ActiveReleaseFenceSnapshot first,
        ActiveReleaseFenceSnapshot second)
        => (first.RevokedAtUtc ?? first.ActivatedAtUtc) >= (second.RevokedAtUtc ?? second.ActivatedAtUtc)
            ? first
            : second;

    private static bool SameIdentity(
        ActiveReleaseFenceSnapshot snapshot,
        string releaseId,
        string slot,
        string imageDigest)
        => string.Equals(snapshot.ReleaseId, releaseId.Trim(), StringComparison.Ordinal)
            && string.Equals(snapshot.Slot, slot.Trim(), StringComparison.Ordinal)
            && string.Equals(snapshot.ImageDigest, imageDigest.Trim(), StringComparison.Ordinal);

    private static ActiveReleaseFenceOperationResult Accepted(
        string status,
        ActiveReleaseFenceSnapshot snapshot,
        bool dryRun,
        bool idempotent = false)
        => new(true, idempotent, status, null, dryRun, snapshot);

    private static ActiveReleaseFenceOperationResult Rejected(
        string errorCode,
        ActiveReleaseFenceSnapshot snapshot,
        bool dryRun)
        => new(false, false, "rejected", errorCode, dryRun, snapshot);

    private static void ValidateIdentity(string releaseId, string slot, long generation)
    {
        if (string.IsNullOrWhiteSpace(releaseId) || string.IsNullOrWhiteSpace(slot) || generation <= 0)
        {
            throw new ArgumentException("Active release identity and a positive generation are required.");
        }
    }

    internal static void ValidateSnapshot(ActiveReleaseFenceSnapshot snapshot)
    {
        if (!snapshot.Exists)
        {
            return;
        }
        if (snapshot.Generation <= 0
            || string.IsNullOrWhiteSpace(snapshot.ReleaseId)
            || string.IsNullOrWhiteSpace(snapshot.Slot)
            || string.IsNullOrWhiteSpace(snapshot.ImageDigest)
            || snapshot.Status is not ActiveReleaseFenceStatuses.Active and not ActiveReleaseFenceStatuses.Revoked)
        {
            throw new ActiveReleaseFenceStoreException(
                "active_release_fence_witness_invalid",
                "An active release fence witness contains an invalid snapshot.");
        }
    }
}

public sealed class SqlActiveReleaseFenceWitness(IServiceScopeFactory scopeFactory)
    : IActiveReleaseFenceDurableWitness
{
    private const string SelectSql = """
        SELECT release_id,
               slot,
               generation,
               image_digest,
               status,
               activated_at_utc,
               revoked_at_utc
        FROM sys_deployment_fence
        WHERE id = 1
        """;

    public async Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        return await ReadCoreAsync(db, lockForUpdate: false, cancellationToken).ConfigureAwait(false);
    }

    public async Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        ActiveReleaseFenceOperationResult? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(db).ConfigureAwait(false);
            ActiveReleaseFenceSnapshot current = await ReadCoreAsync(db, lockForUpdate: true, cancellationToken).ConfigureAwait(false);
            result = ActiveReleaseFenceTransitions.Acquire(current, request, now);
            if (result.Accepted && !result.Idempotent && !request.DryRun)
            {
                await UpsertCoreAsync(db, result.Snapshot).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
        return result ?? throw new InvalidOperationException("Active release fence transaction returned no result.");
    }

    public async Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        ActiveReleaseFenceOperationResult? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(db).ConfigureAwait(false);
            ActiveReleaseFenceSnapshot current = await ReadCoreAsync(db, lockForUpdate: true, cancellationToken).ConfigureAwait(false);
            result = ActiveReleaseFenceTransitions.Revoke(current, request, now);
            if (result.Accepted && !result.Idempotent && !request.DryRun)
            {
                await UpsertCoreAsync(db, result.Snapshot).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
        return result ?? throw new InvalidOperationException("Active release fence transaction returned no result.");
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

        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(db).ConfigureAwait(false);
            ActiveReleaseFenceSnapshot current = await ReadCoreAsync(db, lockForUpdate: true, cancellationToken).ConfigureAwait(false);
            ActiveReleaseFenceSnapshot merged = ActiveReleaseFenceTransitions.Merge(current, snapshot);
            if (!Equals(current, merged))
            {
                await UpsertCoreAsync(db, merged).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
    }

    private static async Task<ActiveReleaseFenceSnapshot> ReadCoreAsync(
        ISqlSugarClient db,
        bool lockForUpdate,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string sql = lockForUpdate ? SelectSql + " FOR UPDATE;" : SelectSql + ";";
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return RedisActiveReleaseFenceStore.MissingSnapshot();
        }

        return new ActiveReleaseFenceSnapshot(
            true,
            reader.GetString(4),
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt64(2),
            reader.GetString(3),
            ReadTimestamp(reader, 5),
            ReadTimestamp(reader, 6));
    }

    private static Task<int> UpsertCoreAsync(ISqlSugarClient db, ActiveReleaseFenceSnapshot snapshot)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO sys_deployment_fence(
                id, release_id, slot, generation, image_digest, status,
                activated_at_utc, revoked_at_utc, updated_at_utc)
            VALUES (
                1, @ReleaseId, @Slot, @Generation, @ImageDigest, @Status,
                @ActivatedAtUtc, @RevokedAtUtc, @UpdatedAtUtc)
            ON CONFLICT (id) DO UPDATE SET
                release_id = EXCLUDED.release_id,
                slot = EXCLUDED.slot,
                generation = EXCLUDED.generation,
                image_digest = EXCLUDED.image_digest,
                status = EXCLUDED.status,
                activated_at_utc = EXCLUDED.activated_at_utc,
                revoked_at_utc = EXCLUDED.revoked_at_utc,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@ReleaseId", snapshot.ReleaseId),
            new SugarParameter("@Slot", snapshot.Slot),
            new SugarParameter("@Generation", snapshot.Generation),
            new SugarParameter("@ImageDigest", snapshot.ImageDigest),
            new SugarParameter("@Status", snapshot.Status),
            new SugarParameter("@ActivatedAtUtc", DbTimestamp(snapshot.ActivatedAtUtc)),
            new SugarParameter("@RevokedAtUtc", DbTimestamp(snapshot.RevokedAtUtc)),
            new SugarParameter("@UpdatedAtUtc", DateTime.UtcNow));

    private static Task<int> AcquireMutationLockAsync(ISqlSugarClient db)
        => db.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(1179862354);");

    private static object DbTimestamp(DateTimeOffset? value)
        => value.HasValue ? value.Value.UtcDateTime : DBNull.Value;

    private static DateTimeOffset? ReadTimestamp(DbDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal)
            ? null
            : new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(ordinal), DateTimeKind.Utc));

    private static void EnsureTransaction(bool succeeded, Exception? exception)
    {
        if (!succeeded)
        {
            throw exception ?? new InvalidOperationException("Active release fence SQL transaction failed.");
        }
    }
}

public sealed class DurableActiveReleaseFenceStore(
    IActiveReleaseFenceReplicaStore redis,
    IActiveReleaseFenceDurableWitness durableWitness,
    IConfiguration configuration,
    ILogger<DurableActiveReleaseFenceStore> logger) : IActiveReleaseFenceStore
{
    public async Task<ActiveReleaseFenceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
    {
        Task<ReadOutcome> sqlRead = CaptureAsync(() => durableWitness.ReadAsync(cancellationToken));
        Task<ReadOutcome> redisRead = CaptureAsync(() => redis.ReadAsync(cancellationToken));
        await Task.WhenAll(sqlRead, redisRead).ConfigureAwait(false);

        ReadOutcome sql = await sqlRead.ConfigureAwait(false);
        ReadOutcome cache = await redisRead.ConfigureAwait(false);
        if (sql.Error is not null)
        {
            throw new ActiveReleaseFenceStoreException(
                "active_release_fence_durable_witness_unavailable",
                "The durable active release fence witness is unavailable.",
                sql.Error);
        }
        ActiveReleaseFenceSnapshot durable = sql.Snapshot!;
        ActiveReleaseFenceTransitions.ValidateSnapshot(durable);
        if (cache.Error is not null)
        {
            logger.LogWarning(cache.Error, "active-release-fence-redis-mirror-unavailable");
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("degraded", "redis_unavailable");
            return durable;
        }

        ActiveReleaseFenceSnapshot replica = cache.Snapshot!;
        ActiveReleaseFenceSnapshot winner;
        try
        {
            winner = ActiveReleaseFenceTransitions.Merge(durable, replica);
        }
        catch (ActiveReleaseFenceStoreException)
        {
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("rejected", "same_generation_divergence");
            throw;
        }

        long gap = durable.Generation - replica.Generation;
        if (!durable.Exists && replica.Exists)
        {
            await durableWitness.ReconcileAsync(replica, DateTimeOffset.UtcNow, cancellationToken).ConfigureAwait(false);
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("repaired", "sql_bootstrapped", gap);
        }
        else if (durable.Exists && !replica.Exists)
        {
            await redis.ReconcileAsync(durable, DateTimeOffset.UtcNow, cancellationToken).ConfigureAwait(false);
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("repaired", "redis_restored", gap);
        }
        else if (durable.Exists && replica.Exists && !SameFenceState(durable, replica))
        {
            if (Equals(winner, durable))
            {
                await redis.ReconcileAsync(winner, DateTimeOffset.UtcNow, cancellationToken).ConfigureAwait(false);
                ActiveReleaseFenceMetrics.RecordWitnessReconcile("repaired", "redis_advanced", gap);
            }
            else
            {
                await durableWitness.ReconcileAsync(winner, DateTimeOffset.UtcNow, cancellationToken).ConfigureAwait(false);
                ActiveReleaseFenceMetrics.RecordWitnessReconcile("repaired", "sql_advanced", gap);
            }
        }
        else
        {
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("converged", "current", gap);
        }

        return winner;
    }

    public async Task<ActiveReleaseFenceOperationResult> AcquireAsync(
        ActiveReleaseFenceAcquireRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceSnapshot baseline = await ReadAsync(cancellationToken).ConfigureAwait(false);
        if (!MutationEnabled())
        {
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("rejected", "mutation_paused");
            return MutationPaused(request.DryRun, baseline);
        }

        ActiveReleaseFenceOperationResult result = await durableWitness
            .AcquireAsync(request, now, cancellationToken)
            .ConfigureAwait(false);
        if (result.Accepted && !request.DryRun)
        {
            await redis.ReconcileAsync(result.Snapshot, now, cancellationToken).ConfigureAwait(false);
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("converged", "sql_first_acquire");
        }
        return result;
    }

    public async Task<ActiveReleaseFenceOperationResult> RevokeAsync(
        ActiveReleaseFenceRevokeRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseFenceSnapshot baseline = await ReadAsync(cancellationToken).ConfigureAwait(false);
        if (!MutationEnabled())
        {
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("rejected", "mutation_paused");
            return MutationPaused(request.DryRun, baseline);
        }

        ActiveReleaseFenceOperationResult result = await durableWitness
            .RevokeAsync(request, now, cancellationToken)
            .ConfigureAwait(false);
        if (result.Accepted && !request.DryRun && result.Snapshot.Exists)
        {
            await redis.ReconcileAsync(result.Snapshot, now, cancellationToken).ConfigureAwait(false);
            ActiveReleaseFenceMetrics.RecordWitnessReconcile("converged", "sql_first_revoke");
        }
        return result;
    }

    private bool MutationEnabled()
        => configuration.GetValue("ActiveReleaseFence:MutationEnabled", true);

    private static bool SameFenceState(
        ActiveReleaseFenceSnapshot first,
        ActiveReleaseFenceSnapshot second)
        => first.Exists == second.Exists
            && first.Status == second.Status
            && first.ReleaseId == second.ReleaseId
            && first.Slot == second.Slot
            && first.Generation == second.Generation
            && first.ImageDigest == second.ImageDigest;

    private static ActiveReleaseFenceOperationResult MutationPaused(
        bool dryRun,
        ActiveReleaseFenceSnapshot snapshot)
        => new(
            false,
            false,
            "rejected",
            "active_release_fence_mutation_paused",
            dryRun,
            snapshot);

    private static async Task<ReadOutcome> CaptureAsync(Func<Task<ActiveReleaseFenceSnapshot>> read)
    {
        try
        {
            return new ReadOutcome(await read().ConfigureAwait(false), null);
        }
        catch (Exception ex)
        {
            return new ReadOutcome(null, ex);
        }
    }

    private sealed record ReadOutcome(ActiveReleaseFenceSnapshot? Snapshot, Exception? Error);
}
