using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

/// <summary>
/// 系统缓存初始化器
/// 修复日期: 2026-02-23 (引入并发批处理机制，消除串行 Redis 网络 I/O 带来的冷启动阻塞延迟，实现极速预热)
/// </summary>
public class CacheInitializer(ISqlSugarClient _db, IBlacklistService _blacklist)
{
    public async Task InitializeAsync()
    {
        // 1. 极速筛选 Status=1 的用户
        var bannedUsers = await _db.Queryable<User>()
                                   .Where(u => u.Status == 1)
                                   .Select(u => new { u.Id, u.BanReason })
                                   .ToListAsync();

        if (bannedUsers.Count == 0) return;

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
                tasks.Add(_blacklist.BanUserAsync(user.Id, user.BanReason ?? "违反社区规定"));
            }

            // 并发执行这一批次的 Redis 写入
            await Task.WhenAll(tasks);
        }
    }
}