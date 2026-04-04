using FsusBlog.Core.Common;

namespace FsusBlog.Core.Services.Abstractions;

public interface IUserCoreService
{
    Task<Result> RegisterAsync(string username, string password, string confirmPassword);
    Task<Result<object>> LoginAsync(string username, string password, string clientIp);
    Task<Result<object?>> GetByIdAsync(int id);
    Task<Result<object?>> GetByUsernameAsync(string username);
    Task<Result<object>> UpdateUsernameAsync(int userId, string newUsername);
    Task<Result> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword);
    Task<Result<object>> RefreshTokenAsync(string refreshToken);
    Task<Result> RevokeRefreshTokenAsync(string refreshToken);
    Task<Result<object>> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<Result> AdminChangeStatusAsync(int userId, int status, string? reason);
    Task<Result> AdminResetPasswordAsync(int userId, string newPassword);
}
