namespace FsusBlog.Server.Models.ReadModels;

public sealed record class SeoConfigReadModel
{
    public string Title { get; init; } = "Fsus's Blog";
    public string Description { get; init; } = "FORWARD";
    public string Keywords { get; init; } = "记录";
    public string Author { get; init; } = "Fsu";
    public string OgImage { get; init; } = string.Empty;
    public string BaseUrl { get; init; } = "https://blog.fsus.blog";
}

public sealed record class SiteComplianceConfigReadModel
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

public sealed record class PageContentReadModel
{
    public string? Slug { get; init; }
    public string? Content { get; init; }
}
