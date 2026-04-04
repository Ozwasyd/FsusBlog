using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class UserCoreService(ILegacyUserGateway gateway) : IUserCoreService
{
    public async Task<Result> RegisterAsync(string username, string password, string confirmPassword)
    {
        var result = await gateway.RegisterAsync(username, password, confirmPassword);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }

    public async Task<Result<object>> LoginAsync(string username, string password, string clientIp)
    {
        var result = await gateway.LoginAsync(username, password, clientIp);
        return result.Success && result.Data is not null && result.UserEntity is not null
            ? Result<object>.Success((result.Data, result.UserEntity))
            : Result<object>.Failure(ErrorCode.Unauthorized, result.Message);
    }

    public async Task<Result<object?>> GetByIdAsync(int id)
    {
        if (id <= 0)
        {
            return Result<object?>.Failure(ErrorCode.Validation, "用户ID非法");
        }

        var user = await gateway.GetByIdAsync(id);
        return user is null
            ? Result<object?>.Failure(ErrorCode.NotFound, "用户不存在")
            : Result<object?>.Success(user);
    }

    public async Task<Result<object?>> GetByUsernameAsync(string username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return Result<object?>.Failure(ErrorCode.Validation, "用户名不能为空");
        }

        var user = await gateway.GetByUsernameAsync(username);
        return user is null
            ? Result<object?>.Failure(ErrorCode.NotFound, "用户不存在")
            : Result<object?>.Success(user);
    }

    public async Task<Result<object>> UpdateUsernameAsync(int userId, string newUsername)
    {
        var result = await gateway.UpdateUsernameAsync(userId, newUsername);
        return result.Success && result.Data is not null
            ? Result<object>.Success(result.Data)
            : Result<object>.Failure(ErrorCode.Validation, result.Message);
    }

    public async Task<Result> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword)
    {
        var result = await gateway.UpdatePasswordAsync(userId, oldPassword, newPassword, confirmPassword);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }

    public async Task<Result<object>> RefreshTokenAsync(string refreshToken)
    {
        var result = await gateway.RefreshTokenAsync(refreshToken);
        return result.Success && result.Data is not null
            ? Result<object>.Success(result.Data)
            : Result<object>.Failure(ErrorCode.Unauthorized, "令牌刷新失败");
    }

    public async Task<Result> RevokeRefreshTokenAsync(string refreshToken)
    {
        return await gateway.RevokeRefreshTokenAsync(refreshToken)
            ? Result.Success()
            : Result.Failure(ErrorCode.NotFound, "RefreshToken 不存在");
    }

    public async Task<Result<object>> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status)
    {
        if (page <= 0 || pageSize <= 0)
        {
            return Result<object>.Failure(ErrorCode.Validation, "分页参数非法");
        }

        return Result<object>.Success(await gateway.GetAdminUserListAsync(page, pageSize, keyword, status));
    }

    public async Task<Result> AdminChangeStatusAsync(int userId, int status, string? reason)
    {
        var result = await gateway.AdminChangeStatusAsync(userId, status, reason);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }

    public async Task<Result> AdminResetPasswordAsync(int userId, string newPassword)
    {
        var result = await gateway.AdminResetPasswordAsync(userId, newPassword);
        return result.Success
            ? Result.Success()
            : Result.Failure(ErrorCode.Validation, result.Message);
    }
}
