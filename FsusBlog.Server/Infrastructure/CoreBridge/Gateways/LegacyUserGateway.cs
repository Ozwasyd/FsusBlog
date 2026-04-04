using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacyUserGateway(UserService legacy) : ILegacyUserGateway
{
    public Task<(bool Success, string Message)> RegisterAsync(string username, string password, string confirmPassword)
        => legacy.RegisterAsync(new RegisterDto { Username = username, Password = password, ConfirmPassword = confirmPassword });

    public async Task<(bool Success, string Message, object? Data, object? UserEntity)> LoginAsync(string username, string password, string clientIp)
    {
        var result = await legacy.LoginAsync(new LoginDto { Username = username, Password = password }, clientIp);
        return (result.Success, result.Message, result.Data, result.UserEntity);
    }

    public async Task<object?> GetByIdAsync(int id) => await legacy.GetByIdAsync(id);

    public async Task<object?> GetByUsernameAsync(string username) => await legacy.GetByUsernameAsync(username);

    public async Task<(bool Success, string Message, object? Data)> UpdateUsernameAsync(int userId, string newUsername)
    {
        var result = await legacy.UpdateUsernameAsync(userId, newUsername);
        return (result.Success, result.Message, result.Data);
    }

    public Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword)
        => legacy.UpdatePasswordAsync(userId, new UpdatePasswordDto
        {
            OldPassword = oldPassword,
            NewPassword = newPassword,
            ConfirmPassword = confirmPassword
        });

    public async Task<(bool Success, object? Data)> RefreshTokenAsync(string refreshToken)
    {
        var result = await legacy.RefreshTokenAsync(refreshToken);
        return (result.Success, result.Data);
    }

    public Task<bool> RevokeRefreshTokenAsync(string refreshToken) => legacy.RevokeRefreshTokenAsync(refreshToken);

    public async Task<object> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status)
    {
        PageResult<UserListDto> result = await legacy.GetAdminUserListAsync(new UserQueryDto
        {
            Page = page,
            PageSize = pageSize,
            Keyword = keyword,
            Status = status
        });

        return result;
    }

    public Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason)
        => legacy.AdminChangeStatusAsync(new AdminChangeStatusDto { UserId = userId, Status = status, Reason = reason });

    public Task<(bool Success, string Message)> AdminResetPasswordAsync(int userId, string newPassword)
        => legacy.AdminResetPasswordAsync(new AdminResetPwdDto { UserId = userId, NewPassword = newPassword });
}
