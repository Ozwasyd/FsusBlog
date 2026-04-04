using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class SystemServiceCoreAdapter(ISystemCoreService core) : ISystemService
{
    public async Task<SeoConfigDto> GetSeoConfigAsync()
    {
        var result = await core.GetSeoConfigAsync();
        return result.IsSuccess && result.Value is SeoConfigDto data ? data : new SeoConfigDto();
    }

    public async Task UpdateSeoConfigAsync(SeoConfigDto dto)
        => _ = await core.UpdateSeoConfigAsync(dto);

    public async Task<PageContentDto> GetPageContentAsync(string slug)
    {
        var result = await core.GetPageContentAsync(slug);
        return result.IsSuccess && result.Value is PageContentDto data ? data : default;
    }

    public async Task UpdatePageContentAsync(PageContentDto dto)
        => _ = await core.UpdatePageContentAsync(dto);
}
