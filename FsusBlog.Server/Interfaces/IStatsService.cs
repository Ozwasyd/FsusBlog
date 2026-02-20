using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Interfaces;

public interface IStatsService
{
    Task<SiteStatsDto> GetAdminStatsAsync();
}
