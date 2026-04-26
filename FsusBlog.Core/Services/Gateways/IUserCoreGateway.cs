using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Gateways;

public interface IUserCoreGateway
{
    Task<(bool Success, string Message)> RegisterAsync(string username, string password, string confirmPassword);
    Task<(bool Success, string Message, AuthLoginResultContract? Data)> LoginAsync(string username, string password, string clientIp);
    Task<UserSnapshotContract?> GetByIdAsync(int id);
    Task<UserSnapshotContract?> GetByUsernameAsync(string username);
    Task<(bool Success, string Message, TokenPairContract? Data)> UpdateUsernameAsync(int userId, string newUsername);
    Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword);
    Task<(bool Success, TokenPairContract? Data)> RefreshTokenAsync(string refreshToken);
    Task<bool> RevokeRefreshTokenAsync(string refreshToken);
    Task<AdminUserPageContract> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason);
    Task<(bool Success, string Message)> AdminResetPasswordAsync(int userId, string newPassword);
}
