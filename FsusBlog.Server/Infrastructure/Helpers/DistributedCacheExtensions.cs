using Microsoft.Extensions.Caching.Distributed;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Helpers;

/// <summary>
/// 分布式缓存高性能扩展
/// 核心目标：消除中间字符串分配，实现字节级序列化效率
/// </summary>
public static class DistributedCacheExtensions
{
    // 🚀 性能基石：静态配置选项，处理循环引用并压缩存储体积
    private static readonly JsonSerializerOptions _defaultOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReferenceHandler = ReferenceHandler.IgnoreCycles, // 关键：解决实体导航属性循环引用
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull // 关键：压缩 Redis 占用
    };

    /// <summary>
    /// 高性能异步获取缓存对象
    /// </summary>
    public static async Task<T?> GetAsync<T>(this IDistributedCache cache, string key, CancellationToken token = default)
    {
        // 1. 获取原始字节数组
        var data = await cache.GetAsync(key, token);

        if (data == null || data.Length == 0) return default;

        try
        {
            // 2. ⚡ 性能优化点：直接从 UTF8 字节流反序列化，避免 GetString 产生的内存开销
            return JsonSerializer.Deserialize<T>(data, _defaultOptions);
        }
        catch (JsonException)
        {
            // 容错策略：如果缓存数据损坏，主动清理该 Key 并降级，触发后续的数据库重查
            await cache.RemoveAsync(key, token);
            return default;
        }
    }

    /// <summary>
    /// 高性能异步设置缓存对象
    /// </summary>
    public static async Task SetAsync<T>(this IDistributedCache cache, string key, T value, DistributedCacheEntryOptions options, CancellationToken token = default)
    {
        if (value == null) return;

        // ⚡ 性能优化点：直接序列化为字节数组，不经过字符串中转
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, _defaultOptions);

        await cache.SetAsync(key, bytes, options, token);
    }

    /// <summary>
    /// 快捷设置异步缓存 (默认滑动过期)
    /// </summary>
    public static async Task SetAsync<T>(this IDistributedCache cache, string key, T value, TimeSpan? slidingExpiration = null, CancellationToken token = default)
    {
        var options = new DistributedCacheEntryOptions
        {
            SlidingExpiration = slidingExpiration ?? TimeSpan.FromHours(1)
        };

        await SetAsync(cache, key, value, options, token);
    }
}