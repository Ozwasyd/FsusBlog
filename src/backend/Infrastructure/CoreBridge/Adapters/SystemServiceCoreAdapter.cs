using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class SystemServiceCoreAdapter(ISystemCoreService core) : ISystemService
{
    public async Task<SeoConfigReadModel> GetSeoConfigAsync()
    {
        var result = await core.GetSeoConfigAsync();
        if (!result.IsSuccess)
        {
            return new SeoConfigReadModel();
        }

        return new SeoConfigReadModel
        {
            Title = result.Value.Title,
            Description = result.Value.Description,
            Keywords = result.Value.Keywords,
            Author = result.Value.Author,
            OgImage = result.Value.OgImage,
            BaseUrl = result.Value.BaseUrl
        };
    }

    public async Task UpdateSeoConfigAsync(UpdateSeoConfigRequest dto)
        => _ = await core.UpdateSeoConfigAsync(new(
            dto.Title,
            dto.Description,
            dto.Keywords,
            dto.Author,
            dto.OgImage,
            dto.BaseUrl));

    public async Task<SiteComplianceConfigReadModel> GetSiteComplianceConfigAsync()
    {
        var result = await core.GetSiteComplianceConfigAsync();
        if (!result.IsSuccess)
        {
            return new SiteComplianceConfigReadModel();
        }

        return new SiteComplianceConfigReadModel
        {
            Enabled = result.Value.Enabled,
            RegionMode = result.Value.RegionMode,
            CopyrightOwner = result.Value.CopyrightOwner,
            CopyrightStartYear = result.Value.CopyrightStartYear,
            CopyrightText = result.Value.CopyrightText,
            ContentLicenseName = result.Value.ContentLicenseName,
            ContentLicenseUrl = result.Value.ContentLicenseUrl,
            IcpRecordNumber = result.Value.IcpRecordNumber,
            IcpRecordUrl = result.Value.IcpRecordUrl,
            PoliceRecordNumber = result.Value.PoliceRecordNumber,
            PoliceRecordUrl = result.Value.PoliceRecordUrl,
            PoliceBadgeIconUrl = result.Value.PoliceBadgeIconUrl,
            OperatorName = result.Value.OperatorName,
            ContactEmail = result.Value.ContactEmail
        };
    }

    public async Task UpdateSiteComplianceConfigAsync(UpdateSiteComplianceConfigRequest dto)
        => _ = await core.UpdateSiteComplianceConfigAsync(new(
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
            dto.ContactEmail));

    public async Task<PageContentReadModel> GetPageContentAsync(string slug)
    {
        var result = await core.GetPageContentAsync(slug);
        return result.IsSuccess
            ? new PageContentReadModel { Slug = result.Value.Slug, Content = result.Value.Content }
            : new PageContentReadModel();
    }

    public async Task<bool> UpdatePageContentAsync(UpdatePageContentRequest dto)
    {
        var result = await core.UpdatePageContentAsync(new(dto.Slug, dto.Content));
        return result.IsSuccess;
    }

    public async Task<bool> RefreshPageCacheAsync(string slug)
    {
        var result = await core.RefreshPageCacheAsync(slug);
        return result.IsSuccess;
    }
}
