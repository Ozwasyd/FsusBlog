namespace FsusBlog.Server.Models.Requests;

public sealed record class UpdateSeoConfigRequest
{
    public string Title { get; init; } = "Fsus's Blog";
    public string Description { get; init; } = "FORWARD";
    public string Keywords { get; init; } = "记录";
    public string Author { get; init; } = "Fsu";
    public string OgImage { get; init; } = string.Empty;
    public string BaseUrl { get; init; } = "https://blog.fsus.blog";
    public string FaviconSvgUrl { get; init; } = "/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon.ico";
    public string FaviconPngUrl { get; init; } = string.Empty;
    public string AppleTouchIconUrl { get; init; } = "/apple-touch-icon.png";
    public string ManifestName { get; init; } = "FsusBlog";
    public string ManifestShortName { get; init; } = "FsusBlog";
    public string PwaIcon192Url { get; init; } = "/icons/icon-192.png";
    public string PwaIcon512Url { get; init; } = "/icons/icon-512.png";
    public string PwaMaskableIconUrl { get; init; } = "/icons/maskable-512.png";
    public string ThemeColor { get; init; } = "#0f0f11";
    public string BackgroundColor { get; init; } = "#fcfcfc";
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
    public bool Enabled { get; init; }
    public string RegionMode { get; init; } = "global";
    public string CopyrightOwner { get; init; } = string.Empty;
    public int? CopyrightStartYear { get; init; }
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
    public string? Slug { get; init; }
    public string? Content { get; init; }
}
