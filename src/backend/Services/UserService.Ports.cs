using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class UserAccountReader(UserService users) : IUserAccountReader
{
    public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
    {
        User? user = await users.GetByIdAsync(id);
        return user is null ? null : ToAccountSnapshot(user);
    }

    public async Task<UserAccountSnapshot?> GetAccountByUsernameAsync(string username)
    {
        User? user = await users.GetByUsernameAsync(username);
        return user is null ? null : ToAccountSnapshot(user);
    }

    internal static UserAccountSnapshot ToAccountSnapshot(User user)
        => new(
            user.Id,
            user.Username,
            user.Role,
            user.Status,
            user.BanReason,
            user.MfaEnabled,
            user.DeletedAt,
            user.PublicHandle,
            user.IdentityKind,
            user.PasskeyEnabled,
            user.RecoveryEnabled);
}

public sealed class UserRegistrationService(UserService users) : IUserRegistrationService
{
    public Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RegisterAsync(dto);
    }
}

public sealed class UserLoginWorkflowService(UserService users) : IUserLoginWorkflowService
{
    public async Task<(bool Success, string Message, UserAccountSnapshot? User)> ValidateCredentialsAsync(LoginDto dto, string clientIp, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await users.ValidateCredentialsAsync(dto, clientIp);
        return (result.Success, result.Message, result.User is null ? null : UserAccountReader.ToAccountSnapshot(result.User));
    }

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, UserAccountSnapshot? User)> CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await users.GetByIdAsync(userId);
        if (user is null)
        {
            return (false, "用户不存在", null, null);
        }

        var result = await users.CompleteLoginAsync(user, clientIp, deviceFingerprint, userAgent, mfaVerified, rememberMe);
        return (result.Success, result.Message, result.Data, result.UserEntity is null ? null : UserAccountReader.ToAccountSnapshot(result.UserEntity));
    }

    public Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.EvaluateLoginRiskAsync(userId, clientIp, deviceFingerprint, userAgent);
    }

    public async Task<bool> VerifyMfaOrRecoveryCodeAsync(
        int userId,
        string? code,
        string? recoveryCode,
        bool persistRecoveryConsumption,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await users.GetByIdAsync(userId);
        return user is not null && await users.VerifyMfaOrRecoveryCodeAsync(user, code, recoveryCode, persistRecoveryConsumption);
    }
}

public sealed class UserProfileCommandService(UserService users) : IUserProfileCommandService
{
    public Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.UpdateUsernameAsync(userId, newUsername);
    }

    public Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.UpdatePasswordAsync(userId, dto);
    }

    public Task<(bool Success, string Message)> DeleteAccountAsync(int userId, DeleteAccountRequestDto dto, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.DeleteAccountAsync(userId, dto);
    }
}

public sealed class UserSessionCommandService(UserService users) : IUserSessionCommandService
{
    public async Task<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)> RefreshTokenWithExpiryAsync(
        string refreshToken,
        string? sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await users.RefreshTokenAsync(refreshToken, sessionId);
        if (!result.Success || result.Data is null)
        {
            return (false, null, DateTime.UtcNow);
        }

        cancellationToken.ThrowIfCancellationRequested();
        UserSession? session = await users.GetSessionByRefreshTokenAsync(result.Data.Value.RefreshToken);
        return (true, result.Data, session?.IdleExpiresAt ?? DateTime.UtcNow.AddDays(7));
    }

    public Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RefreshTokenAsync(refreshToken, sessionId);
    }

    public Task<UserSession?> GetSessionByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.GetSessionByRefreshTokenAsync(refreshToken);
    }

    public Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(int userId, string? currentSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.GetUserSessionsAsync(userId, currentSessionId);
    }

    public Task<bool> RevokeSessionAsync(int userId, string sessionId, string reason = "manual_revoke", CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RevokeSessionAsync(userId, sessionId, reason);
    }

    public Task<int> RevokeOtherSessionsAsync(int userId, string? currentSessionId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RevokeOtherSessionsAsync(userId, currentSessionId);
    }

    public Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RevokeRefreshTokenAsync(refreshToken, cancellationToken);
    }
}

public sealed class UserMfaCommandService(UserService users) : IUserMfaCommandService
{
    public Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(
        int userId,
        string issuer,
        string? password = null,
        string? code = null,
        string? recoveryCode = null)
        => users.StartMfaSetupAsync(userId, issuer, password, code, recoveryCode);

    public Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
        => users.GetMfaProfileAsync(userId);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
        => users.VerifyMfaSetupAsync(userId, code);

    public Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode)
        => users.DisableMfaAsync(userId, password, code, recoveryCode);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode)
        => users.RegenerateMfaRecoveryCodesAsync(userId, password, code, recoveryCode);
}

public sealed class UserAdminModerationService(UserService users) : IUserAdminModerationService
{
    public Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto)
        => users.GetAdminUserListAsync(dto);

    public Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
        => users.AdminChangeStatusAsync(dto);

    public Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto)
        => users.AdminResetPasswordAsync(dto);
}
