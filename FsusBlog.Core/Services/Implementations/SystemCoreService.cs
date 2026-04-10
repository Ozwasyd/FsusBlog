using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Implementations;

public sealed class SystemCoreService(ILegacySystemGateway gateway) : ISystemCoreService
{
    public async Task<Result<SeoConfigContract>> GetSeoConfigAsync() => Result<SeoConfigContract>.Success(await gateway.GetSeoConfigAsync());

    public async Task<Result> UpdateSeoConfigAsync(SeoConfigContract dto)
    {
        await gateway.UpdateSeoConfigAsync(dto);
        return Result.Success();
    }

    public async Task<Result<PageContentContract>> GetPageContentAsync(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug))
        {
            return Result<PageContentContract>.Failure(ErrorCode.Validation, "页面标识不能为空");
        }

        return Result<PageContentContract>.Success(await gateway.GetPageContentAsync(slug));
    }

    public async Task<Result> UpdatePageContentAsync(PageContentContract dto)
    {
        var success = await gateway.UpdatePageContentAsync(dto);
        if (!success)
        {
            return Result.Failure(ErrorCode.InfraFailure, "页面内容更新失败");
        }

        return Result.Success();
    }

    public async Task<Result> RefreshPageCacheAsync(string slug)
    {
        if (string.IsNullOrWhiteSpace(slug))
        {
            return Result.Failure(ErrorCode.Validation, "页面标识不能为空");
        }

        return await gateway.RefreshPageCacheAsync(slug)
            ? Result.Success()
            : Result.Failure(ErrorCode.InfraFailure, "页面缓存刷新失败");
    }
}
