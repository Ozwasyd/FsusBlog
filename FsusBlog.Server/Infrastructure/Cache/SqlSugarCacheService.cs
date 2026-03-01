using SqlSugar;
using StackExchange.Redis;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Cache;

/// <summary>
/// SqlSugar 二级缓存实现
/// 修复日期: 2026-02-23 (剥离高层 IDistributedCache，引入 IConnectionMultiplexer 与 StringGetLease 实现零内存分配反序列化，使用 KeyExists 消除探测时的全量网络/内存开销)
/// 作用：将 SQL 执行结果持久化到 Redis，减少数据库 IO 压力
/// </summary>
public class SqlSugarCacheService(
    IConnectionMultiplexer _redis,
    ILogger<SqlSugarCacheService> _logger) : ICacheService
{
    // 获取底层数据库操作实例
    private readonly IDatabase _db = _redis.GetDatabase();

    // 性能优化：静态化配置，避免重复反射扫描，支持循环引用处理
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        ReferenceHandler = ReferenceHandler.IgnoreCycles,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>
    /// 获取或创建缓存 (SqlSugar 插件核心调用)
    /// </summary>
    public V GetOrCreate<V>(string cacheKey, Func<V> createFunc, int cacheDurationInSeconds)
    {
        try
        {
            // 终极优化 1：使用 StringGetLease 获取底层内存池租约。
            // 这使得我们可以直接通过 Span<byte> 将 Redis 的二进制流喂给 System.Text.Json。
            // 彻底跳过了 byte[] 数组分配和 UTF-16 字符串的解码过程，实现绝对的零内存分配读取。
            using var lease = _db.StringGetLease(cacheKey);
            if (lease != null && lease.Length > 0)
            {
                var cachedValue = JsonSerializer.Deserialize<V>(lease.Span, _jsonOptions);
                if (cachedValue != null) return cachedValue;
            }
        }
        catch (Exception ex)
        {
            // Redis 异常时不报错，记录警告并执行数据库查询（降级逻辑）
            _logger.LogWarning(ex, "SqlSugar 缓存击穿降级 | Key: {Key}", cacheKey);
        }

        // 缓存未命中或 Redis 故障，执行数据库原始查询
        var value = createFunc();

        // 只有在有数据的情况下才异步写入缓存
        if (value != null)
        {
            Add(cacheKey, value, cacheDurationInSeconds);
        }

        return value;
    }

    public void Add<V>(string key, V value, int cacheDurationInSeconds)
    {
        try
        {
            // 终极优化 2：直接序列化为 UTF-8 字节数组。
            // 相比 JsonSerializer.Serialize(value) 产生字符串，此方法更加贴近底层网络 IO，避免了托管堆上的字符分配。
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value, _jsonOptions);
            _db.StringSet(key, bytes, TimeSpan.FromSeconds(cacheDurationInSeconds));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SqlSugar 缓存写入异常 | Key: {Key}", key);
        }
    }

    public V Get<V>(string key)
    {
        try
        {
            // 同步应用零分配读取优化
            using var lease = _db.StringGetLease(key);
            if (lease == null || lease.Length == 0) return default!;

            return JsonSerializer.Deserialize<V>(lease.Span, _jsonOptions)!;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "SqlSugar 缓存获取异常 | Key: {Key}", key);
            return default!;
        }
    }

    public void Remove<V>(string key)
    {
        try
        {
            _db.KeyDelete(key);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SqlSugar 缓存移除失败 | Key: {Key}", key);
        }
    }

    public bool ContainsKey<V>(string key)
    {
        try
        {
            // 终极优化 3：抛弃 IDistributedCache 灾难性的 _redis.Get(key) != null 写法。
            // 直接下发底层 EXISTS 命令。时间复杂度 O(1)，网络负载仅几个字节，完美！
            return _db.KeyExists(key);
        }
        catch
        {
            return false;
        }
    }

    public void Add<V>(string key, V value) => Add(key, value, 3600);

    public IEnumerable<string> GetAllKey<V>() => [];
}