using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Shared.Contracts.AuthSystem;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class UserServiceCoreAdapter(IUserCoreService core) : IUserService
{
    public async Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto)
    {
        var result = await core.RegisterAsync(dto.Username, dto.Password, dto.ConfirmPassword);
        return result.IsSuccess ? (true, "注册成功") : (false, result.Error.Message);
    }

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> LoginAsync(LoginDto dto, string clientIp)
    {
        var result = await core.LoginAsync(dto.Username, dto.Password, clientIp);
        if (!result.IsSuccess)
        {
            return (false, result.Error.Message, null, null);
        }

        var token = new SessionTokenResponseDto(
            result.Value.Token.AccessToken,
            result.Value.Token.RefreshToken,
            DateTime.UtcNow.AddDays(7));
        return (true, "登录成功", token, ToUserEntity(result.Value.User));
    }

    public async Task<User?> GetByIdAsync(int id)
    {
        var result = await core.GetByIdAsync(id);
        return result.IsSuccess && result.Value.HasValue
            ? ToUserEntity(result.Value.Value)
            : null;
    }

    public async Task<User?> GetByUsernameAsync(string username)
    {
        var result = await core.GetByUsernameAsync(username);
        return result.IsSuccess && result.Value.HasValue
            ? ToUserEntity(result.Value.Value)
            : null;
    }

    public async Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto)
    {
        var result = await core.UpdatePasswordAsync(userId, dto.OldPassword, dto.NewPassword, dto.ConfirmPassword);
        return result.IsSuccess ? (true, "密码更新成功") : (false, result.Error.Message);
    }

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken)
    {
        var result = await core.RefreshTokenAsync(refreshToken);
        return result.IsSuccess
            ? (true, new TokenResponseDto(result.Value.AccessToken, result.Value.RefreshToken))
            : (false, null);
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
        => (await core.RevokeRefreshTokenAsync(refreshToken, cancellationToken)).IsSuccess;

    public async Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync(UserQueryDto dto)
    {
        var result = await core.GetAdminUserListAsync(dto.Page, dto.PageSize, dto.Keyword, dto.Status);
        if (!result.IsSuccess)
        {
            return new PageResult<AdminAccountListItemDto> { Total = 0, Items = [] };
        }

        var page = result.Value;
        if (page is null)
        {
            return new PageResult<AdminAccountListItemDto> { Total = 0, Items = [] };
        }

        var items = new List<AdminAccountListItemDto>(page.Items.Count);
        for (int i = 0; i < page.Items.Count; i++)
        {
            var item = page.Items[i];
            items.Add(new AdminAccountListItemDto(
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

        return new PageResult<AdminAccountListItemDto> { Total = page.Total, Items = items };
    }

    public async Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
    {
        var result = await core.AdminChangeStatusAsync(dto.UserId, dto.Status, dto.Reason);
        return result.IsSuccess ? (true, "状态更新成功") : (false, result.Error.Message);
    }

    private static User ToUserEntity(UserSnapshotContract snapshot)
        => new()
        {
            Id = snapshot.Id,
            Username = snapshot.Username,
            Role = snapshot.Role,
            Status = snapshot.Status,
            CreateTime = snapshot.CreateTime,
            LastLoginIp = snapshot.LastLoginIp,
            LastLoginTime = snapshot.LastLoginTime,
            DeletedAt = snapshot.DeletedAt
        };
}
