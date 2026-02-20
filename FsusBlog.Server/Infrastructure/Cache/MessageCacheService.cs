using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Cache;

/// <summary>
/// 高性能消息缓存服务
/// </summary>
public sealed class MessageCacheService(IConnectionMultiplexer redis)
{
    private readonly IDatabase _db = redis.GetDatabase();

    // 常量定义，避免魔法字符串
    private static string GetUnreadKey(long userId) => $"msg:unread:{userId}";
    private const string GlobalVersionKey = "msg:global:version";

    /// <summary>
    /// 原子递增未读数
    /// </summary>
    public async ValueTask IncrementUnreadAsync(long userId)
        => await _db.StringIncrementAsync(GetUnreadKey(userId));

    /// <summary>
    /// 原子递减未读数
    /// </summary>
    public async ValueTask DecrementUnreadAsync(long userId)
    {
        var key = GetUnreadKey(userId);
        // 为了极致性能，直接调用转子减
        // 业务层 MarkAsReadAsync 已确保 affected > 0 才会调用此方法
        await _db.StringDecrementAsync(key);
    }

    /// <summary>
    /// 获取个人未读数 (直接击中内存)
    /// </summary>
    public async ValueTask<int> GetUnreadCountAsync(long userId)
    {
        var count = await _db.StringGetAsync(GetUnreadKey(userId));
        return count.HasValue ? (int)count : 0;
    }

    /// <summary>
    /// 更新全站公告版本号 (仅递增版本，不产生 O(N) 操作)
    /// </summary>
    public async ValueTask UpdateGlobalVersionAsync()
        => await _db.StringIncrementAsync(GlobalVersionKey);

    /// <summary>
    /// 获取当前全站公告版本
    /// </summary>
    public async ValueTask<long> GetGlobalVersionAsync()
    {
        var version = await _db.StringGetAsync(GlobalVersionKey);
        return version.HasValue ? (long)version : 0;
    }

    /// <summary>
    /// 清减/重置计数器
    /// </summary>
    public async ValueTask ClearUnreadAsync(long userId)
        => await _db.StringSetAsync(GetUnreadKey(userId), 0);
}
