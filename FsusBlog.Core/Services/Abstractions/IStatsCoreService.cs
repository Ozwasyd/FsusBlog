using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Abstractions;

public interface IStatsCoreService
{
    Task<Result<SiteStatsCoreModel>> GetAdminStatsAsync();
}
