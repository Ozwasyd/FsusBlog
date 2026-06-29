using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public readonly record struct UserAccountSnapshot(
    int Id,
    int Status,
    string? BanReason,
    bool MfaEnabled,
    DateTime? DeletedAt,
    string? PublicHandle = null,
    string IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
    bool PasskeyEnabled = false,
    bool RecoveryEnabled = false,
    string? AnonymousCredentialStatus = null,
    string? AnonymousCredentialLevel = null,
    string? AccountSubjectHash = null);

public readonly record struct SessionTokenResponseDto(
    string AccessToken,
    string RefreshToken,
    string SessionId,
    DateTime RefreshTokenExpiresAt);

public interface IUserAccountReader
{
    Task<UserAccountSnapshot?> GetAccountByIdAsync(int id);
}

public interface IAnonymousAccountBootstrapService
{
    Task<(bool Success, string Message, UserAccountSnapshot? User)> BootstrapAsync(
        string? publicHandle,
        CancellationToken cancellationToken = default);
}

public interface IUserLoginWorkflowService
{
    Task<(bool Success, string Message, SessionTokenResponseDto? Data, UserAccountSnapshot? User)> CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe,
        CancellationToken cancellationToken = default);

    Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent, CancellationToken cancellationToken = default);

    Task<bool> VerifyMfaOrRecoveryCodeAsync(int userId, string? code, string? recoveryCode, bool persistRecoveryConsumption, CancellationToken cancellationToken = default);
}

public interface IUserProfileCommandService
{
    Task<(bool Success, string Message)> UpdatePublicHandleAsync(int userId, string? publicHandle, CancellationToken cancellationToken = default);

    Task<(bool Success, string Message)> DeleteAccountAsync(int userId, DeleteAccountRequestDto dto, CancellationToken cancellationToken = default);
}

public interface IUserSessionCommandService
{
    Task<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)> RefreshTokenWithExpiryAsync(string refreshToken, string? sessionId, CancellationToken cancellationToken = default);

    Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId, CancellationToken cancellationToken = default);

    Task<UserSession?> GetSessionByRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);

    Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(int userId, string? currentSessionId, CancellationToken cancellationToken = default);

    Task<bool> RevokeSessionAsync(int userId, string sessionId, string reason = "manual_revoke", CancellationToken cancellationToken = default);

    Task<int> RevokeOtherSessionsAsync(int userId, string? currentSessionId, CancellationToken cancellationToken = default);

    Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default);
}

public interface IUserMfaCommandService
{
    Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(
        int userId,
        string issuer,
        string? password = null,
        string? code = null,
        string? recoveryCode = null,
        bool stepUpVerified = false);

    Task<MfaProfileDto?> GetMfaProfileAsync(int userId);

    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code);

    Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode, bool stepUpVerified = false);

    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode,
        bool stepUpVerified = false);
}

public interface IUserAdminModerationService
{
    Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync(UserQueryDto dto);

    Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto);
}
