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
/// 系统缓存初始化器
/// 修复日期: 2026-02-23 (引入并发批处理机制，消除串行 Redis 网络 I/O 带来的冷启动阻塞延迟，实现极速预热)
/// </summary>
public class CacheInitializer(ISqlSugarClient _db, IBlacklistService _blacklist, IUnifiedCache _cache) : ICacheInitializer
{
    public async Task<CacheInitializationResult> InitializeAsync()
    {
        // 1. 极速筛选 Status=1 的用户
        var bannedUsers = await _db.Queryable<User>()
                                   .Where(u => u.Status == 1)
                                   .Select(u => new BannedUserCacheRow
                                   {
                                       Id = u.Id,
                                       IdentityKind = u.IdentityKind,
                                       PasskeyUserHandle = u.PasskeyUserHandle,
                                       PublicHandle = u.PublicHandle,
                                       BanReason = u.BanReason
                                   })
                                   .ToListAsync();

        if (bannedUsers.Count == 0)
        {
            return CacheInitializationResult.Empty;
        }

        List<CacheInitializationRollbackEntry> rollbackEntries = await LoadRollbackEntriesAsync(bannedUsers).ConfigureAwait(false);

        // 2. 并发预热 Redis (冷启动速度优化)
        // 核心优化：避免串行 await 带来的大量 RTT (往返时间) 堆叠。
        // 将请求分块，每批并发 100 个请求。既能将预热速度提升数十倍，又不会引发连接池饥饿。
        var tasks = new List<Task>(100);
        for (int i = 0; i < bannedUsers.Count; i += 100)
        {
            // 复用集合，拒绝在循环内创建 new List
            tasks.Clear();
            int count = Math.Min(100, bannedUsers.Count - i);

            for (int j = 0; j < count; j++)
            {
                var user = bannedUsers[i + j];
                tasks.Add(_cache.SetStringAsync(
                    CachePolicyId.SecurityBlacklistUser,
                    BuildAccountSubjectCacheKey(user.AccountSubjectHash),
                    user.BanReason ?? "违反社区规定"));
            }

            // 并发执行这一批次的 Redis 写入
            await Task.WhenAll(tasks);
        }

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
        => new(
            user.Id,
            user.AccountSubjectHash,
            await _blacklist.GetBanStateAsync(user.Id, user.AccountSubjectHash).ConfigureAwait(false));

    private static string BuildAccountSubjectCacheKey(string accountSubjectHash)
        => AccountSubjectHasher.BuildCacheKey(accountSubjectHash);

    private sealed class BannedUserCacheRow
    {
        public int Id { get; init; }

        public string? IdentityKind { get; init; }

        public string? PasskeyUserHandle { get; init; }

        public string? PublicHandle { get; init; }

        public string? BanReason { get; init; }

        public string AccountSubjectHash => AccountSubjectHasher.Create(new User
        {
            Id = Id,
            IdentityKind = IdentityKind ?? AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyUserHandle = PasskeyUserHandle,
            PublicHandle = PublicHandle
        });
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
