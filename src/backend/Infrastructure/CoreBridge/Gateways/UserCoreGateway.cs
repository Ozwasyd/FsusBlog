using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class UserCoreGateway(UserService service) : IUserCoreGateway
{
    public Task<(bool Success, string Message)> RegisterAsync(string username, string password, string confirmPassword)
        => service.RegisterAsync(new RegisterDto { Username = username, Password = password, ConfirmPassword = confirmPassword });

    public async Task<(bool Success, string Message, AuthLoginResultContract? Data)> LoginAsync(string username, string password, string clientIp)
    {
        var result = await service.LoginAsync(new LoginDto { Username = username, Password = password, RememberMe = false }, clientIp);
        if (!result.Success || result.Data is null || result.UserEntity is null)
        {
            return (false, result.Message, null);
        }

        return (true, result.Message, new AuthLoginResultContract(
            new TokenPairContract(result.Data.Value.AccessToken, result.Data.Value.RefreshToken),
            ToUserSnapshot(result.UserEntity)));
    }

    public async Task<UserSnapshotContract?> GetByIdAsync(int id)
    {
        var user = await service.GetByIdAsync(id);
        return user is null ? null : ToUserSnapshot(user);
    }

    public async Task<UserSnapshotContract?> GetByUsernameAsync(string username)
    {
        var user = await service.GetByUsernameAsync(username);
        return user is null ? null : ToUserSnapshot(user);
    }

    public async Task<(bool Success, string Message, TokenPairContract? Data)> UpdateUsernameAsync(int userId, string newUsername)
    {
        var result = await service.UpdateUsernameAsync(userId, newUsername);
        return result.Success && result.Data.HasValue
            ? (true, result.Message, new TokenPairContract(result.Data.Value.AccessToken, result.Data.Value.RefreshToken))
            : (false, result.Message, null);
    }

    public Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword)
        => service.UpdatePasswordAsync(userId, new UpdatePasswordDto
        {
            OldPassword = oldPassword,
            NewPassword = newPassword,
            ConfirmPassword = confirmPassword
        });

    public async Task<(bool Success, TokenPairContract? Data)> RefreshTokenAsync(string refreshToken)
    {
        var result = await service.RefreshTokenAsync(refreshToken);
        return result.Success && result.Data.HasValue
            ? (true, new TokenPairContract(result.Data.Value.AccessToken, result.Data.Value.RefreshToken))
            : (false, null);
    }

    public Task<bool> RevokeRefreshTokenAsync(string refreshToken) => service.RevokeRefreshTokenAsync(refreshToken);

    public async Task<AdminUserPageContract> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status)
    {
        PageResult<UserListDto> result = await service.GetAdminUserListAsync(new UserQueryDto
        {
            Page = page,
            PageSize = pageSize,
            Keyword = keyword,
            Status = status
        });

        var items = new List<UserListItemContract>(result.Items.Count);
        for (int i = 0; i < result.Items.Count; i++)
        {
            var item = result.Items[i];
            items.Add(new UserListItemContract(
                item.Id,
                item.Username,
                item.Role,
                item.Status,
                item.CreateTime,
                item.LastLoginIp,
                item.LastLoginTime,
                item.DeletedAt));
        }

        return new AdminUserPageContract
        {
            Total = result.Total,
            Items = items
        };
    }

    public Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason)
        => service.AdminChangeStatusAsync(new AdminChangeStatusDto { UserId = userId, Status = status, Reason = reason });

    public Task<(bool Success, string Message)> AdminResetPasswordAsync(int userId, string newPassword)
        => service.AdminResetPasswordAsync(new AdminResetPwdDto { UserId = userId, NewPassword = newPassword });

    private static UserSnapshotContract ToUserSnapshot(User user)
        => new(
            user.Id,
            user.Username,
            user.Role,
            user.Status,
            user.CreateTime,
            user.LastLoginIp,
            user.LastLoginTime,
            user.DeletedAt);
}
