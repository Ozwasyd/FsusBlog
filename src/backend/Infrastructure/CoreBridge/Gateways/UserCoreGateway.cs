using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class UserCoreGateway(UserService service) : IUserCoreGateway
{
    public async Task<AccountSnapshotContract?> GetByIdAsync(int id)
    {
        var user = await service.GetByIdAsync(id);
        return user is null ? null : ToAccountSnapshot(user);
    }

    public async Task<(bool Success, TokenPairContract? Data)> RefreshTokenAsync(string refreshToken)
    {
        var result = await service.RefreshTokenAsync(refreshToken);
        return result.Success && result.Data.HasValue
            ? (true, new TokenPairContract(result.Data.Value.AccessToken, result.Data.Value.RefreshToken))
            : (false, null);
    }

    public Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default) => service.RevokeRefreshTokenAsync(refreshToken, cancellationToken);

    public async Task<AdminUserPageContract> GetAdminUserListAsync(int page, int pageSize, string? keyword, int? status)
    {
        PageResult<AdminAccountListItemDto> result = await service.GetAdminUserListAsync(new UserQueryDto
        {
            Page = page,
            PageSize = pageSize,
            Keyword = keyword,
            Status = status
        });

        var items = new List<AdminAccountListItemContract>(result.Items.Count);
        for (int i = 0; i < result.Items.Count; i++)
        {
            var item = result.Items[i];
            items.Add(new AdminAccountListItemContract(
                item.AccountId,
                item.IdentityKind,
                item.PublicHandle,
                item.PasskeyInitialized,
                item.RecoveryInitialized,
                item.PrivacyInitializedAt,
                item.AnonymousCredentialStatus,
                item.AnonymousCredentialLevel,
                item.RiskFlags,
                item.Status,
                item.CreateTime,
                item.DeletedAt));
        }

        return new AdminUserPageContract
        {
            Total = result.Total,
            Items = items
        };
    }

    public Task<(bool Success, string Message)> AdminChangeStatusAsync(int userId, int status, string? reason)
        => service.AdminChangeStatusAsync(new AdminChangeStatusDto { AccountId = userId, Status = status, Reason = reason });

    private static AccountSnapshotContract ToAccountSnapshot(User user)
        => new(
            AccountId: user.Id,
            IdentityKind: user.IdentityKind,
            PublicHandle: user.PublicHandle,
            PasskeyEnabled: user.PasskeyEnabled,
            RecoveryEnabled: user.RecoveryEnabled,
            TotpStepUpEnabled: user.MfaEnabled,
            AnonymousCredentialStatus: user.AnonymousCredentialStatus,
            AnonymousCredentialLevel: user.AnonymousCredentialLevel,
            Status: user.Status,
            DeletedAt: user.DeletedAt);
}
