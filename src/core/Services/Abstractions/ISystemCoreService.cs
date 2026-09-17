using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Abstractions;

public interface ISystemCoreService
{
    Task<Result<SeoConfigContract>> GetSeoConfigAsync();
    Task<Result> UpdateSeoConfigAsync(SeoConfigContract dto);
    Task<Result<SiteComplianceConfigContract>> GetSiteComplianceConfigAsync();
    Task<Result> UpdateSiteComplianceConfigAsync(SiteComplianceConfigContract dto);
    Task<Result<PageContentContract>> GetPageContentAsync(string slug);
    Task<Result> UpdatePageContentAsync(PageContentContract dto);
    Task<Result> RefreshPageCacheAsync(string slug);
}
