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
        return new SeoConfigContract(dto.Title, dto.Description, dto.Keywords, dto.Author, dto.OgImage, dto.BaseUrl);
    }

    public Task UpdateSeoConfigAsync(SeoConfigContract dto)
        => service.UpdateSeoConfigAsync(new UpdateSeoConfigRequest
        {
            Title = dto.Title,
            Description = dto.Description,
            Keywords = dto.Keywords,
            Author = dto.Author,
            OgImage = dto.OgImage,
            BaseUrl = dto.BaseUrl
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
