using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Implementations;

public sealed class UserCoreService(IUserCoreGateway gateway) : IUserCoreService
{
    public async Task<Result<AccountSnapshotContract?>> GetByIdAsync(int id)
    {
        if (id <= 0)
        {
            return Result<AccountSnapshotContract?>.Failure(ErrorCode.Validation, "账号ID非法");
        }

        var account = await gateway.GetByIdAsync(id);
        return account.HasValue
            ? Result<AccountSnapshotContract?>.Success(account.Value)
            : Result<AccountSnapshotContract?>.Failure(ErrorCode.NotFound, "账号不存在");
    }

    public async Task<Result<TokenPairContract>> RefreshTokenAsync(string refreshToken)
    {
        var result = await gateway.RefreshTokenAsync(refreshToken);
        return result.Success && result.Data.HasValue
            ? Result<TokenPairContract>.Success(result.Data.Value)
            : Result<TokenPairContract>.Failure(ErrorCode.Unauthorized, "令牌刷新失败");
    }

    public async Task<Result> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await gateway.RevokeRefreshTokenAsync(refreshToken, cancellationToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "RefreshToken 不存在");
    }

    public async Task<Result<AdminUserPageContract>> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status)
    {
        if (page <= 0 || pageSize <= 0)
        {
            return Result<AdminUserPageContract>.Failure(ErrorCode.Validation, "分页参数非法");
        }

        return Result<AdminUserPageContract>.Success(await gateway.GetAdminUserListAsync(page, pageSize, keyword, status));
    }

    public async Task<Result> AdminChangeStatusAsync(int userId, int status, string? reason)
    {
        var result = await gateway.AdminChangeStatusAsync(userId, status, reason);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }
}
