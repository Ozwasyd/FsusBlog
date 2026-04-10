using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Gateways;

public interface ILegacySystemGateway
{
    Task<SeoConfigContract> GetSeoConfigAsync();
    Task UpdateSeoConfigAsync(SeoConfigContract dto);
    Task<PageContentContract> GetPageContentAsync(string slug);
    Task<bool> UpdatePageContentAsync(PageContentContract dto);
    Task<bool> RefreshPageCacheAsync(string slug);
}
