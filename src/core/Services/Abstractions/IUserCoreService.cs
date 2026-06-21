using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Core.Services.Abstractions;

public interface IUserCoreService
{
    Task<Result<UserSnapshotContract?>> GetByIdAsync(int id);
    Task<Result<TokenPairContract>> RefreshTokenAsync(string refreshToken);
    Task<Result> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);
    Task<Result<AdminUserPageContract>> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status);
    Task<Result> AdminChangeStatusAsync(int userId, int status, string? reason);
}
