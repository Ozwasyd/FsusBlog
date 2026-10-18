using System.Data.Common;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using static FsusBlog.Shared.Contracts.Outputs.PublicSiteAuthorPolicy;

using SqlSugar;

namespace FsusBlog.Server.Services;

/// <summary>
/// Manages system settings, dynamic pages, cache invalidation, and public artifact projection.
/// </summary>
// Public named-argument source compatibility; exact exception registered in csharp-style-policy.
#pragma warning disable IDE1006
public partial class SystemService(
        ISqlSugarClient _db,
        ICacheTypedReader _cacheReader,
        ICacheRawWriter _cacheWriter,
        ICacheStringWriter _stringWriter,
        ICacheMissCoordinator _cacheMissCoordinator,
        IDbConcurrencyGate _dbConcurrencyGate,
        ILogger<SystemService> _logger,
        IPublicAotInvalidationService _publicAotInvalidationService,
        IMessageRealtimePublisher _messageService,
        ICacheInvalidationDispatcher _cacheInvalidationDispatcher) : ISystemService
#pragma warning restore IDE1006
{
    private const string KeyTitle = "Seo_Title";
    private const string KeyDesc = "Seo_Description";
    private const string KeyKeywords = "Seo_Keywords";
    private const string KeyOgImage = "Seo_OgImage";
    private const string KeyBaseUrl = "Seo_BaseUrl";
    private const string KeyFaviconSvgUrl = "Seo_FaviconSvgUrl";
    private const string KeyFaviconIcoUrl = "Seo_FaviconIcoUrl";
    private const string KeyFaviconPngUrl = "Seo_FaviconPngUrl";
    private const string KeyAppleTouchIconUrl = "Seo_AppleTouchIconUrl";
    private const string KeyManifestName = "Seo_ManifestName";
    private const string KeyManifestShortName = "Seo_ManifestShortName";
    private const string KeyPwaIcon192Url = "Seo_PwaIcon192Url";
    private const string KeyPwaIcon512Url = "Seo_PwaIcon512Url";
    private const string KeyPwaMaskableIconUrl = "Seo_PwaMaskableIconUrl";
    private const string KeyThemeColor = "Seo_ThemeColor";
    private const string KeyBackgroundColor = "Seo_BackgroundColor";
    private const string KeySiteLogoUrl = "Seo_SiteLogoUrl";
    private const string KeySiteLogoDarkUrl = "Seo_SiteLogoDarkUrl";
    private const string KeySiteWordmarkUrl = "Seo_SiteWordmarkUrl";
    private const string KeyAdminLogoUrl = "Seo_AdminLogoUrl";
    private const string KeyAdminCollapsedIconUrl = "Seo_AdminCollapsedIconUrl";
    private const string KeyLoginLogoUrl = "Seo_LoginLogoUrl";
    private const string KeyLoginIconUrl = "Seo_LoginIconUrl";
    private const string KeyComplianceEnabled = "Compliance_Enabled";
    private const string KeyComplianceRegionMode = "Compliance_RegionMode";
    private const string KeyComplianceCopyrightOwner = "Compliance_CopyrightOwner";
    private const string KeyComplianceCopyrightStartYear = "Compliance_CopyrightStartYear";
    private const string KeyComplianceCopyrightText = "Compliance_CopyrightText";
    private const string KeyComplianceContentLicenseName = "Compliance_ContentLicenseName";
    private const string KeyComplianceContentLicenseUrl = "Compliance_ContentLicenseUrl";
    private const string KeyComplianceIcpRecordNumber = "Compliance_IcpRecordNumber";
    private const string KeyComplianceIcpRecordUrl = "Compliance_IcpRecordUrl";
    private const string KeyCompliancePoliceRecordNumber = "Compliance_PoliceRecordNumber";
    private const string KeyCompliancePoliceRecordUrl = "Compliance_PoliceRecordUrl";
    private const string KeyCompliancePoliceBadgeIconUrl = "Compliance_PoliceBadgeIconUrl";
    private const string KeyComplianceOperatorName = "Compliance_OperatorName";
    private const string KeyComplianceContactEmail = "Compliance_ContactEmail";
    private static readonly string[] s_seoConfigKeys =
    [
        KeyTitle,
        KeyDesc,
        KeyKeywords,
        PublicSiteAuthorPolicy.ConfigurationKey,
        KeyOgImage,
        KeyBaseUrl,
        KeyFaviconSvgUrl,
        KeyFaviconIcoUrl,
        KeyFaviconPngUrl,
        KeyAppleTouchIconUrl,
        KeyManifestName,
        KeyManifestShortName,
        KeyPwaIcon192Url,
        KeyPwaIcon512Url,
        KeyPwaMaskableIconUrl,
        KeyThemeColor,
        KeyBackgroundColor,
        KeySiteLogoUrl,
        KeySiteLogoDarkUrl,
        KeySiteWordmarkUrl,
        KeyAdminLogoUrl,
        KeyAdminCollapsedIconUrl,
        KeyLoginLogoUrl,
        KeyLoginIconUrl
    ];
    private static readonly string[] s_complianceConfigKeys =
    [
        KeyComplianceEnabled,
        KeyComplianceRegionMode,
        KeyComplianceCopyrightOwner,
        KeyComplianceCopyrightStartYear,
        KeyComplianceCopyrightText,
        KeyComplianceContentLicenseName,
        KeyComplianceContentLicenseUrl,
        KeyComplianceIcpRecordNumber,
        KeyComplianceIcpRecordUrl,
        KeyCompliancePoliceRecordNumber,
        KeyCompliancePoliceRecordUrl,
        KeyCompliancePoliceBadgeIconUrl,
        KeyComplianceOperatorName,
        KeyComplianceContactEmail
    ];
    private const string MissingPageContent = "页面内容正在准备中，请稍后再试。";
    private const string DefaultIcpRecordUrl = "https://beian.miit.gov.cn/";
    private const string DefaultPoliceRecordUrl = "https://beian.mps.gov.cn/";
    private const string DefaultOgImage = "/social/og-image.png";
    private const string DefaultFaviconSvgUrl = "/favicon/favicon.svg";
    private const string DefaultFaviconIcoUrl = "/favicon/favicon.ico";
    private const string DefaultFaviconPngUrl = "/favicon/favicon-32x32.png";
    private const string DefaultAppleTouchIconUrl = "/favicon/apple-touch-icon.png";
    private const string DefaultPwaIcon192Url = "/favicon/pwa-192x192.png";
    private const string DefaultPwaIcon512Url = "/favicon/pwa-512x512.png";
    private const string DefaultPwaMaskableIconUrl = "/favicon/maskable-icon-512x512.png";
    private const string DefaultThemeColor = "#0B4F7A";
    private const string DefaultBackgroundColor = "#FFFFFF";
    private static readonly string[] s_retiredDefaultOgImages =
    [
        "/og-image.png",
        "/images/og.png",
        "/images/og-default.png"
    ];
    private static readonly string[] s_retiredDefaultFaviconSvgUrls = ["/favicon.svg"];
    private static readonly string[] s_retiredDefaultFaviconIcoUrls = ["/favicon.ico"];
    private static readonly string[] s_retiredDefaultAppleTouchIconUrls = ["/apple-touch-icon.png"];
    private static readonly string[] s_retiredDefaultPwaIcon192Urls = ["/icons/icon-192.png"];
    private static readonly string[] s_retiredDefaultPwaIcon512Urls = ["/icons/icon-512.png"];
    private static readonly string[] s_retiredDefaultPwaMaskableIconUrls = ["/icons/maskable-512.png"];
    private static readonly string[] s_retiredDefaultThemeColors = ["#0f0f11", "#09090b"];
    private static readonly string[] s_retiredDefaultBackgroundColors = ["#fcfcfc", "#f7f7f8"];

    private const int MaxSlugLength = 64;
    private const int MaxPageContentLength = 200_000;

    private readonly record struct ConfigItem(string Key, string Value);

    // ================= 1. SEO 全局配置 (SEO Config) =================

    public async Task<SeoConfigReadModel> GetSeoConfigAsync()
    {
        SeoConfigReadModel result = await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.SystemSeo,
                "main",
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cacheReader.TryGetAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.DecodeSeo, ct),
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
                            () => _cacheWriter.SetRawAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.EncodeSeo(dto), null, gateCt),
                            _logger,
                            "seo-cache-write",
                            LogLevel.Error);
                        return dto;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<SeoConfigReadModel> retry = await _cacheReader.TryGetAsync(CachePolicyId.SystemSeo, "main", ServerCacheBinaryCodec.DecodeSeo, gateCt);
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

        return NormalizeLoadedSeoConfig(result);
    }

    public async Task UpdateSeoConfigAsync(UpdateSeoConfigRequest dto)
    {
        SeoConfigReadModel normalized = NormalizeSeoConfig(dto);
        SystemConfig[] configs =
        [
            new() { Key = KeyTitle, Value = normalized.Title },
            new() { Key = KeyDesc, Value = normalized.Description },
            new() { Key = KeyKeywords, Value = normalized.Keywords },
            new() { Key = PublicSiteAuthorPolicy.ConfigurationKey, Value = normalized.Author },
            new() { Key = KeyOgImage, Value = normalized.OgImage },
            new() { Key = KeyBaseUrl, Value = normalized.BaseUrl },
            new() { Key = KeyFaviconSvgUrl, Value = normalized.FaviconSvgUrl },
            new() { Key = KeyFaviconIcoUrl, Value = normalized.FaviconIcoUrl },
            new() { Key = KeyFaviconPngUrl, Value = normalized.FaviconPngUrl },
            new() { Key = KeyAppleTouchIconUrl, Value = normalized.AppleTouchIconUrl },
            new() { Key = KeyManifestName, Value = normalized.ManifestName },
            new() { Key = KeyManifestShortName, Value = normalized.ManifestShortName },
            new() { Key = KeyPwaIcon192Url, Value = normalized.PwaIcon192Url },
            new() { Key = KeyPwaIcon512Url, Value = normalized.PwaIcon512Url },
            new() { Key = KeyPwaMaskableIconUrl, Value = normalized.PwaMaskableIconUrl },
            new() { Key = KeyThemeColor, Value = normalized.ThemeColor },
            new() { Key = KeyBackgroundColor, Value = normalized.BackgroundColor },
            new() { Key = KeySiteLogoUrl, Value = normalized.SiteLogoUrl },
            new() { Key = KeySiteLogoDarkUrl, Value = normalized.SiteLogoDarkUrl },
            new() { Key = KeySiteWordmarkUrl, Value = normalized.SiteWordmarkUrl },
            new() { Key = KeyAdminLogoUrl, Value = normalized.AdminLogoUrl },
            new() { Key = KeyAdminCollapsedIconUrl, Value = normalized.AdminCollapsedIconUrl },
            new() { Key = KeyLoginLogoUrl, Value = normalized.LoginLogoUrl },
            new() { Key = KeyLoginIconUrl, Value = normalized.LoginIconUrl }
        ];

        await _db.Storageable(configs).ExecuteCommandAsync();
        string mutationId = $"seo:{Guid.CreateVersion7():N}";
        await _publicAotInvalidationService.InvalidateSeoArtifactsAsync(CancellationToken.None);
        await _cacheInvalidationDispatcher.InvalidateSeoAsync(mutationId, CancellationToken.None);
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", "seo"));
        LogSeoUpdateSuccess();
    }

    public async Task<SiteComplianceConfigReadModel> GetSiteComplianceConfigAsync()
    {
        return await _cacheMissCoordinator.CoordinateAsync(
                CachePolicyId.SystemCompliance,
                "main",
                ct => BoundaryExecutor.ExecuteValueAsync(
                    () => _cacheReader.TryGetAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.DecodeCompliance, ct),
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
                            () => _cacheWriter.SetRawAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.EncodeCompliance(dto), null, gateCt),
                            _logger,
                            "compliance-cache-write",
                            LogLevel.Error);
                        return dto;
                    },
                    async gateCt =>
                    {
                        CacheReadResult<SiteComplianceConfigReadModel> retry = await _cacheReader.TryGetAsync(CachePolicyId.SystemCompliance, "main", ServerCacheBinaryCodec.DecodeCompliance, gateCt);
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
            new() { Key = KeyComplianceEnabled, Value = normalized.Enabled ? "true" : "false" },
            new() { Key = KeyComplianceRegionMode, Value = normalized.RegionMode },
            new() { Key = KeyComplianceCopyrightOwner, Value = normalized.CopyrightOwner },
            new() { Key = KeyComplianceCopyrightStartYear, Value = normalized.CopyrightStartYear?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty },
            new() { Key = KeyComplianceCopyrightText, Value = normalized.CopyrightText },
            new() { Key = KeyComplianceContentLicenseName, Value = normalized.ContentLicenseName },
            new() { Key = KeyComplianceContentLicenseUrl, Value = normalized.ContentLicenseUrl },
            new() { Key = KeyComplianceIcpRecordNumber, Value = normalized.IcpRecordNumber },
            new() { Key = KeyComplianceIcpRecordUrl, Value = normalized.IcpRecordUrl },
            new() { Key = KeyCompliancePoliceRecordNumber, Value = normalized.PoliceRecordNumber },
            new() { Key = KeyCompliancePoliceRecordUrl, Value = normalized.PoliceRecordUrl },
            new() { Key = KeyCompliancePoliceBadgeIconUrl, Value = normalized.PoliceBadgeIconUrl },
            new() { Key = KeyComplianceOperatorName, Value = normalized.OperatorName },
            new() { Key = KeyComplianceContactEmail, Value = normalized.ContactEmail }
        ];

        await _db.Storageable(configs).ExecuteCommandAsync();
        string mutationId = $"compliance:{Guid.CreateVersion7():N}";
        await _publicAotInvalidationService.InvalidateSeoArtifactsAsync(CancellationToken.None);
        await _cacheInvalidationDispatcher.InvalidateComplianceAsync(mutationId, CancellationToken.None);
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", "compliance"));
        LogComplianceUpdateSuccess();
    }

    // ================= 2. 动态内容页面 (Page Content) =================

    public async Task<PageContentReadModel> GetPageContentAsync(string slug)
    {
        slug = NormalizeSlug(slug);
        if (slug.Length == 0)
            return new PageContentReadModel();

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
                                () => _cacheWriter.SetNegativeAsync(CachePolicyId.SystemPage, slug, gateCt),
                                _logger,
                                $"page-negative-cache-write:{slug}",
                                LogLevel.Error);
                            return MissingPageContent;
                        }

                        await BoundaryExecutor.ExecuteAsync(
                            () => _stringWriter.SetStringAsync(CachePolicyId.SystemPage, slug, loaded, cancellationToken: gateCt),
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
        if (slug.Length == 0)
            return false;

        // 1. 获取影响行数
        int affectedRows = await _db.Storageable(new PageContent
        {
            Slug = slug,
            Content = NormalizePageContent(dto.Content),
            UpdatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

        // SECURITY-INVARIANT: A zero-row write must not be reported as a successful update.
        if (affectedRows <= 0)
            return false;

        // Invalidate only after the durable write succeeds.
        string mutationId = $"system-page:{Guid.CreateVersion7():N}";
        await InvalidatePagePublicAotAsync(slug, $"update-page:{slug}", mutationId);
        await _cacheInvalidationDispatcher.InvalidateSystemPageAsync(slug, mutationId, CancellationToken.None);
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

        string mutationId = $"system-page:{Guid.CreateVersion7():N}";
        await InvalidatePagePublicAotAsync(slug, $"refresh-page:{slug}", mutationId);
        await _cacheInvalidationDispatcher.InvalidateSystemPageAsync(slug, mutationId, CancellationToken.None);
        await _messageService.PushCacheControlAsync(new CacheControlPayload("shell.invalidate", slug));
        return true;
    }

    /// <summary>
    /// Finds a configuration value using the repository's case-sensitive key contract.
    /// </summary>
    private static string GetValue(List<ConfigItem> list, string key, string defaultValue)
    {
        var span = CollectionsMarshal.AsSpan(list);
        for (int i = 0; i < span.Length; i++)
        {
            // Configuration keys are wire-stable and therefore compared ordinally.
            if (string.Equals(span[i].Key, key, StringComparison.Ordinal))
            {
                return span[i].Value;
            }
        }
        return defaultValue;
    }

    private static string GetDefaultAwareValue(List<ConfigItem> list, string key, string defaultValue, IReadOnlyList<string> retiredDefaults)
    {
        string value = GetValue(list, key, defaultValue);
        return DefaultIfRetiredDefault(value, defaultValue, retiredDefaults);
    }

    private static string DefaultIfRetiredDefault(string? value, string defaultValue, IReadOnlyList<string> retiredDefaults)
    {
        return IsRetiredDefaultValue(value, retiredDefaults) ? defaultValue : value ?? string.Empty;
    }

    private static bool IsRetiredDefaultValue(string? value, IReadOnlyList<string> retiredDefaults)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        string? normalized = TextHelpers.TrimOrNull(value);
        if (normalized is null)
        {
            return false;
        }

        for (int i = 0; i < retiredDefaults.Count; i++)
        {
            if (string.Equals(normalized, retiredDefaults[i], StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static string NormalizeSlug(string? slug)
    {
        string value = TextHelpers.LowerTrimmed(slug) ?? string.Empty;
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

    private static SeoConfigReadModel NormalizeLoadedSeoConfig(SeoConfigReadModel dto)
        => NormalizeSeoConfig(new UpdateSeoConfigRequest
        {
            Title = dto.Title,
            Description = dto.Description,
            Keywords = dto.Keywords,
            Author = dto.Author,
            OgImage = DefaultIfRetiredDefault(dto.OgImage, DefaultOgImage, s_retiredDefaultOgImages),
            BaseUrl = dto.BaseUrl,
            FaviconSvgUrl = DefaultIfRetiredDefault(dto.FaviconSvgUrl, DefaultFaviconSvgUrl, s_retiredDefaultFaviconSvgUrls),
            FaviconIcoUrl = DefaultIfRetiredDefault(dto.FaviconIcoUrl, DefaultFaviconIcoUrl, s_retiredDefaultFaviconIcoUrls),
            FaviconPngUrl = dto.FaviconPngUrl,
            AppleTouchIconUrl = DefaultIfRetiredDefault(dto.AppleTouchIconUrl, DefaultAppleTouchIconUrl, s_retiredDefaultAppleTouchIconUrls),
            ManifestName = dto.ManifestName,
            ManifestShortName = dto.ManifestShortName,
            PwaIcon192Url = DefaultIfRetiredDefault(dto.PwaIcon192Url, DefaultPwaIcon192Url, s_retiredDefaultPwaIcon192Urls),
            PwaIcon512Url = DefaultIfRetiredDefault(dto.PwaIcon512Url, DefaultPwaIcon512Url, s_retiredDefaultPwaIcon512Urls),
            PwaMaskableIconUrl = DefaultIfRetiredDefault(dto.PwaMaskableIconUrl, DefaultPwaMaskableIconUrl, s_retiredDefaultPwaMaskableIconUrls),
            ThemeColor = DefaultIfRetiredDefault(dto.ThemeColor, DefaultThemeColor, s_retiredDefaultThemeColors),
            BackgroundColor = DefaultIfRetiredDefault(dto.BackgroundColor, DefaultBackgroundColor, s_retiredDefaultBackgroundColors),
            SiteLogoUrl = dto.SiteLogoUrl,
            SiteLogoDarkUrl = dto.SiteLogoDarkUrl,
            SiteWordmarkUrl = dto.SiteWordmarkUrl,
            AdminLogoUrl = dto.AdminLogoUrl,
            AdminCollapsedIconUrl = dto.AdminCollapsedIconUrl,
            LoginLogoUrl = dto.LoginLogoUrl,
            LoginIconUrl = dto.LoginIconUrl
        });

    private static SeoConfigReadModel NormalizeSeoConfig(UpdateSeoConfigRequest dto)
    {
        string title = TrimUtf8Bytes(dto.Title, 50);
        string baseUrl = NormalizeHttpUrlOrDefault(dto.BaseUrl, PublicSiteIdentityDefaults.SiteBaseUrl, 256).TrimEnd('/');

        return new SeoConfigReadModel
        {
            Title = string.IsNullOrWhiteSpace(title) ? PublicSiteIdentityDefaults.SiteTitle : title,
            Description = TrimText(dto.Description, 200),
            Keywords = TrimUtf8Bytes(dto.Keywords, 256),
            Author = PublicSiteAuthorPolicy.Resolve(dto.Author),
            OgImage = NormalizeAssetUrlOrDefault(dto.OgImage, DefaultOgImage, 256),
            BaseUrl = baseUrl.Length == 0 ? PublicSiteIdentityDefaults.SiteBaseUrl : baseUrl,
            FaviconSvgUrl = NormalizeAssetUrlOrDefault(dto.FaviconSvgUrl, DefaultFaviconSvgUrl, 256),
            FaviconIcoUrl = NormalizeAssetUrlOrDefault(dto.FaviconIcoUrl, DefaultFaviconIcoUrl, 256),
            FaviconPngUrl = NormalizeAssetUrlOrDefault(dto.FaviconPngUrl, DefaultFaviconPngUrl, 256),
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
        => string.Equals(TextHelpers.LowerTrimmed(value), "mainland-cn", StringComparison.Ordinal)
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
        string trimmed = TrimUtf8Bytes(value, 32);
        if (trimmed.Length == 0)
        {
            return fallback;
        }

        string normalized = trimmed.ToLowerInvariant();
        if (!IsHexColor(normalized))
        {
            return fallback;
        }

        return string.Equals(normalized, fallback, StringComparison.OrdinalIgnoreCase)
            ? fallback
            : normalized;
    }

    private static bool IsHexColor(string value)
    {
        if (value.Length is not (4 or 7) || value[0] != '#')
        {
            return false;
        }

        return HexText.IsHex(value.AsSpan(1));
    }

    private static string TrimText(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        string normalized = TextHelpers.TrimOrEmpty(value);
        return normalized.Length > maxLength ? normalized[..maxLength] : normalized;
    }

    private async Task InvalidatePagePublicAotAsync(string slug, string operation, string mutationId)
    {
        if (!TryResolveStaticPageKind(slug, out PublicPageKind kind))
        {
            return;
        }

        try
        {
            await _publicAotInvalidationService
                .InvalidateStaticPageAsync(kind, mutationId, CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "invalidate-static-page-aot-failed {Slug} {Operation}", slug, operation);
            throw;
        }
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
            .In(c => c.Key, s_seoConfigKeys)
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
            Title = GetValue(configs, KeyTitle, PublicSiteIdentityDefaults.SiteTitle),
            Description = GetValue(configs, KeyDesc, PublicSiteIdentityDefaults.SiteDescription),
            Keywords = GetValue(configs, KeyKeywords, PublicSiteIdentityDefaults.SiteKeywords),
            Author = GetValue(configs, PublicSiteAuthorPolicy.ConfigurationKey, PublicSiteIdentityDefaults.SiteAuthor),
            OgImage = GetDefaultAwareValue(configs, KeyOgImage, DefaultOgImage, s_retiredDefaultOgImages),
            BaseUrl = GetValue(configs, KeyBaseUrl, PublicSiteIdentityDefaults.SiteBaseUrl),
            FaviconSvgUrl = GetDefaultAwareValue(configs, KeyFaviconSvgUrl, DefaultFaviconSvgUrl, s_retiredDefaultFaviconSvgUrls),
            FaviconIcoUrl = GetDefaultAwareValue(configs, KeyFaviconIcoUrl, DefaultFaviconIcoUrl, s_retiredDefaultFaviconIcoUrls),
            FaviconPngUrl = GetValue(configs, KeyFaviconPngUrl, DefaultFaviconPngUrl),
            AppleTouchIconUrl = GetDefaultAwareValue(configs, KeyAppleTouchIconUrl, DefaultAppleTouchIconUrl, s_retiredDefaultAppleTouchIconUrls),
            ManifestName = GetValue(configs, KeyManifestName, string.Empty),
            ManifestShortName = GetValue(configs, KeyManifestShortName, PublicSiteIdentityDefaults.ManifestShortName),
            PwaIcon192Url = GetDefaultAwareValue(configs, KeyPwaIcon192Url, DefaultPwaIcon192Url, s_retiredDefaultPwaIcon192Urls),
            PwaIcon512Url = GetDefaultAwareValue(configs, KeyPwaIcon512Url, DefaultPwaIcon512Url, s_retiredDefaultPwaIcon512Urls),
            PwaMaskableIconUrl = GetDefaultAwareValue(configs, KeyPwaMaskableIconUrl, DefaultPwaMaskableIconUrl, s_retiredDefaultPwaMaskableIconUrls),
            ThemeColor = GetDefaultAwareValue(configs, KeyThemeColor, DefaultThemeColor, s_retiredDefaultThemeColors),
            BackgroundColor = GetDefaultAwareValue(configs, KeyBackgroundColor, DefaultBackgroundColor, s_retiredDefaultBackgroundColors),
            SiteLogoUrl = GetValue(configs, KeySiteLogoUrl, string.Empty),
            SiteLogoDarkUrl = GetValue(configs, KeySiteLogoDarkUrl, string.Empty),
            SiteWordmarkUrl = GetValue(configs, KeySiteWordmarkUrl, string.Empty),
            AdminLogoUrl = GetValue(configs, KeyAdminLogoUrl, string.Empty),
            AdminCollapsedIconUrl = GetValue(configs, KeyAdminCollapsedIconUrl, string.Empty),
            LoginLogoUrl = GetValue(configs, KeyLoginLogoUrl, string.Empty),
            LoginIconUrl = GetValue(configs, KeyLoginIconUrl, string.Empty)
        });
    }

    private async Task<SiteComplianceConfigReadModel> LoadComplianceConfigFromDbAsync(CancellationToken cancellationToken)
    {
        var query = _db.Queryable<SystemConfig>()
            .In(c => c.Key, s_complianceConfigKeys)
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
            Enabled = ParseBool(GetValue(configs, KeyComplianceEnabled, "false")),
            RegionMode = NormalizeRegionMode(GetValue(configs, KeyComplianceRegionMode, "global")),
            CopyrightOwner = TrimUtf8Bytes(GetValue(configs, KeyComplianceCopyrightOwner, string.Empty), 128),
            CopyrightStartYear = ParseStartYear(GetValue(configs, KeyComplianceCopyrightStartYear, string.Empty)),
            CopyrightText = TrimText(GetValue(configs, KeyComplianceCopyrightText, string.Empty), 512),
            ContentLicenseName = TrimUtf8Bytes(GetValue(configs, KeyComplianceContentLicenseName, string.Empty), 128),
            ContentLicenseUrl = NormalizeOptionalHttpUrl(GetValue(configs, KeyComplianceContentLicenseUrl, string.Empty), 256),
            IcpRecordNumber = TrimUtf8Bytes(GetValue(configs, KeyComplianceIcpRecordNumber, string.Empty), 64),
            IcpRecordUrl = NormalizeHttpUrlOrDefault(GetValue(configs, KeyComplianceIcpRecordUrl, DefaultIcpRecordUrl), DefaultIcpRecordUrl, 256),
            PoliceRecordNumber = TrimUtf8Bytes(GetValue(configs, KeyCompliancePoliceRecordNumber, string.Empty), 64),
            PoliceRecordUrl = NormalizeHttpUrlOrDefault(GetValue(configs, KeyCompliancePoliceRecordUrl, DefaultPoliceRecordUrl), DefaultPoliceRecordUrl, 256),
            PoliceBadgeIconUrl = NormalizeOptionalHttpUrl(GetValue(configs, KeyCompliancePoliceBadgeIconUrl, string.Empty), 256),
            OperatorName = TrimUtf8Bytes(GetValue(configs, KeyComplianceOperatorName, string.Empty), 128),
            ContactEmail = TrimUtf8Bytes(GetValue(configs, KeyComplianceContactEmail, string.Empty), 128)
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
        CacheReadResult<string> read = await _cacheReader.TryGetAsync<string>(
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

    // LoggerMessage source-generates typed logging calls without a params object array.

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
