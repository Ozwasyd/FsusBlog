using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;

namespace FsusBlog.Server.Services;

public partial class UserService :
    IUserAccountReader,
    IUserRegistrationService,
    IUserLoginWorkflowService,
    IUserProfileCommandService,
    IUserSessionCommandService,
    IUserMfaCommandService,
    IUserAdminModerationService
{
    public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
    {
        User? user = await GetByIdAsync(id);
        return user is null ? null : ToAccountSnapshot(user);
    }

    public async Task<UserAccountSnapshot?> GetAccountByUsernameAsync(string username)
    {
        User? user = await GetByUsernameAsync(username);
        return user is null ? null : ToAccountSnapshot(user);
    }

    async Task<(bool Success, string Message, UserAccountSnapshot? User)> IUserLoginWorkflowService.ValidateCredentialsAsync(LoginDto dto, string clientIp)
    {
        var result = await ValidateCredentialsAsync(dto, clientIp);
        return (result.Success, result.Message, result.User is null ? null : ToAccountSnapshot(result.User));
    }

    async Task<(bool Success, string Message, TokenResponseDto? Data, UserAccountSnapshot? User)> IUserLoginWorkflowService.CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe)
    {
        User? user = await GetByIdAsync(userId);
        if (user is null)
        {
            return (false, "用户不存在", null, null);
        }

        var result = await CompleteLoginAsync(user, clientIp, deviceFingerprint, userAgent, mfaVerified, rememberMe);
        return (result.Success, result.Message, result.Data, result.UserEntity is null ? null : ToAccountSnapshot(result.UserEntity));
    }

    async Task<bool> IUserLoginWorkflowService.VerifyMfaOrRecoveryCodeAsync(
        int userId,
        string? code,
        string? recoveryCode,
        bool persistRecoveryConsumption)
    {
        User? user = await GetByIdAsync(userId);
        return user is not null && await VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption);
    }

    async Task<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)> IUserSessionCommandService.RefreshTokenWithExpiryAsync(
        string refreshToken,
        string? sessionId)
    {
        var result = await RefreshTokenAsync(refreshToken, sessionId);
        if (!result.Success || result.Data is null)
        {
            return (false, null, DateTime.UtcNow);
        }

        UserSession? session = await GetSessionByRefreshTokenAsync(result.Data.Value.RefreshToken);
        return (true, result.Data, session?.IdleExpiresAt ?? DateTime.UtcNow.AddDays(7));
    }

    private static UserAccountSnapshot ToAccountSnapshot(User user)
        => new(
            user.Id,
            user.Username,
            user.Role,
            user.Status,
            user.BanReason,
            user.MfaEnabled,
            user.DeletedAt,
            user.RefreshTokenExpiryTime);
}
