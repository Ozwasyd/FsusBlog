using FsusBlog.Server.Entities;
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

    /// <summary>
    /// 将用户加入黑名单
    /// </summary>
    public async Task BanUserAsync(int userId, string? reason)
    {
        var finalReason = NormalizeReason(reason);
        await cache.SetStringAsync(CachePolicyId.SecurityBlacklistUser, userId.ToString(), finalReason, TimeSpan.FromDays(7));
    }

    /// <summary>
    /// 从黑名单移除 (解封)
    /// </summary>
    public async Task UnbanUserAsync(int userId)
    {
        // 1. 更新数据库状态为正常
        await db.Updateable<User>()
            .SetColumns(u => u.Status == 0)
            .SetColumns(u => u.BanReason == null)
            .Where(u => u.Id == userId)
            .ExecuteCommandAsync();

        // 2. 移除缓存
        await cache.RemoveAsync(CachePolicyId.SecurityBlacklistUser, userId.ToString());
    }

    public async Task<BanStateSnapshot> GetBanStateAsync(int userId)
    {
        string? reason = await cache.GetStringAsync(CachePolicyId.SecurityBlacklistUser, userId.ToString());
        if (string.IsNullOrWhiteSpace(reason))
        {
            return new BanStateSnapshot(false, null, null);
        }

        return new BanStateSnapshot(true, BanReasonCode, reason);
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
