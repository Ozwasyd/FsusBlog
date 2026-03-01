using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using SqlSugar;
using StackExchange.Redis;
using System.Data.Common;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services;

/// <summary>
/// 系统设置与动态页面服务
/// 修复日期: 2026-02-23 (移除标量查询中的 DataReader 反向优化，引入 Ordinal 字符串极速比对)
/// </summary>
public partial class SystemService(
        ISqlSugarClient _db,
        IConnectionMultiplexer _redisConnection,
        ILogger<SystemService> _logger) : ISystemService
{
    private readonly IDatabase _redis = _redisConnection.GetDatabase();

    private const string Key_Title = "Seo_Title";
    private const string Key_Desc = "Seo_Description";
    private const string Key_Keywords = "Seo_Keywords";
    private const string Key_Author = "Seo_Author";
    private const string Key_OgImage = "Seo_OgImage";
    private const string Key_BaseUrl = "Seo_BaseUrl";

    private const string CACHE_KEY_PAGE_PREFIX = "Page_";
    private const string CACHE_KEY_SEO = "sys:config:seo";
    private const string CACHE_KEY_PAGE = "sys:page:";

    // 内部私有结构体：用于列表数据的极速回捞
    private readonly record struct ConfigItem(string Key, string Value);

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true
    };

    // ================= 1. SEO 全局配置 (SEO Config) =================

    public async Task<SeoConfigDto> GetSeoConfigAsync()
    {
        try
        {
            using var lease = await _redis.StringGetLeaseAsync(CACHE_KEY_SEO);
            if (lease != null && lease.Length > 0)
            {
                return JsonSerializer.Deserialize<SeoConfigDto>(lease.Span, _jsonOptions);
            }
        }
        catch (Exception ex)
        {
            LogSeoCacheReadError(ex);
        }

        // 对于多行数据读取，保持 DataReader 物理映射以避免 List<SystemConfig> 实体分配
        var query = _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Seo_"))
            .Select(c => new { c.Key, c.Value });

        var sqlObj = query.ToSql();
        var configs = new List<ConfigItem>();

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fKey = reader.GetOrdinal("Key");
            int fValue = reader.GetOrdinal("Value");

            while (await reader.ReadAsync())
            {
                configs.Add(new ConfigItem(
                    reader.GetString(fKey),
                    reader.IsDBNull(fValue) ? string.Empty : reader.GetString(fValue)
                ));
            }
        }

        var dto = new SeoConfigDto
        {
            Title = GetValue(configs, Key_Title, "Fsu's Blog"),
            Description = GetValue(configs, Key_Desc, "记录技术与生活"),
            Keywords = GetValue(configs, Key_Keywords, "C#, .NET, Vue"),
            Author = GetValue(configs, Key_Author, "Fsu"),
            OgImage = GetValue(configs, Key_OgImage, ""),
            BaseUrl = GetValue(configs, Key_BaseUrl, "https://fsus.blog")
        };

        _ = Task.Run(async () =>
        {
            try
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(dto, _jsonOptions);
                await _redis.StringSetAsync(CACHE_KEY_SEO, bytes, TimeSpan.FromHours(24));
            }
            catch (Exception ex)
            {
                LogSeoCacheWriteError(ex);
            }
        });

        return dto;
    }

    public async Task UpdateSeoConfigAsync(SeoConfigDto dto)
    {
        LogSeoUpdateAudit();

        SystemConfig[] configs =
        [
            new() { Key = Key_Title, Value = dto.Title },
            new() { Key = Key_Desc, Value = dto.Description },
            new() { Key = Key_Keywords, Value = dto.Keywords },
            new() { Key = Key_Author, Value = dto.Author },
            new() { Key = Key_OgImage, Value = dto.OgImage },
            new() { Key = Key_BaseUrl, Value = dto.BaseUrl }
        ];

        await _db.Storageable(configs).ExecuteCommandAsync();
        await _redis.KeyDeleteAsync(CACHE_KEY_SEO);
        LogSeoUpdateSuccess();
    }

    // ================= 2. 动态内容页面 (Page Content) =================

    public async Task<PageContentDto> GetPageContentAsync(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug)) return new PageContentDto();

        string redisKey = string.Create(CACHE_KEY_PAGE_PREFIX.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE_PREFIX.AsSpan().CopyTo(span);
            s.AsSpan().ToLowerInvariant(span[CACHE_KEY_PAGE_PREFIX.Length..]);
        });

        try
        {
            var cachedValue = await _redis.StringGetAsync(redisKey);
            if (cachedValue.HasValue)
            {
                _ = _redis.KeyExpireAsync(redisKey, TimeSpan.FromHours(24));
                return new PageContentDto { Slug = slug, Content = cachedValue.ToString() };
            }
        }
        catch (Exception ex)
        {
            LogPageCacheReadError(ex, slug);
        }

        string dbKey = string.Create(CACHE_KEY_PAGE.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE.AsSpan().CopyTo(span);
            var target = span[CACHE_KEY_PAGE.Length..];
            s.AsSpan().CopyTo(target);
            target[0] = char.ToUpperInvariant(target[0]);
        });

        // 核心修复：标量查询回归 ORM 原生优化
        // SqlSugar 会智能识别 Select 返回的是基础类型 (string)，底层直接执行 ExecuteScalarAsync
        // 这比手动维护 DbDataReader 的状态机更轻量、更快，且依然是零实体分配
        var content = await _db.Queryable<SystemConfig>()
            .Where(it => it.Key == dbKey)
            .Select(it => it.Value)
            .FirstAsync() ?? "页面内容正在准备中，请稍后再试。";

        _ = Task.Run(async () =>
        {
            try
            {
                await _redis.StringSetAsync(redisKey, content, TimeSpan.FromHours(24));
            }
            catch (Exception ex)
            {
                LogPageCacheWriteError(ex, slug);
            }
        });

        return new PageContentDto { Slug = slug, Content = content };
    }

    public async Task UpdatePageContentAsync(PageContentDto dto)
    {
        string? slug = dto.Slug;
        if (string.IsNullOrEmpty(slug)) return;

        LogPageUpdateAudit(slug);

        string redisKey = string.Create(CACHE_KEY_PAGE_PREFIX.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE_PREFIX.AsSpan().CopyTo(span);
            s.AsSpan().ToLowerInvariant(span[CACHE_KEY_PAGE_PREFIX.Length..]);
        });

        string dbKey = string.Create(CACHE_KEY_PAGE.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE.AsSpan().CopyTo(span);
            var target = span[CACHE_KEY_PAGE.Length..];
            s.AsSpan().CopyTo(target);
            target[0] = char.ToUpperInvariant(target[0]);
        });

        await _db.Storageable(new SystemConfig
        {
            Key = dbKey,
            Value = dto.Content ?? string.Empty
        }).ExecuteCommandAsync();

        await _redis.KeyDeleteAsync(redisKey);
        LogPageUpdateSuccess(slug);
    }

    /// <summary>
    /// 辅助方法：利用 Span 遍历和 Ordinal 比较实现极致性能查找
    /// </summary>
    private static string GetValue(List<ConfigItem> list, string key, string defaultValue)
    {
        var span = CollectionsMarshal.AsSpan(list);
        for (int i = 0; i < span.Length; i++)
        {
            // 核心优化：使用 Ordinal (字节级) 比较，跳过 CultureInfo 开销，这是 C# 字符串比对的物理极限
            if (string.Equals(span[i].Key, key, StringComparison.Ordinal))
            {
                return span[i].Value;
            }
        }
        return defaultValue;
    }

    // ====================================================================
    // 高性能日志源生成器 (Zero-Allocation Logging)
    // ====================================================================

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "SEO 缓存读取异常，已自动切换至数据库模式")]
    private partial void LogSeoCacheReadError(Exception ex);

    [LoggerMessage(EventId = 2, Level = LogLevel.Error, Message = "SEO 配置写入 Redis 失败")]
    private partial void LogSeoCacheWriteError(Exception ex);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "审计日志：管理员正在修改全站 SEO 配置项（含 BaseUrl）")]
    private partial void LogSeoUpdateAudit();

    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "全站 SEO 配置更新成功，缓存已失效重置")]
    private partial void LogSeoUpdateSuccess();

    [LoggerMessage(EventId = 5, Level = LogLevel.Warning, Message = "动态页面内容缓存读取失败 | Slug: {Slug}")]
    private partial void LogPageCacheReadError(Exception ex, string slug);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "动态页面内容写入缓存失败 | Slug: {Slug}")]
    private partial void LogPageCacheWriteError(Exception ex, string slug);

    [LoggerMessage(EventId = 7, Level = LogLevel.Information, Message = "审计日志：正在重写动态页面内容 | Slug: {Slug}")]
    private partial void LogPageUpdateAudit(string slug);

    [LoggerMessage(EventId = 8, Level = LogLevel.Information, Message = "页面更新成功 | Slug: {Slug} | 缓存已清除")]
    private partial void LogPageUpdateSuccess(string slug);
}