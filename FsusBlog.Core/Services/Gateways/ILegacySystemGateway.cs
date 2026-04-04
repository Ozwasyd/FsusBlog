namespace FsusBlog.Core.Services.Gateways;

public interface ILegacySystemGateway
{
    Task<object> GetSeoConfigAsync();
    Task UpdateSeoConfigAsync(object dto);
    Task<object> GetPageContentAsync(string slug);
    Task UpdatePageContentAsync(object dto);
}
