using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class SystemCoreService(ILegacySystemGateway gateway) : ISystemCoreService
{
    public async Task<Result<object>> GetSeoConfigAsync() => Result<object>.Success(await gateway.GetSeoConfigAsync());

    public async Task<Result> UpdateSeoConfigAsync(object dto)
    {
        await gateway.UpdateSeoConfigAsync(dto);
        return Result.Success();
    }

    public async Task<Result<object>> GetPageContentAsync(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug))
        {
            return Result<object>.Failure(ErrorCode.Validation, "页面标识不能为空");
        }

        return Result<object>.Success(await gateway.GetPageContentAsync(slug));
    }

    public async Task<Result> UpdatePageContentAsync(object dto)
    {
        await gateway.UpdatePageContentAsync(dto);
        return Result.Success();
    }
}
