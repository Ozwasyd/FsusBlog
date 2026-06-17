using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
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
    private const string Key_FaviconSvgUrl = "Seo_FaviconSvgUrl";
    private const string Key_FaviconIcoUrl = "Seo_FaviconIcoUrl";
    private const string Key_FaviconPngUrl = "Seo_FaviconPngUrl";
    private const string Key_AppleTouchIconUrl = "Seo_AppleTouchIconUrl";
    private const string Key_ManifestName = "Seo_ManifestName";
    private const string Key_ManifestShortName = "Seo_ManifestShortName";
    private const string Key_PwaIcon192Url = "Seo_PwaIcon192Url";
    private const string Key_PwaIcon512Url = "Seo_PwaIcon512Url";
    private const string Key_PwaMaskableIconUrl = "Seo_PwaMaskableIconUrl";
    private const string Key_ThemeColor = "Seo_ThemeColor";
    private const string Key_BackgroundColor = "Seo_BackgroundColor";
    private const string Key_SiteLogoUrl = "Seo_SiteLogoUrl";
    private const string Key_SiteLogoDarkUrl = "Seo_SiteLogoDarkUrl";
    private const string Key_SiteWordmarkUrl = "Seo_SiteWordmarkUrl";
    private const string Key_AdminLogoUrl = "Seo_AdminLogoUrl";
    private const string Key_AdminCollapsedIconUrl = "Seo_AdminCollapsedIconUrl";
    private const string Key_LoginLogoUrl = "Seo_LoginLogoUrl";
    private const string Key_LoginIconUrl = "Seo_LoginIconUrl";
    private const string Key_ComplianceEnabled = "Compliance_Enabled";
    private const string Key_ComplianceRegionMode = "Compliance_RegionMode";
    private const string Key_ComplianceCopyrightOwner = "Compliance_CopyrightOwner";
    private const string Key_ComplianceCopyrightStartYear = "Compliance_CopyrightStartYear";
    private const string Key_ComplianceCopyrightText = "Compliance_CopyrightText";
    private const string Key_ComplianceContentLicenseName = "Compliance_ContentLicenseName";
    private const string Key_ComplianceContentLicenseUrl = "Compliance_ContentLicenseUrl";
    private const string Key_ComplianceIcpRecordNumber = "Compliance_IcpRecordNumber";
    private const string Key_ComplianceIcpRecordUrl = "Compliance_IcpRecordUrl";
    private const string Key_CompliancePoliceRecordNumber = "Compliance_PoliceRecordNumber";
    private const string Key_CompliancePoliceRecordUrl = "Compliance_PoliceRecordUrl";
    private const string Key_CompliancePoliceBadgeIconUrl = "Compliance_PoliceBadgeIconUrl";
    private const string Key_ComplianceOperatorName = "Compliance_OperatorName";
    private const string Key_ComplianceContactEmail = "Compliance_ContactEmail";
    private const string MissingPageContent = "页面内容正在准备中，请稍后再试。";
    private const string DefaultIcpRecordUrl = "https://beian.miit.gov.cn/";
    private const string DefaultPoliceRecordUrl = "https://beian.mps.gov.cn/";
    private const string DefaultFaviconSvgUrl = "/favicon.svg";
    private const string DefaultFaviconIcoUrl = "/favicon.ico";
    private const string DefaultAppleTouchIconUrl = "/apple-touch-icon.png";
    private const string DefaultPwaIcon192Url = "/icons/icon-192.png";
    private const string DefaultPwaIcon512Url = "/icons/icon-512.png";
    private const string DefaultPwaMaskableIconUrl = "/icons/maskable-512.png";
    private const string DefaultThemeColor = "#0f0f11";
    private const string DefaultBackgroundColor = "#fcfcfc";

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
                    () => _cache.TryGetAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.DecodeSeo, ct),
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
                            () => _cache.SetRawAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.EncodeSeo(dto), null, gateCt),
                            _logger,
                            "seo-cache-write",
                            LogLevel.Error);
                        return dto;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<SeoConfigReadModel> retry = await _cache.TryGetAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.DecodeSeo, gateCt);
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
        SeoConfigReadModel normalized = NormalizeSeoConfig(dto);
        SystemConfig[] configs =
        [
            new() { Key = Key_Title, Value = normalized.Title },
            new() { Key = Key_Desc, Value = normalized.Description },
            new() { Key = Key_Keywords, Value = normalized.Keywords },
            new() { Key = Key_Author, Value = normalized.Author },
            new() { Key = Key_OgImage, Value = normalized.OgImage },
            new() { Key = Key_BaseUrl, Value = normalized.BaseUrl },
            new() { Key = Key_FaviconSvgUrl, Value = normalized.FaviconSvgUrl },
            new() { Key = Key_FaviconIcoUrl, Value = normalized.FaviconIcoUrl },
            new() { Key = Key_FaviconPngUrl, Value = normalized.FaviconPngUrl },
            new() { Key = Key_AppleTouchIconUrl, Value = normalized.AppleTouchIconUrl },
            new() { Key = Key_ManifestName, Value = normalized.ManifestName },
            new() { Key = Key_ManifestShortName, Value = normalized.ManifestShortName },
            new() { Key = Key_PwaIcon192Url, Value = normalized.PwaIcon192Url },
            new() { Key = Key_PwaIcon512Url, Value = normalized.PwaIcon512Url },
            new() { Key = Key_PwaMaskableIconUrl, Value = normalized.PwaMaskableIconUrl },
            new() { Key = Key_ThemeColor, Value = normalized.ThemeColor },
            new() { Key = Key_BackgroundColor, Value = normalized.BackgroundColor },
            new() { Key = Key_SiteLogoUrl, Value = normalized.SiteLogoUrl },
            new() { Key = Key_SiteLogoDarkUrl, Value = normalized.SiteLogoDarkUrl },
            new() { Key = Key_SiteWordmarkUrl, Value = normalized.SiteWordmarkUrl },
            new() { Key = Key_AdminLogoUrl, Value = normalized.AdminLogoUrl },
            new() { Key = Key_AdminCollapsedIconUrl, Value = normalized.AdminCollapsedIconUrl },
            new() { Key = Key_LoginLogoUrl, Value = normalized.LoginLogoUrl },
            new() { Key = Key_LoginIconUrl, Value = normalized.LoginIconUrl }
        ];

        await _db.Storageable(configs).ExecuteCommandAsync();
        await _cacheInvalidationDispatcher.InvalidateSeoAsync();
        await InvalidateSeoPublicAotAsync("update-seo");
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", "seo"));
        LogSeoUpdateSuccess();
    }

    public async Task<SiteComplianceConfigReadModel> GetSiteComplianceConfigAsync()
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.SystemCompliance,
                "main",
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cache.TryGetAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.DecodeCompliance, ct),
                    _ => new CacheReadResult<SiteComplianceConfigReadModel>(false, default),
                    _logger,
                    "compliance-cache-read",
                    LogLevel.Warning),
                async ct => await _dbConcurrencyGate.ExecuteAsync(
                    "system-compliance",
                    async gateCt =>
                    {
                        SiteComplianceConfigReadModel dto = await LoadComplianceConfigFromDbAsync(gateCt);
                        await BoundaryExecutor.ExecuteAsync(
                            () => _cache.SetRawAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.EncodeCompliance(dto), null, gateCt),
                            _logger,
                            "compliance-cache-write",
                            LogLevel.Error);
                        return dto;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<SiteComplianceConfigReadModel> retry = await _cache.TryGetAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.DecodeCompliance, gateCt);
                        if (retry.Hit && retry.Value is not null)
                        {
                            return retry.Value;
                        }

                        throw new TimeoutException("db-gate-timeout:system-compliance");
                    },
                    ct),
                "system-compliance",
                cancellationToken: default)
            .ConfigureAwait(false)
            ?? new SiteComplianceConfigReadModel();
    }

    public async Task UpdateSiteComplianceConfigAsync(UpdateSiteComplianceConfigRequest dto)
    {
        SiteComplianceConfigReadModel normalized = NormalizeComplianceConfig(dto);
        SystemConfig[] configs =
        [
            new() { Key = Key_ComplianceEnabled, Value = normalized.Enabled ? "true" : "false" },
            new() { Key = Key_ComplianceRegionMode, Value = normalized.RegionMode },
            new() { Key = Key_ComplianceCopyrightOwner, Value = normalized.CopyrightOwner },
            new() { Key = Key_ComplianceCopyrightStartYear, Value = normalized.CopyrightStartYear?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty },
            new() { Key = Key_ComplianceCopyrightText, Value = normalized.CopyrightText },
            new() { Key = Key_ComplianceContentLicenseName, Value = normalized.ContentLicenseName },
            new() { Key = Key_ComplianceContentLicenseUrl, Value = normalized.ContentLicenseUrl },
            new() { Key = Key_ComplianceIcpRecordNumber, Value = normalized.IcpRecordNumber },
            new() { Key = Key_ComplianceIcpRecordUrl, Value = normalized.IcpRecordUrl },
            new() { Key = Key_CompliancePoliceRecordNumber, Value = normalized.PoliceRecordNumber },
            new() { Key = Key_CompliancePoliceRecordUrl, Value = normalized.PoliceRecordUrl },
            new() { Key = Key_CompliancePoliceBadgeIconUrl, Value = normalized.PoliceBadgeIconUrl },
            new() { Key = Key_ComplianceOperatorName, Value = normalized.OperatorName },
            new() { Key = Key_ComplianceContactEmail, Value = normalized.ContactEmail }
        ];

        await _db.Storageable(configs).ExecuteCommandAsync();
        await _cacheInvalidationDispatcher.InvalidateComplianceAsync();
        await InvalidateSeoPublicAotAsync("update-compliance");
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", "compliance"));
        LogComplianceUpdateSuccess();
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

    private static SeoConfigReadModel NormalizeSeoConfig(UpdateSeoConfigRequest dto)
    {
        string title = TrimUtf8Bytes(dto.Title, 50);
        string author = TrimUtf8Bytes(dto.Author, 20);
        string baseUrl = NormalizeHttpUrlOrDefault(dto.BaseUrl, PublicSiteIdentityDefaults.SiteBaseUrl, 256).TrimEnd('/');

        return new SeoConfigReadModel
        {
            Title = string.IsNullOrWhiteSpace(title) ? PublicSiteIdentityDefaults.SiteTitle : title,
            Description = TrimText(dto.Description, 200),
            Keywords = TrimUtf8Bytes(dto.Keywords, 256),
            Author = string.IsNullOrWhiteSpace(author) ? PublicSiteIdentityDefaults.SiteAuthor : author,
            OgImage = NormalizeOptionalAssetUrl(dto.OgImage, 256),
            BaseUrl = baseUrl.Length == 0 ? PublicSiteIdentityDefaults.SiteBaseUrl : baseUrl,
            FaviconSvgUrl = NormalizeAssetUrlOrDefault(dto.FaviconSvgUrl, DefaultFaviconSvgUrl, 256),
            FaviconIcoUrl = NormalizeAssetUrlOrDefault(dto.FaviconIcoUrl, DefaultFaviconIcoUrl, 256),
            FaviconPngUrl = NormalizeOptionalAssetUrl(dto.FaviconPngUrl, 256),
            AppleTouchIconUrl = NormalizeAssetUrlOrDefault(dto.AppleTouchIconUrl, DefaultAppleTouchIconUrl, 256),
            ManifestName = NormalizeManifestText(dto.ManifestName, string.IsNullOrWhiteSpace(title) ? PublicSiteIdentityDefaults.ManifestName : title, 128),
            ManifestShortName = NormalizeManifestText(dto.ManifestShortName, PublicSiteIdentityDefaults.ManifestShortName, 128),
            PwaIcon192Url = NormalizeAssetUrlOrDefault(dto.PwaIcon192Url, DefaultPwaIcon192Url, 256),
            PwaIcon512Url = NormalizeAssetUrlOrDefault(dto.PwaIcon512Url, DefaultPwaIcon512Url, 256),
            PwaMaskableIconUrl = NormalizeAssetUrlOrDefault(dto.PwaMaskableIconUrl, DefaultPwaMaskableIconUrl, 256),
            ThemeColor = NormalizeHexColor(dto.ThemeColor, DefaultThemeColor),
            BackgroundColor = NormalizeHexColor(dto.BackgroundColor, DefaultBackgroundColor),
            SiteLogoUrl = NormalizeOptionalAssetUrl(dto.SiteLogoUrl, 256),
            SiteLogoDarkUrl = NormalizeOptionalAssetUrl(dto.SiteLogoDarkUrl, 256),
            SiteWordmarkUrl = NormalizeOptionalAssetUrl(dto.SiteWordmarkUrl, 256),
            AdminLogoUrl = NormalizeOptionalAssetUrl(dto.AdminLogoUrl, 256),
            AdminCollapsedIconUrl = NormalizeOptionalAssetUrl(dto.AdminCollapsedIconUrl, 256),
            LoginLogoUrl = NormalizeOptionalAssetUrl(dto.LoginLogoUrl, 256),
            LoginIconUrl = NormalizeOptionalAssetUrl(dto.LoginIconUrl, 256)
        };
    }

    private static SiteComplianceConfigReadModel NormalizeComplianceConfig(UpdateSiteComplianceConfigRequest dto)
    {
        int currentYear = DateTime.UtcNow.Year;
        int? startYear = dto.CopyrightStartYear is >= 1990 && dto.CopyrightStartYear <= currentYear
            ? dto.CopyrightStartYear
            : null;

        return new SiteComplianceConfigReadModel
        {
            Enabled = dto.Enabled,
            RegionMode = NormalizeRegionMode(dto.RegionMode),
            CopyrightOwner = TrimUtf8Bytes(dto.CopyrightOwner, 128),
            CopyrightStartYear = startYear,
            CopyrightText = TrimText(dto.CopyrightText, 512),
            ContentLicenseName = TrimUtf8Bytes(dto.ContentLicenseName, 128),
            ContentLicenseUrl = NormalizeOptionalHttpUrl(dto.ContentLicenseUrl, 256),
            IcpRecordNumber = TrimUtf8Bytes(dto.IcpRecordNumber, 64),
            IcpRecordUrl = NormalizeHttpUrlOrDefault(dto.IcpRecordUrl, DefaultIcpRecordUrl, 256),
            PoliceRecordNumber = TrimUtf8Bytes(dto.PoliceRecordNumber, 64),
            PoliceRecordUrl = NormalizeHttpUrlOrDefault(dto.PoliceRecordUrl, DefaultPoliceRecordUrl, 256),
            PoliceBadgeIconUrl = NormalizeOptionalHttpUrl(dto.PoliceBadgeIconUrl, 256),
            OperatorName = TrimUtf8Bytes(dto.OperatorName, 128),
            ContactEmail = TrimUtf8Bytes(dto.ContactEmail, 128)
        };
    }

    private static string NormalizeRegionMode(string? value)
        => string.Equals(value?.Trim(), "mainland-cn", StringComparison.OrdinalIgnoreCase)
            ? "mainland-cn"
            : "global";

    private static string NormalizeHttpUrlOrDefault(string? value, string defaultValue, int maxUtf8Bytes)
    {
        string normalized = NormalizeOptionalHttpUrl(value, maxUtf8Bytes);
        return normalized.Length == 0 ? defaultValue : normalized;
    }

    private static string NormalizeOptionalHttpUrl(string? value, int maxUtf8Bytes)
    {
        string normalized = TrimUtf8Bytes(value, maxUtf8Bytes);
        return Uri.TryCreate(normalized, UriKind.Absolute, out Uri? uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                ? normalized
                : string.Empty;
    }

    private static string NormalizeAssetUrlOrDefault(string? value, string defaultValue, int maxUtf8Bytes)
    {
        string normalized = NormalizeOptionalAssetUrl(value, maxUtf8Bytes);
        return normalized.Length == 0 ? defaultValue : normalized;
    }

    private static string NormalizeOptionalAssetUrl(string? value, int maxUtf8Bytes)
    {
        string normalized = TrimUtf8Bytes(value, maxUtf8Bytes);
        if (normalized.Length == 0)
        {
            return string.Empty;
        }

        if (normalized.StartsWith("//", StringComparison.Ordinal)
            || normalized.Contains('\u0000'))
        {
            return string.Empty;
        }

        if (normalized.StartsWith("/", StringComparison.Ordinal))
        {
            return normalized.Length > 1 && !normalized.StartsWith("/\\", StringComparison.Ordinal)
                ? normalized
                : string.Empty;
        }

        if (!Uri.TryCreate(normalized, UriKind.Absolute, out Uri? uri))
        {
            return string.Empty;
        }

        return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps
            ? normalized
            : string.Empty;
    }

    private static string NormalizeManifestText(string? value, string fallback, int maxUtf8Bytes)
    {
        string normalized = TrimUtf8Bytes(value, maxUtf8Bytes);
        return normalized.Length == 0 ? TrimUtf8Bytes(fallback, maxUtf8Bytes) : normalized;
    }

    private static string NormalizeHexColor(string? value, string fallback)
    {
        string normalized = TrimUtf8Bytes(value, 32).ToLowerInvariant();
        return IsHexColor(normalized) ? normalized : fallback;
    }

    private static bool IsHexColor(string value)
    {
        if (value.Length is not (4 or 7) || value[0] != '#')
        {
            return false;
        }

        for (int i = 1; i < value.Length; i++)
        {
            char ch = value[i];
            if (ch is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    private static string TrimText(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string normalized = value.Trim();
        return normalized.Length > maxLength ? normalized[..maxLength] : normalized;
    }

    private static string TrimUtf8Bytes(string? value, int maxBytes)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string normalized = value.Trim();
        if (Encoding.UTF8.GetByteCount(normalized) <= maxBytes)
        {
            return normalized;
        }

        StringBuilder builder = new(normalized.Length);
        int bytes = 0;
        foreach (Rune rune in normalized.EnumerateRunes())
        {
            int runeBytes = Encoding.UTF8.GetByteCount(rune.ToString());
            if (bytes + runeBytes > maxBytes)
            {
                break;
            }

            builder.Append(rune);
            bytes += runeBytes;
        }

        return builder.ToString();
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
        if (!TryResolveStaticPageKind(slug, out PublicPageKind kind))
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            () => _publicAotInvalidationService.InvalidateStaticPageAsync(kind),
            _logger,
            $"invalidate-static-page-aot:{slug}:{operation}");
    }

    private static bool TryResolveStaticPageKind(string slug, out PublicPageKind kind)
    {
        kind = slug switch
        {
            "about" => PublicPageKind.About,
            "privacy" => PublicPageKind.Privacy,
            "guidelines" => PublicPageKind.Guidelines,
            "copyright" => PublicPageKind.Copyright,
            _ => PublicPageKind.Unknown
        };

        return kind != PublicPageKind.Unknown;
    }

    private async Task<SeoConfigReadModel> LoadSeoConfigFromDbAsync(CancellationToken cancellationToken)
    {
        var query = _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Seo_"))
            .Select(c => new { c.Key, c.Value });

        var sqlObj = query.ToSql();
        var configs = new List<ConfigItem>(32);

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

        return NormalizeSeoConfig(new UpdateSeoConfigRequest
        {
            Title = GetValue(configs, Key_Title, PublicSiteIdentityDefaults.SiteTitle),
            Description = GetValue(configs, Key_Desc, PublicSiteIdentityDefaults.SiteDescription),
            Keywords = GetValue(configs, Key_Keywords, PublicSiteIdentityDefaults.SiteKeywords),
            Author = GetValue(configs, Key_Author, PublicSiteIdentityDefaults.SiteAuthor),
            OgImage = GetValue(configs, Key_OgImage, string.Empty),
            BaseUrl = GetValue(configs, Key_BaseUrl, PublicSiteIdentityDefaults.SiteBaseUrl),
            FaviconSvgUrl = GetValue(configs, Key_FaviconSvgUrl, DefaultFaviconSvgUrl),
            FaviconIcoUrl = GetValue(configs, Key_FaviconIcoUrl, DefaultFaviconIcoUrl),
            FaviconPngUrl = GetValue(configs, Key_FaviconPngUrl, string.Empty),
            AppleTouchIconUrl = GetValue(configs, Key_AppleTouchIconUrl, DefaultAppleTouchIconUrl),
            ManifestName = GetValue(configs, Key_ManifestName, string.Empty),
            ManifestShortName = GetValue(configs, Key_ManifestShortName, PublicSiteIdentityDefaults.ManifestShortName),
            PwaIcon192Url = GetValue(configs, Key_PwaIcon192Url, DefaultPwaIcon192Url),
            PwaIcon512Url = GetValue(configs, Key_PwaIcon512Url, DefaultPwaIcon512Url),
            PwaMaskableIconUrl = GetValue(configs, Key_PwaMaskableIconUrl, DefaultPwaMaskableIconUrl),
            ThemeColor = GetValue(configs, Key_ThemeColor, DefaultThemeColor),
            BackgroundColor = GetValue(configs, Key_BackgroundColor, DefaultBackgroundColor),
            SiteLogoUrl = GetValue(configs, Key_SiteLogoUrl, string.Empty),
            SiteLogoDarkUrl = GetValue(configs, Key_SiteLogoDarkUrl, string.Empty),
            SiteWordmarkUrl = GetValue(configs, Key_SiteWordmarkUrl, string.Empty),
            AdminLogoUrl = GetValue(configs, Key_AdminLogoUrl, string.Empty),
            AdminCollapsedIconUrl = GetValue(configs, Key_AdminCollapsedIconUrl, string.Empty),
            LoginLogoUrl = GetValue(configs, Key_LoginLogoUrl, string.Empty),
            LoginIconUrl = GetValue(configs, Key_LoginIconUrl, string.Empty)
        });
    }

    private async Task<SiteComplianceConfigReadModel> LoadComplianceConfigFromDbAsync(CancellationToken cancellationToken)
    {
        var query = _db.Queryable<SystemConfig>()
            .Where(c => c.Key.StartsWith("Compliance_"))
            .Select(c => new { c.Key, c.Value });

        var sqlObj = query.ToSql();
        var configs = new List<ConfigItem>(16);

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

        return new SiteComplianceConfigReadModel
        {
            Enabled = ParseBool(GetValue(configs, Key_ComplianceEnabled, "false")),
            RegionMode = NormalizeRegionMode(GetValue(configs, Key_ComplianceRegionMode, "global")),
            CopyrightOwner = TrimUtf8Bytes(GetValue(configs, Key_ComplianceCopyrightOwner, string.Empty), 128),
            CopyrightStartYear = ParseStartYear(GetValue(configs, Key_ComplianceCopyrightStartYear, string.Empty)),
            CopyrightText = TrimText(GetValue(configs, Key_ComplianceCopyrightText, string.Empty), 512),
            ContentLicenseName = TrimUtf8Bytes(GetValue(configs, Key_ComplianceContentLicenseName, string.Empty), 128),
            ContentLicenseUrl = NormalizeOptionalHttpUrl(GetValue(configs, Key_ComplianceContentLicenseUrl, string.Empty), 256),
            IcpRecordNumber = TrimUtf8Bytes(GetValue(configs, Key_ComplianceIcpRecordNumber, string.Empty), 64),
            IcpRecordUrl = NormalizeHttpUrlOrDefault(GetValue(configs, Key_ComplianceIcpRecordUrl, DefaultIcpRecordUrl), DefaultIcpRecordUrl, 256),
            PoliceRecordNumber = TrimUtf8Bytes(GetValue(configs, Key_CompliancePoliceRecordNumber, string.Empty), 64),
            PoliceRecordUrl = NormalizeHttpUrlOrDefault(GetValue(configs, Key_CompliancePoliceRecordUrl, DefaultPoliceRecordUrl), DefaultPoliceRecordUrl, 256),
            PoliceBadgeIconUrl = NormalizeOptionalHttpUrl(GetValue(configs, Key_CompliancePoliceBadgeIconUrl, string.Empty), 256),
            OperatorName = TrimUtf8Bytes(GetValue(configs, Key_ComplianceOperatorName, string.Empty), 128),
            ContactEmail = TrimUtf8Bytes(GetValue(configs, Key_ComplianceContactEmail, string.Empty), 128)
        };
    }

    private static bool ParseBool(string value)
        => bool.TryParse(value, out bool parsed) && parsed;

    private static int? ParseStartYear(string value)
    {
        if (!int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int year))
        {
            return null;
        }

        int currentYear = DateTime.UtcNow.Year;
        return year is >= 1990 && year <= currentYear ? year : null;
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

    [LoggerMessage(EventId = 9, Level = LogLevel.Information, Message = "公开合规配置更新成功，缓存已失效重置")]
    private partial void LogComplianceUpdateSuccess();

    [LoggerMessage(EventId = 5, Level = LogLevel.Warning, Message = "动态页面内容缓存读取失败 | Slug: {Slug}")]
    private partial void LogPageCacheReadError(Exception ex, string slug);

    [LoggerMessage(EventId = 6, Level = LogLevel.Error, Message = "动态页面内容写入缓存失败 | Slug: {Slug}")]
    private partial void LogPageCacheWriteError(Exception ex, string slug);

    [LoggerMessage(EventId = 8, Level = LogLevel.Information, Message = "页面更新成功 | Slug: {Slug} | 缓存已清除")]
    private partial void LogPageUpdateSuccess(string slug);
}
