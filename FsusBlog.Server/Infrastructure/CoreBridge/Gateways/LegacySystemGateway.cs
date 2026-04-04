using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacySystemGateway(SystemService legacy) : ILegacySystemGateway
{
    public async Task<object> GetSeoConfigAsync() => await legacy.GetSeoConfigAsync();

    public Task UpdateSeoConfigAsync(object dto) => legacy.UpdateSeoConfigAsync((SeoConfigDto)dto);

    public async Task<object> GetPageContentAsync(string slug) => await legacy.GetPageContentAsync(slug);

    public Task UpdatePageContentAsync(object dto) => legacy.UpdatePageContentAsync((PageContentDto)dto);
}
