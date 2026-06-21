using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public class BlacklistService(
    IUnifiedCache cache,
    ISqlSugarClient db) : IBlacklistService
{
    private const int MaxBanReasonLength = 256;
    private const string BanReasonCode = "manual_ban";
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;

    /// <summary>
    /// 将用户加入黑名单
    /// </summary>
    public async Task BanUserAsync(int userId, string? reason)
    {
        var finalReason = NormalizeReason(reason);
        await db.Updateable<User>()
            .SetColumns(u => u.Status == UserStatusBanned)
            .SetColumns(u => u.BanReason == finalReason)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        string cacheKey = await ResolveAccountSubjectCacheKeyAsync(userId).ConfigureAwait(false);
        await cache.SetStringAsync(CachePolicyId.SecurityBlacklistUser, cacheKey, finalReason);
    }

    /// <summary>
    /// 从黑名单移除 (解封)
    /// </summary>
    public async Task UnbanUserAsync(int userId)
    {
        // 1. 更新数据库状态为正常
        await db.Updateable<User>()
            .SetColumns(u => u.Status == UserStatusNormal)
            .SetColumns(u => u.BanReason == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        // 2. 移除缓存
        string cacheKey = await ResolveAccountSubjectCacheKeyAsync(userId).ConfigureAwait(false);
        await cache.RemoveAsync(CachePolicyId.SecurityBlacklistUser, cacheKey);
    }

    public async Task<BanStateSnapshot> GetBanStateAsync(int accountId, string accountSubjectHash)
    {
        string cacheKey = BuildAccountSubjectCacheKey(accountSubjectHash);
        string? reason = await cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, cacheKey);
        if (string.IsNullOrWhiteSpace(reason))
        {
            var user = await db.Queryable<User>().InSingleAsync(accountId);
            if (user is null || user.Status != UserStatusBanned)
            {
                return new BanStateSnapshot(false, null, null);
            }

            reason = NormalizeReason(user.BanReason);
            await cache.SetStringAsync(CachePolicyId.SecurityBlacklistUser, cacheKey, reason);
        }

        return new BanStateSnapshot(true, BanReasonCode, reason);
    }

    internal static string BuildAccountSubjectCacheKey(string accountSubjectHash)
        => AccountSubjectHasher.BuildCacheKey(accountSubjectHash);

    private async Task<string> ResolveAccountSubjectCacheKeyAsync(int accountId)
    {
        User? user = await db.Queryable<User>().InSingleAsync(accountId).ConfigureAwait(false);
        string subjectHash = user is null
            ? AccountSubjectHasher.Create(AnonymousIdentityRuntime.AnonymousAccountKind, string.Concat("legacy-account:", accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            : AccountSubjectHasher.Create(user);
        return BuildAccountSubjectCacheKey(subjectHash);
    }

    private static string NormalizeReason(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason))
        {
            return "账号异常，已被系统封禁";
        }

        var value = reason.Trim();
        return value.Length > MaxBanReasonLength ? value[..MaxBanReasonLength] : value;
    }
}
