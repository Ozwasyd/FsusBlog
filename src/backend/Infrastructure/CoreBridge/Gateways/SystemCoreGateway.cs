using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class SystemCoreGateway(SystemService service) : ISystemCoreGateway
{
    public async Task<SeoConfigContract> GetSeoConfigAsync()
    {
        var dto = await service.GetSeoConfigAsync();
        return new SeoConfigContract(
            dto.Title,
            dto.Description,
            dto.Keywords,
            dto.Author,
            dto.OgImage,
            dto.BaseUrl,
            dto.FaviconSvgUrl,
            dto.FaviconIcoUrl,
            dto.FaviconPngUrl,
            dto.AppleTouchIconUrl,
            dto.ManifestName,
            dto.ManifestShortName,
            dto.PwaIcon192Url,
            dto.PwaIcon512Url,
            dto.PwaMaskableIconUrl,
            dto.ThemeColor,
            dto.BackgroundColor,
            dto.SiteLogoUrl,
            dto.SiteLogoDarkUrl,
            dto.SiteWordmarkUrl,
            dto.AdminLogoUrl,
            dto.AdminCollapsedIconUrl,
            dto.LoginLogoUrl,
            dto.LoginIconUrl);
    }

    public Task UpdateSeoConfigAsync(SeoConfigContract dto)
        => service.UpdateSeoConfigAsync(new UpdateSeoConfigRequest
        {
            Title = dto.Title,
            Description = dto.Description,
            Keywords = dto.Keywords,
            Author = dto.Author,
            OgImage = dto.OgImage,
            BaseUrl = dto.BaseUrl,
            FaviconSvgUrl = dto.FaviconSvgUrl,
            FaviconIcoUrl = dto.FaviconIcoUrl,
            FaviconPngUrl = dto.FaviconPngUrl,
            AppleTouchIconUrl = dto.AppleTouchIconUrl,
            ManifestName = dto.ManifestName,
            ManifestShortName = dto.ManifestShortName,
            PwaIcon192Url = dto.PwaIcon192Url,
            PwaIcon512Url = dto.PwaIcon512Url,
            PwaMaskableIconUrl = dto.PwaMaskableIconUrl,
            ThemeColor = dto.ThemeColor,
            BackgroundColor = dto.BackgroundColor,
            SiteLogoUrl = dto.SiteLogoUrl,
            SiteLogoDarkUrl = dto.SiteLogoDarkUrl,
            SiteWordmarkUrl = dto.SiteWordmarkUrl,
            AdminLogoUrl = dto.AdminLogoUrl,
            AdminCollapsedIconUrl = dto.AdminCollapsedIconUrl,
            LoginLogoUrl = dto.LoginLogoUrl,
            LoginIconUrl = dto.LoginIconUrl
        });

    public async Task<SiteComplianceConfigContract> GetSiteComplianceConfigAsync()
    {
        var dto = await service.GetSiteComplianceConfigAsync();
        return new SiteComplianceConfigContract(
            dto.Enabled,
            dto.RegionMode,
            dto.CopyrightOwner,
            dto.CopyrightStartYear,
            dto.CopyrightText,
            dto.ContentLicenseName,
            dto.ContentLicenseUrl,
            dto.IcpRecordNumber,
            dto.IcpRecordUrl,
            dto.PoliceRecordNumber,
            dto.PoliceRecordUrl,
            dto.PoliceBadgeIconUrl,
            dto.OperatorName,
            dto.ContactEmail);
    }

    public Task UpdateSiteComplianceConfigAsync(SiteComplianceConfigContract dto)
        => service.UpdateSiteComplianceConfigAsync(new UpdateSiteComplianceConfigRequest
        {
            Enabled = dto.Enabled,
            RegionMode = dto.RegionMode,
            CopyrightOwner = dto.CopyrightOwner,
            CopyrightStartYear = dto.CopyrightStartYear,
            CopyrightText = dto.CopyrightText,
            ContentLicenseName = dto.ContentLicenseName,
            ContentLicenseUrl = dto.ContentLicenseUrl,
            IcpRecordNumber = dto.IcpRecordNumber,
            IcpRecordUrl = dto.IcpRecordUrl,
            PoliceRecordNumber = dto.PoliceRecordNumber,
            PoliceRecordUrl = dto.PoliceRecordUrl,
            PoliceBadgeIconUrl = dto.PoliceBadgeIconUrl,
            OperatorName = dto.OperatorName,
            ContactEmail = dto.ContactEmail
        });

    public async Task<PageContentContract> GetPageContentAsync(string slug)
    {
        var dto = await service.GetPageContentAsync(slug);
        return new PageContentContract(dto.Slug, dto.Content);
    }

    public Task<bool> UpdatePageContentAsync(PageContentContract dto)
        => service.UpdatePageContentAsync(new UpdatePageContentRequest
        {
            Slug = dto.Slug,
            Content = dto.Content
        });

    public Task<bool> RefreshPageCacheAsync(string slug)
        => service.RefreshPageCacheAsync(slug);
}
