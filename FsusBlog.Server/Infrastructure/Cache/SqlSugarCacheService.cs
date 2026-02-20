using Microsoft.Extensions.Caching.Distributed;
using SqlSugar;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Cache;

/// <summary>
/// SqlSugar 二级缓存实现
/// 作用：将 SQL 执行结果持久化到 Redis，减少数据库 IO 压力
/// </summary>
public class SqlSugarCacheService(
    IDistributedCache _redis,
    ILogger<SqlSugarCacheService> _logger) : ICacheService
{
    // 🚀 性能优化：静态化配置，避免重复反射扫描，支持循环引用处理
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
            var json = _redis.GetString(cacheKey);
            if (!string.IsNullOrEmpty(json))
            {
                var cachedValue = JsonSerializer.Deserialize<V>(json, _jsonOptions);
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
            var json = JsonSerializer.Serialize(value, _jsonOptions);
            _redis.SetString(key, json, new DistributedCacheEntryOptions
            {
                AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(cacheDurationInSeconds)
            });
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
            var json = _redis.GetString(key);
            return string.IsNullOrEmpty(json) ? default! : JsonSerializer.Deserialize<V>(json, _jsonOptions)!;
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
            _redis.Remove(key);
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
            // IDistributedCache 不提供 Exists 接口，通过读取头字节判断
            return _redis.Get(key) != null;
        }
        catch
        {
            return false;
        }
    }

    public void Add<V>(string key, V value) => Add(key, value, 3600);

    public IEnumerable<string> GetAllKey<V>() => [];
}