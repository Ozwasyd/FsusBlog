using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

public class CacheInitializer(ISqlSugarClient _db, IBlacklistService _blacklist)
{
    public async Task InitializeAsync()
    {
        // 1. 极速筛选 Status=1 的用户
        var bannedUsers = await _db.Queryable<User>()
                                   .Where(u => u.Status == 1)
                                   .Select(u => new { u.Id, u.BanReason })
                                   .ToListAsync();

        // 2. 预热 Redis
        foreach (var user in bannedUsers)
        {
            await _blacklist.BanUserAsync(user.Id, user.BanReason ?? "违反社区规定");
        }
    }
}
