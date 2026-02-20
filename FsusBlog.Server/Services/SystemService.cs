using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using Microsoft.Extensions.Caching.Distributed;
using SqlSugar;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Services;

/// <summary>
/// 系统设置与动态页面服务
/// 核心职责：SEO 配置管理、规约/关于等页面内容维护
/// </summary>
public class SystemService(
        ISqlSugarClient _db,
        IDistributedCache _cache,
        ILogger<SystemService> _logger) : ISystemService
{
    private const string Key_Title = "Seo_Title";
    private const string Key_Desc = "Seo_Description";
    private const string Key_Keywords = "Seo_Keywords";
    private const string Key_Author = "Seo_Author";
    private const string Key_OgImage = "Seo_OgImage";
    private const string Key_BaseUrl = "Seo_BaseUrl";

    private const string CACHE_KEY_PAGE_PREFIX = "Page_";
    private const string CACHE_KEY_SEO = "sys:config:seo";
    private const string CACHE_KEY_PAGE = "sys:page:";

    // 静态复用配置，消除高频反射带来的 GC 压力
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true
    };

    // ================= 1. SEO 全局配置 (SEO Config) =================

    public async Task<SeoConfigDto> GetSeoConfigAsync()
    {
        // 1. 优先尝试读取 Redis
        try
        {
            var cachedJson = await _cache.GetStringAsync(CACHE_KEY_SEO);
            if (!string.IsNullOrEmpty(cachedJson))
            {
                return JsonSerializer.Deserialize<SeoConfigDto>(cachedJson, _jsonOptions) ?? new SeoConfigDto();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "SEO 缓存读取异常，已自动切换至数据库模式");
        }

        // 2. 批量从数据库提取 SEO 相关的 Key-Value
        // 逻辑自洽：Key_BaseUrl 以 Seo_ 开头，可被 StartsWith("Seo_") 逻辑涵盖，性能最优
        var configs = await _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Seo_"))
            .ToListAsync();

        var dto = new SeoConfigDto
        {
            Title = GetValue(configs, Key_Title, "Fsu's Blog"),
            Description = GetValue(configs, Key_Desc, "记录技术与生活"),
            Keywords = GetValue(configs, Key_Keywords, "C#, .NET, Vue"),
            Author = GetValue(configs, Key_Author, "Fsu"),
            OgImage = GetValue(configs, Key_OgImage, ""),
            BaseUrl = GetValue(configs, Key_BaseUrl, "https://fsus.blog")
        };

        // 3. 异步回填缓存 (有效期 24 小时)
        try
        {
            var options = new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24) };
            await _cache.SetStringAsync(CACHE_KEY_SEO, JsonSerializer.Serialize(dto, _jsonOptions), options);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SEO 配置写入 Redis 失败");
        }

        return dto;
    }

    public async Task UpdateSeoConfigAsync(SeoConfigDto dto)
    {
        _logger.LogWarning("审计日志：管理员正在修改全站 SEO 配置项（含 BaseUrl）");

        var list = new List<SystemConfig>
            {
                new() { Key = Key_Title, Value = dto.Title },
                new() { Key = Key_Desc, Value = dto.Description },
                new() { Key = Key_Keywords, Value = dto.Keywords },
                new() { Key = Key_Author, Value = dto.Author },
                new() { Key = Key_OgImage, Value = dto.OgImage },
                new() { Key = Key_BaseUrl, Value = dto.BaseUrl }
            };

        // 批量 Upsert：提高单次事务效率，保证数据原子性
        await _db.Storageable(list).ExecuteCommandAsync();

        // 立即作废缓存，确保前端渲染能即刻同步
        await _cache.RemoveAsync(CACHE_KEY_SEO);
        _logger.LogInformation("全站 SEO 配置更新成功，缓存已失效重置");
    }

    // ================= 2. 动态内容页面 (Page Content) =================

    public async Task<PageContentDto> GetPageContentAsync(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug)) return new PageContentDto();

        string redisKey = $"{CACHE_KEY_PAGE_PREFIX}{slug.ToLower()}";
        string dbKey = $"{CACHE_KEY_PAGE}{slug.FirstCharToUpper()}";

        // 1. 尝试从滑动过期缓存中读取
        try
        {
            var cachedContent = await _cache.GetStringAsync(redisKey);
            if (cachedContent != null)
            {
                return new PageContentDto { Slug = slug, Content = cachedContent };
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "动态页面内容缓存读取失败 | Slug: {Slug}", slug);
        }

        // 2. 从数据库加载原始内容
        var config = await _db.Queryable<SystemConfig>().FirstAsync(it => it.Key == dbKey);

        // 缺省文案，防止由于管理员未配置而导致前端显示 null
        var content = config?.Value ?? "页面内容正在准备中，请稍后再试。";

        // 3. 回填缓存，使用滑动过期 (24小时内只要有人访问就永不过期)
        try
        {
            await _cache.SetStringAsync(redisKey, content, new DistributedCacheEntryOptions
            {
                SlidingExpiration = TimeSpan.FromHours(24)
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "动态页面内容写入缓存失败 | Slug: {Slug}", slug);
        }

        return new PageContentDto { Slug = slug, Content = content };
    }

    public async Task UpdatePageContentAsync(PageContentDto dto)
    {
        if (string.IsNullOrEmpty(dto.Slug)) return;

        _logger.LogInformation("审计日志：正在重写动态页面内容 | Slug: {Slug}", dto.Slug);

        string redisKey = $"{CACHE_KEY_PAGE_PREFIX}{dto.Slug.ToLower()}";
        string dbKey = $"{CACHE_KEY_PAGE}{dto.Slug.FirstCharToUpper()}";

        // 1. 持久化至数据库
        await _db.Storageable(new SystemConfig
        {
            Key = dbKey,
            Value = dto.Content ?? ""
        }).ExecuteCommandAsync();

        // 2. 必须作废缓存
        await _cache.RemoveAsync(redisKey);
        _logger.LogInformation("页面更新成功 | Slug: {Slug} | 缓存已清除", dto.Slug);
    }

    /// <summary>
    /// 辅助方法：安全获取配置值，支持默认回退
    /// </summary>
    private static string GetValue(List<SystemConfig> list, string key, string defaultValue)
        => list.FirstOrDefault(c => c.Key == key)?.Value ?? defaultValue;
}