using System.Data.Common;
using System.Diagnostics;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface ICommentAnonymousNullifierService
{
    Task<NullifierReservationResult> PrecheckAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default)
        => CheckAndReserveAsync(nullifierHash, scope, cancellationToken);

    Task<NullifierReservationResult> CheckAndReserveAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default);

    async Task<NullifierReservationResult> TryConsumeAsync(
        string nullifierHash,
        string scope,
        long commentId,
        CancellationToken cancellationToken = default)
    {
        NullifierReservationResult reserved = await CheckAndReserveAsync(nullifierHash, scope, cancellationToken);
        if (!reserved.Allowed)
        {
            return reserved;
        }

        bool linked = await IncrementUsageAsync(nullifierHash, scope, commentId, cancellationToken);
        return linked
            ? reserved
            : new NullifierReservationResult(false, "scope_limit_exceeded", "Anonymous nullifier usage could not be linked.", reserved.CurrentUseCount);
    }

    Task<bool> IncrementUsageAsync(
        string nullifierHash,
        string scope,
        long commentId,
        CancellationToken cancellationToken = default);

    Task<bool> BlockAsync(
        string nullifierHash,
        string scope,
        string reason,
        CancellationToken cancellationToken = default);
}

public sealed class CommentAnonymousNullifierService(
    ISqlSugarClient db,
    IConfiguration configuration) : ICommentAnonymousNullifierService
{
    public async Task<NullifierReservationResult> PrecheckAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        int maxUseCount = ResolveMaxUseCount(normalizedScope);

        FsusObservability.RecordAnonymousNullifierPrecheck();
        NullifierState? state = await TryReadStateAsync(normalizedHash, normalizedScope, cancellationToken);
        if (state is null)
        {
            return new NullifierReservationResult(true, "prechecked", "Nullifier has no prior usage", 0);
        }

        if (state.Value.Blocked)
        {
            FsusObservability.RecordAnonymousNullifierRejected("blocked");
            return new NullifierReservationResult(false, "blocked", "Nullifier is blocked", state.Value.UseCount);
        }

        if (state.Value.UseCount >= maxUseCount)
        {
            FsusObservability.RecordAnonymousNullifierRejected("scope_limit_exceeded");
            return new NullifierReservationResult(false, "scope_limit_exceeded", "Nullifier scope limit exceeded", state.Value.UseCount);
        }

        return new NullifierReservationResult(true, "prechecked", "Nullifier prechecked", state.Value.UseCount);
    }

    public async Task<NullifierReservationResult> CheckAndReserveAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        int maxUseCount = ResolveMaxUseCount(normalizedScope);

        DateTime now = DateTime.UtcNow;
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO comment_anonymous_nullifier
                (nullifier_hash, scope, use_count, blocked, created_at_utc, updated_at_utc)
            VALUES
                (@NullifierHash, @Scope, 0, false, @Now, @Now)
            ON CONFLICT (nullifier_hash, scope) DO NOTHING;
            """,
            new SugarParameter("@NullifierHash", normalizedHash),
            new SugarParameter("@Scope", normalizedScope),
            new SugarParameter("@Now", now));

        using var reservedReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE comment_anonymous_nullifier
            SET use_count = use_count + 1,
                updated_at_utc = @Now
            WHERE nullifier_hash = @NullifierHash
              AND scope = @Scope
              AND blocked = false
              AND use_count < @MaxUseCount
            RETURNING blocked, use_count;
            """,
            new SugarParameter("@NullifierHash", normalizedHash),
            new SugarParameter("@Scope", normalizedScope),
            new SugarParameter("@MaxUseCount", maxUseCount),
            new SugarParameter("@Now", now));
        if (await reservedReader.ReadAsync(cancellationToken))
        {
            int reservedUseCount = reservedReader.ReadInt32("use_count");
            return new NullifierReservationResult(true, "reserved", "Nullifier reserved", reservedUseCount);
        }

        NullifierState state = await ReadStateAsync(normalizedHash, normalizedScope, cancellationToken);
        return state.Blocked
            ? new NullifierReservationResult(false, "blocked", "Nullifier is blocked", state.UseCount)
            : new NullifierReservationResult(false, "scope_limit_exceeded", "Nullifier scope limit exceeded", state.UseCount);
    }

    public async Task<NullifierReservationResult> TryConsumeAsync(
        string nullifierHash,
        string scope,
        long commentId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        int maxUseCount = ResolveMaxUseCount(normalizedScope);
        DateTime now = DateTime.UtcNow;
        long startedAt = Stopwatch.GetTimestamp();

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH consumed AS (
                INSERT INTO comment_anonymous_nullifier
                    (nullifier_hash, scope, use_count, blocked, first_comment_id, last_comment_id, created_at_utc, updated_at_utc)
                VALUES
                    (@NullifierHash, @Scope, 1, false, @CommentId, @CommentId, @Now, @Now)
                ON CONFLICT (nullifier_hash, scope) DO UPDATE
                SET use_count = comment_anonymous_nullifier.use_count + 1,
                    first_comment_id = COALESCE(comment_anonymous_nullifier.first_comment_id, @CommentId),
                    last_comment_id = @CommentId,
                    updated_at_utc = @Now
                WHERE comment_anonymous_nullifier.blocked = false
                  AND comment_anonymous_nullifier.use_count < @MaxUseCount
                RETURNING true AS allowed, 'reserved'::text AS status, use_count
            ),
            current_state AS (
                SELECT blocked, use_count
                FROM comment_anonymous_nullifier
                WHERE nullifier_hash = @NullifierHash AND scope = @Scope
            )
            SELECT allowed, status, use_count
            FROM consumed
            UNION ALL
            SELECT
                false AS allowed,
                CASE WHEN blocked THEN 'blocked' ELSE 'scope_limit_exceeded' END AS status,
                use_count
            FROM current_state
            WHERE NOT EXISTS (SELECT 1 FROM consumed)
            LIMIT 1;
            """,
            new SugarParameter("@NullifierHash", normalizedHash),
            new SugarParameter("@Scope", normalizedScope),
            new SugarParameter("@CommentId", commentId),
            new SugarParameter("@MaxUseCount", maxUseCount),
            new SugarParameter("@Now", now));
        if (!await reader.ReadAsync(cancellationToken))
        {
            return new NullifierReservationResult(false, "scope_limit_exceeded", "Nullifier scope limit exceeded", maxUseCount);
        }

        bool allowed = reader.ReadBoolean("allowed");
        string status = reader.ReadString("status");
        int useCount = reader.ReadInt32("use_count");
        if (!allowed && string.Equals(status, "scope_limit_exceeded", StringComparison.Ordinal))
        {
            // PostgreSQL keeps the statement snapshot taken before an ON CONFLICT
            // waiter is released. A rejected concurrent writer can therefore see
            // the pre-wait count even though the row has reached the policy limit.
            // The rejection is only possible once the limit has been reached, so
            // return a stable lower bound without hiding rows created under a
            // previously higher limit.
            useCount = Math.Max(useCount, maxUseCount);
        }
        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        FsusObservability.RecordAnonymousNullifierAtomicIncrement(elapsed, status);
        if (!allowed)
        {
            FsusObservability.RecordAnonymousNullifierRejected(status);
        }

        return allowed
            ? new NullifierReservationResult(true, status, "Nullifier reserved", useCount)
            : new NullifierReservationResult(false, status, status, useCount);
    }

    public async Task<bool> IncrementUsageAsync(
        string nullifierHash,
        string scope,
        long commentId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        DateTime now = DateTime.UtcNow;
        int maxUseCount = ResolveMaxUseCount(normalizedScope);

        return await db.Updateable<CommentAnonymousNullifier>()
            .SetColumns(n => n.FirstCommentId == (n.FirstCommentId ?? commentId))
            .SetColumns(n => n.LastCommentId == commentId)
            .SetColumns(n => n.UpdatedAtUtc == now)
            .Where(n => n.NullifierHash == normalizedHash
                && n.Scope == normalizedScope
                && !n.Blocked
                && n.UseCount <= maxUseCount)
            .ExecuteCommandAsync() > 0;
    }

    public async Task<bool> BlockAsync(
        string nullifierHash,
        string scope,
        string reason,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        string normalizedReason = string.IsNullOrWhiteSpace(reason) ? "blocked_by_admin" : reason.Trim();

        return await db.Updateable<CommentAnonymousNullifier>()
            .SetColumns(n => n.Blocked == true)
            .SetColumns(n => n.BlockReason == normalizedReason)
            .SetColumns(n => n.UpdatedAtUtc == DateTime.UtcNow)
            .Where(n => n.NullifierHash == normalizedHash && n.Scope == normalizedScope)
            .ExecuteCommandAsync() > 0;
    }

    private int ResolveMaxUseCount(string scope)
        => AnonymousCommentScopePolicy.TryParse(scope, out AnonymousCommentScopeDescriptor descriptor)
            ? descriptor.MaxUsesPerCredential
            : Math.Max(1, configuration.GetValue("AnonymousIdentity:NullifierScopeUseLimit", 1));

    private static string NormalizeRequired(string value, string name)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException($"{name} is required", name);
        }

        return normalized;
    }

    private async Task<NullifierState> ReadStateAsync(string nullifierHash, string scope, CancellationToken cancellationToken)
    {
        NullifierState? state = await TryReadStateAsync(nullifierHash, scope, cancellationToken);
        if (state is null)
        {
            throw new InvalidOperationException("Anonymous nullifier reservation was not created.");
        }

        return state.Value;
    }

    private async Task<NullifierState?> TryReadStateAsync(string nullifierHash, string scope, CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT blocked, use_count
            FROM comment_anonymous_nullifier
            WHERE nullifier_hash = @NullifierHash AND scope = @Scope;
            """,
            new SugarParameter("@NullifierHash", nullifierHash),
            new SugarParameter("@Scope", scope));
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new NullifierState(reader.ReadBoolean("blocked"), reader.ReadInt32("use_count"));
    }

    private readonly record struct NullifierState(bool Blocked, int UseCount);
}
