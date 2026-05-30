using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct UserAccountSnapshot(
    int Id,
    string Username,
    string Role,
    int Status,
    string? BanReason,
    bool MfaEnabled,
    DateTime? DeletedAt,
    DateTime? RefreshTokenExpiryTime);

public interface IUserAccountReader
{
    Task<UserAccountSnapshot?> GetAccountByIdAsync(int id);

    Task<UserAccountSnapshot?> GetAccountByUsernameAsync(string username);
}

public interface IUserRegistrationService
{
    Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto);
}

public interface IUserLoginWorkflowService
{
    Task<(bool Success, string Message, UserAccountSnapshot? User)> ValidateCredentialsAsync(LoginDto dto, string clientIp);

    Task<(bool Success, string Message, TokenResponseDto? Data, UserAccountSnapshot? User)> CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe);

    Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent);

    Task<bool> VerifyMfaOrRecoveryCodeAsync(int userId, string? code, string? recoveryCode, bool persistRecoveryConsumption);
}

public interface IUserProfileCommandService
{
    Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername);

    Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto);

    Task<(bool Success, string Message)> DeleteAccountAsync(int userId, DeleteAccountRequestDto dto);
}

public interface IUserSessionCommandService
{
    Task<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)> RefreshTokenWithExpiryAsync(string refreshToken, string? sessionId);

    Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId);

    Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(int userId, string? currentSessionId);

    Task<bool> RevokeSessionAsync(int userId, string sessionId, string reason = "manual_revoke");

    Task<int> RevokeOtherSessionsAsync(int userId, string? currentSessionId);

    Task<bool> RevokeRefreshTokenAsync(string refreshToken);
}

public interface IUserMfaCommandService
{
    Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(int userId, string issuer);

    Task<MfaProfileDto?> GetMfaProfileAsync(int userId);

    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code);

    Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode);

    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode);
}

public interface IUserAdminModerationService
{
    Task<PageResult<UserListDto>> GetAdminUserListAsync(UserQueryDto dto);

    Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto);

    Task<(bool Success, string Message)> AdminResetPasswordAsync(AdminResetPwdDto dto);
}
