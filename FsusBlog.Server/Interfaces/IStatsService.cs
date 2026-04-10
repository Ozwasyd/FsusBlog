using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IStatsService
{
    Task<SiteStatsDto> GetAdminStatsAsync();
}
