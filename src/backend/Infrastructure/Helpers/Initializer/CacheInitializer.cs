using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

public sealed record CacheInitializationRollbackEntry(int UserId, string AccountSubjectHash, BanStateSnapshot PreviousState);

public sealed record CacheInitializationResult(IReadOnlyList<CacheInitializationRollbackEntry> RollbackEntries)
{
    public static CacheInitializationResult Empty { get; } = new([]);
}

public interface ICacheInitializer
{
    Task<CacheInitializationResult> InitializeAsync();

    Task RollbackAsync(CacheInitializationResult result, CancellationToken cancellationToken = default);
}

/// <summary>
/// Warms ban-state caches in batches and records the previous state needed for rollback.
/// </summary>
// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public class CacheInitializer(ISqlSugarClient _db, IBlacklistService _blacklist, IUnifiedCache _cache) : ICacheInitializer
#pragma warning restore IDE1006
{
    public async Task<CacheInitializationResult> InitializeAsync()
    {
        var bannedUsers = await _db.Queryable<User>()
            .Where(u => u.Status == 1)
            .Select(u => new BannedUserCacheRow
            {
                Id = u.Id,
                AccountSubjectHash = u.AccountSubjectHash,
                BanReason = u.BanReason
            })
            .ToListAsync();

        if (bannedUsers.Count == 0)
        {
            return CacheInitializationResult.Empty;
        }

        List<CacheInitializationRollbackEntry> rollbackEntries = await LoadRollbackEntriesAsync(bannedUsers).ConfigureAwait(false);

        // LoadRollbackEntriesAsync routes through BlacklistService, which warms the versioned ban-state cache.
        return new CacheInitializationResult(rollbackEntries);
    }

    private async Task<List<CacheInitializationRollbackEntry>> LoadRollbackEntriesAsync(
        IReadOnlyList<BannedUserCacheRow> bannedUsers)
    {
        const int BatchSize = 100;
        var rollbackEntries = new List<CacheInitializationRollbackEntry>(bannedUsers.Count);
        var tasks = new List<Task<CacheInitializationRollbackEntry>>(BatchSize);
        for (int i = 0; i < bannedUsers.Count; i += BatchSize)
        {
            tasks.Clear();
            int count = Math.Min(BatchSize, bannedUsers.Count - i);
            for (int j = 0; j < count; j++)
            {
                BannedUserCacheRow user = bannedUsers[i + j];
                tasks.Add(LoadRollbackEntryAsync(user));
            }

            rollbackEntries.AddRange(await Task.WhenAll(tasks).ConfigureAwait(false));
        }

        return rollbackEntries;
    }

    private async Task<CacheInitializationRollbackEntry> LoadRollbackEntryAsync(BannedUserCacheRow user)
    {
        string accountSubjectHash = user.RequiredAccountSubjectHash;
        return new CacheInitializationRollbackEntry(
            user.Id,
            accountSubjectHash,
            await _blacklist.GetBanStateAsync(user.Id, accountSubjectHash).ConfigureAwait(false));
    }

    private static string BuildAccountSubjectCacheKey(string accountSubjectHash)
        => AccountSubjectHasher.BuildCacheKey(accountSubjectHash);

    private sealed class BannedUserCacheRow
    {
        public int Id
        {
            get; init;
        }

        public string? AccountSubjectHash
        {
            get; init;
        }

        public string? BanReason
        {
            get; init;
        }

        public string RequiredAccountSubjectHash
            => AccountSubjectHashRequirement.Require(AccountSubjectHash, "blacklist-cache-initializer");
    }

    public async Task RollbackAsync(CacheInitializationResult result, CancellationToken cancellationToken = default)
    {
        for (int i = 0; i < result.RollbackEntries.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CacheInitializationRollbackEntry entry = result.RollbackEntries[i];
            if (entry.PreviousState.IsBanned)
            {
                await _blacklist.BanUserAsync(entry.UserId, entry.PreviousState.Message).ConfigureAwait(false);
                continue;
            }

            await _cache.RemoveAsync(
                CachePolicyId.SecurityBlacklistUser,
                BuildAccountSubjectCacheKey(entry.AccountSubjectHash),
                cancellationToken).ConfigureAwait(false);
        }
    }
}
