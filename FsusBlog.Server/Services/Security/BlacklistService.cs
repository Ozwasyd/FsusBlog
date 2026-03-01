using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public class BlacklistService(
    IConnectionMultiplexer redis,
    ISqlSugarClient db) : IBlacklistService
{
    private readonly IDatabase _redis = redis.GetDatabase();
    private const string BlacklistKey = "sys:user:blacklist";

    /// <summary>
    /// 将用户加入黑名单
    /// </summary>
    public async Task BanUserAsync(int userId, string? reason)
    {
        string finalReason = string.IsNullOrWhiteSpace(reason) ? "账号异常，已被系统封禁" : reason;
        await _redis.HashSetAsync(BlacklistKey, userId, finalReason);
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
        await _redis.HashDeleteAsync(BlacklistKey, userId);
    }

    public async Task<string?> GetBanReasonAsync(int userId)
    {
        return await _redis.HashGetAsync(BlacklistKey, userId);
    }

    public async Task<bool> IsBannedAsync(int userId)
    {
        return await _redis.HashExistsAsync(BlacklistKey, userId);
    }
}
