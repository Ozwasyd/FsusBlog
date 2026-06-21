using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Gateways;

public interface IUserCoreGateway
{
    Task<UserSnapshotContract?> GetByIdAsync(int id);
    Task<(bool Success, TokenPairContract? Data)> RefreshTokenAsync(string refreshToken);
    Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);
    Task<AdminUserPageContract> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason);
}
