using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Implementations;

public sealed class UserCoreService(IUserCoreGateway gateway) : IUserCoreService
{
    public async Task<Result> RegisterAsync(string username, string password, string confirmPassword)
    {
        var result = await gateway.RegisterAsync(username, password, confirmPassword);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }

    public async Task<Result<AuthLoginResultContract>> LoginAsync(string username, string password, string clientIp)
    {
        var result = await gateway.LoginAsync(username, password, clientIp);
        return result.Success && result.Data.HasValue
            ? Result<AuthLoginResultContract>.Success(result.Data.Value)
            : Result<AuthLoginResultContract>.Failure(ErrorCode.Unauthorized, result.Message);
    }

    public async Task<Result<UserSnapshotContract?>> GetByIdAsync(int id)
    {
        if (id <= 0)
        {
            return Result<UserSnapshotContract?>.Failure(ErrorCode.Validation, "用户ID非法");
        }

        var user = await gateway.GetByIdAsync(id);
        return user.HasValue
            ? Result<UserSnapshotContract?>.Success(user.Value)
            : Result<UserSnapshotContract?>.Failure(ErrorCode.NotFound, "用户不存在");
    }

    public async Task<Result<UserSnapshotContract?>> GetByUsernameAsync(string username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return Result<UserSnapshotContract?>.Failure(ErrorCode.Validation, "用户名不能为空");
        }

        var user = await gateway.GetByUsernameAsync(username);
        return user.HasValue
            ? Result<UserSnapshotContract?>.Success(user.Value)
            : Result<UserSnapshotContract?>.Failure(ErrorCode.NotFound, "用户不存在");
    }

    public async Task<Result> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword)
    {
        var result = await gateway.UpdatePasswordAsync(userId, oldPassword, newPassword, confirmPassword);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
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
