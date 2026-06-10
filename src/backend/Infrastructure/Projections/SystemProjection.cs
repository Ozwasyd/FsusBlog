using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.AuthSystem;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class SystemProjection
{
    public static SeoConfigPublicDto ToPublicDto(SeoConfigReadModel model)
        => new()
        {
            Title = model.Title,
            Description = model.Description,
            Keywords = model.Keywords,
            Author = model.Author,
            OgImage = model.OgImage,
            BaseUrl = model.BaseUrl,
            FaviconSvgUrl = model.FaviconSvgUrl,
            FaviconIcoUrl = model.FaviconIcoUrl,
            FaviconPngUrl = model.FaviconPngUrl,
            AppleTouchIconUrl = model.AppleTouchIconUrl,
            ManifestName = model.ManifestName,
            ManifestShortName = model.ManifestShortName,
            PwaIcon192Url = model.PwaIcon192Url,
            PwaIcon512Url = model.PwaIcon512Url,
            PwaMaskableIconUrl = model.PwaMaskableIconUrl,
            ThemeColor = model.ThemeColor,
            BackgroundColor = model.BackgroundColor,
            SiteLogoUrl = model.SiteLogoUrl,
            SiteLogoDarkUrl = model.SiteLogoDarkUrl,
            SiteWordmarkUrl = model.SiteWordmarkUrl,
            AdminLogoUrl = model.AdminLogoUrl,
            AdminCollapsedIconUrl = model.AdminCollapsedIconUrl,
            LoginLogoUrl = model.LoginLogoUrl,
            LoginIconUrl = model.LoginIconUrl
        };

    public static SeoConfigAdminDto ToAdminDto(SeoConfigReadModel model)
        => new()
        {
            Title = model.Title,
            Description = model.Description,
            Keywords = model.Keywords,
            Author = model.Author,
            OgImage = model.OgImage,
            BaseUrl = model.BaseUrl,
            FaviconSvgUrl = model.FaviconSvgUrl,
            FaviconIcoUrl = model.FaviconIcoUrl,
            FaviconPngUrl = model.FaviconPngUrl,
            AppleTouchIconUrl = model.AppleTouchIconUrl,
            ManifestName = model.ManifestName,
            ManifestShortName = model.ManifestShortName,
            PwaIcon192Url = model.PwaIcon192Url,
            PwaIcon512Url = model.PwaIcon512Url,
            PwaMaskableIconUrl = model.PwaMaskableIconUrl,
            ThemeColor = model.ThemeColor,
            BackgroundColor = model.BackgroundColor,
            SiteLogoUrl = model.SiteLogoUrl,
            SiteLogoDarkUrl = model.SiteLogoDarkUrl,
            SiteWordmarkUrl = model.SiteWordmarkUrl,
            AdminLogoUrl = model.AdminLogoUrl,
            AdminCollapsedIconUrl = model.AdminCollapsedIconUrl,
            LoginLogoUrl = model.LoginLogoUrl,
            LoginIconUrl = model.LoginIconUrl
        };

    public static SeoConfigContract ToContract(SeoConfigReadModel model)
        => new(
            model.Title,
            model.Description,
            model.Keywords,
            model.Author,
            model.OgImage,
            model.BaseUrl,
            model.FaviconSvgUrl,
            model.FaviconIcoUrl,
            model.FaviconPngUrl,
            model.AppleTouchIconUrl,
            model.ManifestName,
            model.ManifestShortName,
            model.PwaIcon192Url,
            model.PwaIcon512Url,
            model.PwaMaskableIconUrl,
            model.ThemeColor,
            model.BackgroundColor,
            model.SiteLogoUrl,
            model.SiteLogoDarkUrl,
            model.SiteWordmarkUrl,
            model.AdminLogoUrl,
            model.AdminCollapsedIconUrl,
            model.LoginLogoUrl,
            model.LoginIconUrl);

    public static SiteComplianceConfigPublicDto ToPublicDto(SiteComplianceConfigReadModel model)
        => new()
        {
            Enabled = model.Enabled,
            RegionMode = model.RegionMode,
            CopyrightOwner = model.CopyrightOwner,
            CopyrightStartYear = model.CopyrightStartYear,
            CopyrightText = model.CopyrightText,
            ContentLicenseName = model.ContentLicenseName,
            ContentLicenseUrl = model.ContentLicenseUrl,
            IcpRecordNumber = model.IcpRecordNumber,
            IcpRecordUrl = model.IcpRecordUrl,
            PoliceRecordNumber = model.PoliceRecordNumber,
            PoliceRecordUrl = model.PoliceRecordUrl,
            PoliceBadgeIconUrl = model.PoliceBadgeIconUrl,
            OperatorName = model.OperatorName,
            ContactEmail = model.ContactEmail
        };

    public static SiteComplianceConfigAdminDto ToAdminDto(SiteComplianceConfigReadModel model)
        => new()
        {
            Enabled = model.Enabled,
            RegionMode = model.RegionMode,
            CopyrightOwner = model.CopyrightOwner,
            CopyrightStartYear = model.CopyrightStartYear,
            CopyrightText = model.CopyrightText,
            ContentLicenseName = model.ContentLicenseName,
            ContentLicenseUrl = model.ContentLicenseUrl,
            IcpRecordNumber = model.IcpRecordNumber,
            IcpRecordUrl = model.IcpRecordUrl,
            PoliceRecordNumber = model.PoliceRecordNumber,
            PoliceRecordUrl = model.PoliceRecordUrl,
            PoliceBadgeIconUrl = model.PoliceBadgeIconUrl,
            OperatorName = model.OperatorName,
            ContactEmail = model.ContactEmail
        };

    public static SiteComplianceConfigContract ToContract(SiteComplianceConfigReadModel model)
        => new(
            model.Enabled,
            model.RegionMode,
            model.CopyrightOwner,
            model.CopyrightStartYear,
            model.CopyrightText,
            model.ContentLicenseName,
            model.ContentLicenseUrl,
            model.IcpRecordNumber,
            model.IcpRecordUrl,
            model.PoliceRecordNumber,
            model.PoliceRecordUrl,
            model.PoliceBadgeIconUrl,
            model.OperatorName,
            model.ContactEmail);

    public static PageContentPublicDto ToPublicDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentAdminDto ToAdminDto(PageContentReadModel model)
        => new() { Slug = model.Slug, Content = model.Content };

    public static PageContentContract ToContract(PageContentReadModel model)
        => new(model.Slug, model.Content);
}
