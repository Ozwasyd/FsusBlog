using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacySystemGateway(SystemService legacy) : ILegacySystemGateway
{
    public async Task<SeoConfigContract> GetSeoConfigAsync()
    {
        var dto = await legacy.GetSeoConfigAsync();
        return new SeoConfigContract(dto.Title, dto.Description, dto.Keywords, dto.Author, dto.OgImage, dto.BaseUrl);
    }

    public Task UpdateSeoConfigAsync(SeoConfigContract dto)
        => legacy.UpdateSeoConfigAsync(new SeoConfigDto
        {
            Title = dto.Title,
            Description = dto.Description,
            Keywords = dto.Keywords,
            Author = dto.Author,
            OgImage = dto.OgImage,
            BaseUrl = dto.BaseUrl
        });

    public async Task<PageContentContract> GetPageContentAsync(string slug)
    {
        var dto = await legacy.GetPageContentAsync(slug);
        return new PageContentContract(dto.Slug, dto.Content);
    }

    public Task<bool> UpdatePageContentAsync(PageContentContract dto)
        => legacy.UpdatePageContentAsync(new PageContentDto
        {
            Slug = dto.Slug,
            Content = dto.Content
        });

    public Task<bool> RefreshPageCacheAsync(string slug)
        => legacy.RefreshPageCacheAsync(slug);
}
