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
