using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Models.Requests;

public sealed record class UpdateSeoConfigRequest
{
    public string Title { get; init; } = PublicSiteIdentityDefaults.SiteTitle;
    public string Description { get; init; } = PublicSiteIdentityDefaults.SiteDescription;
    public string Keywords { get; init; } = PublicSiteIdentityDefaults.SiteKeywords;
    public string Author { get; init; } = PublicSiteIdentityDefaults.SiteAuthor;
    public string OgImage { get; init; } = "/social/og-image.png";
    public string BaseUrl { get; init; } = PublicSiteIdentityDefaults.SiteBaseUrl;
    public string FaviconSvgUrl { get; init; } = "/favicon/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon/favicon.ico";
    public string FaviconPngUrl { get; init; } = "/favicon/favicon-32x32.png";
    public string AppleTouchIconUrl { get; init; } = "/favicon/apple-touch-icon.png";
    public string ManifestName { get; init; } = PublicSiteIdentityDefaults.ManifestName;
    public string ManifestShortName { get; init; } = PublicSiteIdentityDefaults.ManifestShortName;
    public string PwaIcon192Url { get; init; } = "/favicon/pwa-192x192.png";
    public string PwaIcon512Url { get; init; } = "/favicon/pwa-512x512.png";
    public string PwaMaskableIconUrl { get; init; } = "/favicon/maskable-icon-512x512.png";
    public string ThemeColor { get; init; } = "#0B4F7A";
    public string BackgroundColor { get; init; } = "#FFFFFF";
    public string SiteLogoUrl { get; init; } = string.Empty;
    public string SiteLogoDarkUrl { get; init; } = string.Empty;
    public string SiteWordmarkUrl { get; init; } = string.Empty;
    public string AdminLogoUrl { get; init; } = string.Empty;
    public string AdminCollapsedIconUrl { get; init; } = string.Empty;
    public string LoginLogoUrl { get; init; } = string.Empty;
    public string LoginIconUrl { get; init; } = string.Empty;
}

public sealed record class UpdateSiteComplianceConfigRequest
{
    public bool Enabled
    {
        get; init;
    }
    public string RegionMode { get; init; } = "global";
    public string CopyrightOwner { get; init; } = string.Empty;
    public int? CopyrightStartYear
    {
        get; init;
    }
    public string CopyrightText { get; init; } = string.Empty;
    public string ContentLicenseName { get; init; } = string.Empty;
    public string ContentLicenseUrl { get; init; } = string.Empty;
    public string IcpRecordNumber { get; init; } = string.Empty;
    public string IcpRecordUrl { get; init; } = "https://beian.miit.gov.cn/";
    public string PoliceRecordNumber { get; init; } = string.Empty;
    public string PoliceRecordUrl { get; init; } = "https://beian.mps.gov.cn/";
    public string PoliceBadgeIconUrl { get; init; } = string.Empty;
    public string OperatorName { get; init; } = string.Empty;
    public string ContactEmail { get; init; } = string.Empty;
}

public sealed record class UpdatePageContentRequest
{
    public string? Slug
    {
        get; init;
    }
    public string? Content
    {
        get; init;
    }
}
