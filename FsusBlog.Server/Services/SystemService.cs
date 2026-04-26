using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Sse;
using SqlSugar;
using System.Data.Common;
using System.Runtime.InteropServices;
using System.Text;

namespace FsusBlog.Server.Services;

/// <summary>
/// 系统设置与动态页面服务
/// 修复日期: 2026-02-23 (移除标量查询中的 DataReader 反向优化，引入 Ordinal 字符串极速比对)
/// </summary>
public partial class SystemService(
        ISqlSugarClient _db,
        IUnifiedCache _cache,
        ICacheMissCoordinator _cacheMissCoordinator,
        IDbConcurrencyGate _dbConcurrencyGate,
        ILogger<SystemService> _logger,
        IPublicAotInvalidationService _publicAotInvalidationService,
        IMessageRealtimePublisher _messageService,
        ICacheInvalidationDispatcher _cacheInvalidationDispatcher) : ISystemService
{
    private const string Key_Title = "Seo_Title";
    private const string Key_Desc = "Seo_Description";
    private const string Key_Keywords = "Seo_Keywords";
    private const string Key_Author = "Seo_Author";
    private const string Key_OgImage = "Seo_OgImage";
    private const string Key_BaseUrl = "Seo_BaseUrl";
    private const string MissingPageContent = "页面内容正在准备中，请稍后再试。";

    private const int MaxSlugLength = 64;
    private const int MaxPageContentLength = 200_000;

    // 内部私有结构体：用于列表数据的极速回捞
    private readonly record struct ConfigItem(string Key, string Value);

    // ================= 1. SEO 全局配置 (SEO Config) =================

    public async Task<SeoConfigReadModel> GetSeoConfigAsync()
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.SystemSeo,
                "main",
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cache.TryGetJsonAsync<SeoConfigReadModel>(CachePolicyId.SystemSeo, "main", ct),
                    _ => new CacheReadResult<SeoConfigReadModel>(false, default),
                    _logger,
                    "seo-cache-read",
                    LogLevel.Warning),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "system-seo",
                    async gateCt =>
                    {
                        SeoConfigReadModel dto = await LoadSeoConfigFromDbAsync(gateCt);
                        await BoundaryExecutor.ExecuteAsync(
                            () => _cache.SetJsonAsync(CachePolicyId.SystemSeo, "main", dto, gateCt),
                            _logger,
                            "seo-cache-write",
                            LogLevel.Error);
                        return dto;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<SeoConfigReadModel> retry = await _cache.TryGetJsonAsync<SeoConfigReadModel>(CachePolicyId.SystemSeo, "main", gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException("db-gate-timeout:system-seo");
                    },
                    ct),
                "system-seo",
                cancellationToken: default)
            .ConfigureAwait(false)
            ?? new SeoConfigReadModel();
    }

    public async Task UpdateSeoConfigAsync(UpdateSeoConfigRequest dto)
    {
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
        await _cacheInvalidationDispatcher.InvalidateSeoAsync();
        await InvalidateSeoPublicAotAsync("update-seo");
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", "seo"));
        LogSeoUpdateSuccess();
    }

    // ================= 2. 动态内容页面 (Page Content) =================

    public async Task<PageContentReadModel> GetPageContentAsync(string slug)
    {
        slug = NormalizeSlug(slug);
        if (slug.Length == 0) return new PageContentReadModel();

        string content = await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.SystemPage,
                slug,
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => TryGetPageContentCacheAsync(slug, ct),
                    _ => new CacheReadResult<string>(false, default),
                    _logger,
                    $"page-cache-read:{slug}",
                    LogLevel.Warning),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "system-page",
                    async gateCt =>
                    {
                        string? loaded = await _db.Queryable<PageContent>()
                            .Where(it => it.Slug == slug)
                            .Select(it => it.Content)
                            .FirstAsync();

                        if (loaded is null)
                        {
                            await BoundaryExecutor.ExecuteAsync(
                                () => _cache.SetNegativeAsync(CachePolicyId.SystemPage, slug, gateCt),
                                _logger,
                                $"page-negative-cache-write:{slug}",
                                LogLevel.Error);
                            return MissingPageContent;
                        }

                        await BoundaryExecutor.ExecuteAsync(
                            () => _cache.SetStringAsync(CachePolicyId.SystemPage, slug, loaded, cancellationToken: gateCt),
                            _logger,
                            $"page-cache-write:{slug}",
                            LogLevel.Error);

                        return loaded;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<string> retry = await TryGetPageContentCacheAsync(slug, gateCt);
                        if (retry.Hit)
                        {
                            return retry.Value ?? MissingPageContent;
                        }

                        return MissingPageContent;
                    },
                    ct),
                "system-page",
                cancellationToken: default)
            .ConfigureAwait(false)
            ?? MissingPageContent;

        return new PageContentReadModel { Slug = slug, Content = content };
    }

    public async Task<bool> UpdatePageContentAsync(UpdatePageContentRequest dto)
    {
        var slug = NormalizeSlug(dto.Slug);
        if (slug.Length == 0) return false;

        // 1. 获取影响行数
        int affectedRows = await _db.Storageable(new PageContent
        {
            Slug = slug,
            Content = NormalizePageContent(dto.Content),
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

        // 2. 物理防线：0 行受影响代表更新失败，直接抛出异常，阻断 200 OK 响应
        if (affectedRows <= 0) return false;

        // 3. 落盘成功后，立即以 O(1) 物理驱逐旧缓存
        await _cacheInvalidationDispatcher.InvalidateSystemPageAsync(slug);
        await InvalidatePagePublicAotAsync(slug, $"update-page:{slug}");
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", slug));
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

        await _cacheInvalidationDispatcher.InvalidateSystemPageAsync(slug);
        await InvalidatePagePublicAotAsync(slug, $"refresh-page:{slug}");
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", slug));
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

    private async Task InvalidateSeoPublicAotAsync(string operation)
    {
        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateSeoAsync(),
            _logger,
            $"invalidate-seo-aot:{operation}");
    }

    private async Task InvalidatePagePublicAotAsync(string slug, string operation)
    {
        if (!string.Equals(slug, "about", StringComparison.Ordinal))
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateAboutAsync(),
            _logger,
            $"invalidate-about-aot:{operation}");
    }

    private async Task<SeoConfigReadModel> LoadSeoConfigFromDbAsync(CancellationToken cancellationToken)
    {
        var query = _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Seo_"))
            .Select(c => new { c.Key, c.Value });

        var sqlObj = query.ToSql();
        var configs = new List<ConfigItem>(8);

        using (var reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fKey = reader.GetOrdinal("Key");
            int fValue = reader.GetOrdinal("Value");

            while (await reader.ReadAsync(cancellationToken))
            {
                configs.Add(new ConfigItem(
                    reader.GetString(fKey),
                    reader.IsDBNull(fValue) ? string.Empty : reader.GetString(fValue)));
            }
        }

        return new SeoConfigReadModel
        {
            Title = GetValue(configs, Key_Title, "Fsu's Blog"),
            Description = GetValue(configs, Key_Desc, "记录技术与生活"),
            Keywords = GetValue(configs, Key_Keywords, "C#, .NET, Vue"),
            Author = GetValue(configs, Key_Author, "Fsu"),
            OgImage = GetValue(configs, Key_OgImage, string.Empty),
            BaseUrl = GetValue(configs, Key_BaseUrl, "https://fsus.blog")
        };
    }

    private async Task<CacheReadResult<string>> TryGetPageContentCacheAsync(string slug, CancellationToken cancellationToken)
    {
        CacheReadResult<string> read = await _cache.TryGetAsync<string>(
            CachePolicyId.SystemPage,
            slug,
            static bytes => (true, Encoding.UTF8.GetString(bytes.Span)),
            cancellationToken);

        if (!read.Hit)
        {
            return read;
        }

        return read.Value is null
            ? new CacheReadResult<string>(true, MissingPageContent)
            : read;
    }

    // ====================================================================
    // 高性能日志源生成器 (Zero-Allocation Logging)
    // ====================================================================

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "SEO 缓存读取异常，已自动切换至数据库模式")]
    private partial void LogSeoCacheReadError(Exception ex);

    [LoggerMessage(EventId = 2, Level = LogLevel.Error, Message = "SEO 配置写入 Redis 失败")]
    private partial void LogSeoCacheWriteError(Exception ex);

    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "全站 SEO 配置更新成功，缓存已失效重置")]
    private partial void LogSeoUpdateSuccess();

    [LoggerMessage(EventId = 5, Level = LogLevel.Warning, Message = "动态页面内容缓存读取失败 | Slug: {Slug}")]
    private partial void LogPageCacheReadError(Exception ex, string slug);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "动态页面内容写入缓存失败 | Slug: {Slug}")]
    private partial void LogPageCacheWriteError(Exception ex, string slug);

    [LoggerMessage(EventId = 8, Level = LogLevel.Information, Message = "页面更新成功 | Slug: {Slug} | 缓存已清除")]
    private partial void LogPageUpdateSuccess(string slug);
}
