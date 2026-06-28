using FsusBlog.Server.Entities;
using Microsoft.Extensions.Configuration;
using SqlSugar;
using System.Data.Common;

namespace FsusBlog.Server.Services.Security;

public interface ICommentAnonymousNullifierService
{
    Task<NullifierReservationResult> CheckAndReserveAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default);

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
    public async Task<NullifierReservationResult> CheckAndReserveAsync(
        string nullifierHash,
        string scope,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedHash = NormalizeRequired(nullifierHash, nameof(nullifierHash));
        string normalizedScope = NormalizeRequired(scope, nameof(scope));
        int maxUseCount = Math.Max(1, configuration.GetValue("AnonymousIdentity:NullifierScopeUseLimit", 1));

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
            int reservedUseCount = reservedReader.GetInt32(1);
            return new NullifierReservationResult(true, "reserved", "Nullifier reserved", reservedUseCount);
        }

        NullifierState state = await ReadStateAsync(normalizedHash, normalizedScope, cancellationToken);
        return state.Blocked
            ? new NullifierReservationResult(false, "blocked", "Nullifier is blocked", state.UseCount)
            : new NullifierReservationResult(false, "scope_limit_exceeded", "Nullifier scope limit exceeded", state.UseCount);
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
        int maxUseCount = Math.Max(1, configuration.GetValue("AnonymousIdentity:NullifierScopeUseLimit", 1));

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
            throw new InvalidOperationException("Anonymous nullifier reservation was not created.");
        }

        return new NullifierState(reader.GetBoolean(0), reader.GetInt32(1));
    }

    private readonly record struct NullifierState(bool Blocked, int UseCount);
}
