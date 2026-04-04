namespace FsusBlog.Core.Services.Gateways;

public interface ILegacyUserGateway
{
    Task<(bool Success, string Message)> RegisterAsync(string username, string password, string confirmPassword);
    Task<(bool Success, string Message, object? Data, object? UserEntity)> LoginAsync(string username, string password, string clientIp);
    Task<object?> GetByIdAsync(int id);
    Task<object?> GetByUsernameAsync(string username);
    Task<(bool Success, string Message, object? Data)> UpdateUsernameAsync(int userId, string newUsername);
    Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword);
    Task<(bool Success, object? Data)> RefreshTokenAsync(string refreshToken);
    Task<bool> RevokeRefreshTokenAsync(string refreshToken);
    Task<object> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason);
    Task<(bool Success, string Message)> AdminResetPasswordAsync(int userId, string newPassword);
}
