using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Abstractions;

public interface IUserCoreService
{
    Task<Result> RegisterAsync(string username, string password, string confirmPassword);
    Task<Result<AuthLoginResultContract>> LoginAsync(string username, string password, string clientIp);
    Task<Result<UserSnapshotContract?>> GetByIdAsync(int id);
    Task<Result<UserSnapshotContract?>> GetByUsernameAsync(string username);
    Task<Result> UpdatePasswordAsync(int userId, string oldPassword, string newPassword, string confirmPassword);
    Task<Result<TokenPairContract>> RefreshTokenAsync(string refreshToken);
    Task<Result> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);
    Task<Result<AdminUserPageContract>> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<Result> AdminChangeStatusAsync(int userId, int status, string? reason);
}
