using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface ILegacyStatsGateway
{
    Task<SiteStatsCoreModel> GetAdminStatsAsync();
}
