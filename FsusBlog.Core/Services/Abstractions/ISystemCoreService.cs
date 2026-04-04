using FsusBlog.Core.Common;

namespace FsusBlog.Core.Services.Abstractions;

public interface ISystemCoreService
{
    Task<Result<object>> GetSeoConfigAsync();
    Task<Result> UpdateSeoConfigAsync(object dto);
    Task<Result<object>> GetPageContentAsync(string slug);
    Task<Result> UpdatePageContentAsync(object dto);
}
