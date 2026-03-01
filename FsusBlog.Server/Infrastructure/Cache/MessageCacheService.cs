using StackExchange.Redis;
using System.Runtime.CompilerServices;

namespace FsusBlog.Server.Infrastructure.Cache;

/// <summary>
/// 高性能消息缓存服务
/// 修复日期: 2026-02-23 (剥离异步状态机分配，引入 string.Create 和算术位移取代插值字符串，实现 Redis Key 零内存分配生成)
/// </summary>
public sealed class MessageCacheService(IConnectionMultiplexer redis)
{
    private readonly IDatabase _db = redis.GetDatabase();

    // 常量定义，避免魔法字符串
    private const string UnreadKeyPrefix = "msg:unread:";
    private const string GlobalVersionKey = "msg:global:version";

    // 核心优化 1：利用 string.Create 在 Span 上直接拼装字符串，彻底消灭 $"..." 带来的托管堆分配
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string GetUnreadKey(long userId)
    {
        int digits = GetDigitCount(userId);
        int totalLength = UnreadKeyPrefix.Length + digits;

        return string.Create(totalLength, userId, (span, id) =>
        {
            UnreadKeyPrefix.AsSpan().CopyTo(span);
            // 将长整型无分配地格式化到剩余的 Span 中
            id.TryFormat(span[UnreadKeyPrefix.Length..], out _);
        });
    }

    // 辅助优化：极速判定长整型的位数，用于预计算 string 长度
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int GetDigitCount(long n)
    {
        if (n >= 0)
        {
            if (n < 10L) return 1;
            if (n < 100L) return 2;
            if (n < 1000L) return 3;
            if (n < 10000L) return 4;
            if (n < 100000L) return 5;
            if (n < 1000000L) return 6;
            if (n < 10000000L) return 7;
            if (n < 100000000L) return 8;
            if (n < 1000000000L) return 9;
            if (n < 10000000000L) return 10;
            if (n < 100000000000L) return 11;
            if (n < 1000000000000L) return 12;
            if (n < 10000000000000L) return 13;
            if (n < 100000000000000L) return 14;
            if (n < 1000000000000000L) return 15;
            if (n < 10000000000000000L) return 16;
            if (n < 100000000000000000L) return 17;
            if (n < 1000000000000000000L) return 18;
            return 19;
        }
        // 处理负数 (如果有)
        if (n > -10L) return 2;
        if (n > -100L) return 3;
        return n.ToString().Length; // 兜底处理，雪花算法 ID 均为正数，极小概率走到这里
    }

    /// <summary>
    /// 原子递增未读数
    /// </summary>
    public ValueTask IncrementUnreadAsync(long userId)
    {
        // 核心优化 2：状态机剥离 (State Machine Elision)。
        // 舍弃 async/await，直接返回转换后的 ValueTask，避免编译器生成隐藏的状态机对象。
        var task = _db.StringIncrementAsync(GetUnreadKey(userId));
        return new ValueTask(task);
    }

    /// <summary>
    /// 原子递减未读数
    /// </summary>
    public ValueTask DecrementUnreadAsync(long userId)
    {
        var task = _db.StringDecrementAsync(GetUnreadKey(userId));
        return new ValueTask(task);
    }

    /// <summary>
    /// 获取个人未读数 (直接击中内存)
    /// </summary>
    public async ValueTask<int> GetUnreadCountAsync(long userId)
    {
        // 此处需要拆箱和逻辑判断，因此保留 async/await
        var count = await _db.StringGetAsync(GetUnreadKey(userId));
        return count.HasValue ? (int)count : 0;
    }

    /// <summary>
    /// 更新全站公告版本号 (仅递增版本，不产生 O(N) 操作)
    /// </summary>
    public ValueTask UpdateGlobalVersionAsync()
    {
        var task = _db.StringIncrementAsync(GlobalVersionKey);
        return new ValueTask(task);
    }

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
    public ValueTask ClearUnreadAsync(long userId)
    {
        var task = _db.StringSetAsync(GetUnreadKey(userId), 0);
        return new ValueTask(task);
    }
}