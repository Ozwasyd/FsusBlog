using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.PublicAot;
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
        ILogger<SystemService> _logger,
        IPublicAotInvalidationService _publicAotInvalidationService) : ISystemService
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
    private const int MaxSlugLength = 64;
    private const int MaxPageContentLength = 200_000;

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
        var cachedSeo = await TryReadRedisCacheAsync<SeoConfigDto>(CACHE_KEY_SEO);
        if (cachedSeo.Hit)
        {
            return cachedSeo.Value;
        }

        // 对于多行数据读取，保持 DataReader 物理映射以避免 List<SystemConfig> 实体分配
        var query = _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Seo_"))
            .Select(c => new { c.Key, c.Value });

        var sqlObj = query.ToSql();
        var configs = new List<ConfigItem>(8);

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

        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(dto, _jsonOptions);
            await _redis.StringSetAsync(CACHE_KEY_SEO, bytes, TimeSpan.FromHours(24));
        }
        catch (Exception ex)
        {
            LogSeoCacheWriteError(ex);
        }

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
        await InvalidateSeoPublicAotAsync("update-seo");
        LogSeoUpdateSuccess();
    }

    // ================= 2. 动态内容页面 (Page Content) =================

    public async Task<PageContentDto> GetPageContentAsync(string slug)
    {
        slug = NormalizeSlug(slug);
        if (slug.Length == 0) return new PageContentDto();

        string redisKey = string.Create(CACHE_KEY_PAGE_PREFIX.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE_PREFIX.AsSpan().CopyTo(span);
            s.AsSpan().CopyTo(span[CACHE_KEY_PAGE_PREFIX.Length..]);
        });

        var cachedPage = await TryReadStringCacheAsync(redisKey);
        if (cachedPage.Hit)
        {
            _ = _redis.KeyExpireAsync(redisKey, TimeSpan.FromHours(24));
            return new PageContentDto { Slug = slug, Content = cachedPage.Value ?? string.Empty };
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

        try
        {
            await _redis.StringSetAsync(redisKey, content, TimeSpan.FromHours(24));
        }
        catch (Exception ex)
        {
            LogPageCacheWriteError(ex, slug);
        }

        return new PageContentDto { Slug = slug, Content = content };
    }

    public async Task<bool> UpdatePageContentAsync(PageContentDto dto)
    {
        var slug = NormalizeSlug(dto.Slug);
        if (slug.Length == 0) return false;

        LogPageUpdateAudit(slug);

        string redisKey = string.Create(CACHE_KEY_PAGE_PREFIX.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE_PREFIX.AsSpan().CopyTo(span);
            s.AsSpan().CopyTo(span[CACHE_KEY_PAGE_PREFIX.Length..]);
        });

        string dbKey = string.Create(CACHE_KEY_PAGE.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE.AsSpan().CopyTo(span);
            var target = span[CACHE_KEY_PAGE.Length..];
            s.AsSpan().CopyTo(target);
            target[0] = char.ToUpperInvariant(target[0]);
        });

        // 1. 获取影响行数
        int affectedRows = await _db.Storageable(new SystemConfig
        {
            Key = dbKey,
            Value = NormalizePageContent(dto.Content)
        }).ExecuteCommandAsync();

        // 2. 物理防线：0 行受影响代表更新失败，直接抛出异常，阻断 200 OK 响应
        if (affectedRows <= 0) return false;

        // 3. 落盘成功后，立即以 O(1) 物理驱逐旧缓存
        await _redis.KeyDeleteAsync(redisKey);
        await InvalidatePagePublicAotAsync(slug, $"update-page:{slug}");
        LogPageUpdateSuccess(slug);
        return true;
    }

    public async Task<bool> RefreshPageCacheAsync(string slug)
    {
        slug = NormalizeSlug(slug);
        if (slug.Length == 0)
        {
            return false;
        }

        string redisKey = string.Create(CACHE_KEY_PAGE_PREFIX.Length + slug.Length, slug, (span, s) =>
        {
            CACHE_KEY_PAGE_PREFIX.AsSpan().CopyTo(span);
            s.AsSpan().CopyTo(span[CACHE_KEY_PAGE_PREFIX.Length..]);
        });

        await _redis.KeyDeleteAsync(redisKey);
        await InvalidatePagePublicAotAsync(slug, $"refresh-page:{slug}");
        return true;
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

    private static string NormalizeSlug(string? slug)
    {
        if (string.IsNullOrWhiteSpace(slug))
        {
            return string.Empty;
        }

        var value = slug.Trim().ToLowerInvariant();
        if (value.Length > MaxSlugLength)
        {
            value = value[..MaxSlugLength];
        }

        return value;
    }

    private static string NormalizePageContent(string? content)
    {
        if (string.IsNullOrEmpty(content))
        {
            return string.Empty;
        }

        return content.Length > MaxPageContentLength ? content[..MaxPageContentLength] : content;
    }

    private async Task<(bool Hit, T? Value)> TryReadRedisCacheAsync<T>(string cacheKey)
    {
        try
        {
            using var lease = await _redis.StringGetLeaseAsync(cacheKey);
            if (lease == null || lease.Length <= 0)
            {
                return (false, default);
            }

            return (true, JsonSerializer.Deserialize<T>(lease.Span, _jsonOptions));
        }
        catch (Exception ex)
        {
            LogSeoCacheReadError(ex);
            return (false, default);
        }
    }

    private async Task<(bool Hit, string? Value)> TryReadStringCacheAsync(string cacheKey)
    {
        try
        {
            var cachedValue = await _redis.StringGetAsync(cacheKey);
            return cachedValue.HasValue
                ? (true, cachedValue.ToString())
                : (false, null);
        }
        catch (Exception ex)
        {
            LogPageCacheReadError(ex, cacheKey);
            return (false, null);
        }
    }

    private async Task InvalidateSeoPublicAotAsync(string operation)
    {
        try
        {
            await _publicAotInvalidationService.InvalidateSeoAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "公开页 AOT 缓存失效失败 | Operation={Operation}", operation);
        }
    }

    private async Task InvalidatePagePublicAotAsync(string slug, string operation)
    {
        if (!string.Equals(slug, "about", StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            await _publicAotInvalidationService.InvalidateAboutAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "公开页 AOT 页面缓存失效失败 | Operation={Operation}", operation);
        }
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
