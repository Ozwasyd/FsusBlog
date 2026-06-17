using FsusBlog.Server.Entities;
using Microsoft.Extensions.Configuration;
using SqlSugar;

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

        CommentAnonymousNullifier? existing = await db.Queryable<CommentAnonymousNullifier>()
            .Where(n => n.NullifierHash == normalizedHash && n.Scope == normalizedScope)
            .FirstAsync();
        if (existing is null)
        {
            var reserved = new CommentAnonymousNullifier
            {
                NullifierHash = normalizedHash,
                Scope = normalizedScope,
                UseCount = 0,
                CreatedAtUtc = DateTime.UtcNow,
                UpdatedAtUtc = DateTime.UtcNow
            };
            await db.Insertable(reserved).ExecuteCommandAsync();
            return new NullifierReservationResult(true, "reserved", "Nullifier reserved", 0);
        }

        if (existing.Blocked)
        {
            return new NullifierReservationResult(false, "blocked", "Nullifier is blocked", existing.UseCount);
        }

        return existing.UseCount < maxUseCount
            ? new NullifierReservationResult(true, "reserved", "Nullifier already reserved", existing.UseCount)
            : new NullifierReservationResult(false, "scope_limit_exceeded", "Nullifier scope limit exceeded", existing.UseCount);
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

        CommentAnonymousNullifier? existing = await db.Queryable<CommentAnonymousNullifier>()
            .Where(n => n.NullifierHash == normalizedHash && n.Scope == normalizedScope)
            .FirstAsync();
        if (existing is null)
        {
            var created = new CommentAnonymousNullifier
            {
                NullifierHash = normalizedHash,
                Scope = normalizedScope,
                UseCount = 1,
                FirstCommentId = commentId,
                LastCommentId = commentId,
                CreatedAtUtc = now,
                UpdatedAtUtc = now
            };
            return await db.Insertable(created).ExecuteCommandAsync() > 0;
        }

        return await db.Updateable<CommentAnonymousNullifier>()
            .SetColumns(n => n.UseCount == n.UseCount + 1)
            .SetColumns(n => n.FirstCommentId == (n.FirstCommentId ?? commentId))
            .SetColumns(n => n.LastCommentId == commentId)
            .SetColumns(n => n.UpdatedAtUtc == now)
            .Where(n => n.NullifierHash == normalizedHash && n.Scope == normalizedScope && !n.Blocked)
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
}
