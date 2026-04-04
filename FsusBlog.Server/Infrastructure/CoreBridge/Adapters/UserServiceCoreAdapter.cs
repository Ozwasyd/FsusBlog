using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class UserServiceCoreAdapter(IUserCoreService core) : IUserService
{
    public async Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto)
    {
        var result = await core.RegisterAsync(dto.Username, dto.Password, dto.ConfirmPassword);
        return result.IsSuccess ? (true, "注册成功") : (false, result.Error.Message);
    }

    public async Task<(bool Success, string Message, TokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp)
    {
        var result = await core.LoginAsync(dto.Username, dto.Password, clientIp);
        if (!result.IsSuccess)
        {
            return (false, result.Error.Message, null, null);
        }

        return result.Value is ValueTuple<object, object> payload
               && payload.Item1 is TokenResponseDto token
               && payload.Item2 is User user
            ? (true, "登录成功", token, user)
            : (false, "登录失败", null, null);
    }

    public async Task<User?> GetByIdAsync(int id)
    {
        var result = await core.GetByIdAsync(id);
        return result.IsSuccess ? result.Value as User : null;
    }

    public async Task<User?> GetByUsernameAsync(string username)
    {
        var result = await core.GetByUsernameAsync(username);
        return result.IsSuccess ? result.Value as User : null;
    }

    public async Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername)
    {
        var result = await core.UpdateUsernameAsync(userId, newUsername);
        return result.IsSuccess && result.Value is TokenResponseDto token
            ? (true, "用户名更新成功", token)
            : (false, result.Error.Message, null);
    }

    public async Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto)
    {
        var result = await core.UpdatePasswordAsync(userId, dto.OldPassword, dto.NewPassword, dto.ConfirmPassword);
        return result.IsSuccess ? (true, "密码更新成功") : (false, result.Error.Message);
    }

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken)
    {
        var result = await core.RefreshTokenAsync(refreshToken);
        return result.IsSuccess && result.Value is TokenResponseDto token
            ? (true, token)
            : (false, null);
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken)
        => (await core.RevokeRefreshTokenAsync(refreshToken)).IsSuccess;

    public async Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto)
    {
        var result = await core.GetAdminUserListAsync(dto.Page, dto.PageSize, dto.Keyword, dto.Status);
        return result.IsSuccess && result.Value is PageResult<UserListDto> data
            ? data
            : new PageResult<UserListDto> { Total = 0, Items = [] };
    }

    public async Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
    {
        var result = await core.AdminChangeStatusAsync(dto.UserId, dto.Status, dto.Reason);
        return result.IsSuccess ? (true, "状态更新成功") : (false, result.Error.Message);
    }

    public async Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto)
    {
        var result = await core.AdminResetPasswordAsync(dto.UserId, dto.NewPassword);
        return result.IsSuccess ? (true, "密码重置成功") : (false, result.Error.Message);
    }
}
