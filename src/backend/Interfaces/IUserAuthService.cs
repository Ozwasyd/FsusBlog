using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IUserAuthService
{
    Task<(bool Success, string Message)> RegisterAsync(RegisterDto dto);
    Task<(bool Success, string Message, User? User)> ValidateCredentialsAsync(LoginDto dto, string clientIp);
    Task<User?> GetByIdAsync(int id);
    Task<User?> GetByUsernameAsync(string username);
    Task<(bool Success, string Message, TokenResponseDto? Data)> UpdateUsernameAsync(int userId, string newUsername);
    Task<(bool Success, string Message)> UpdatePasswordAsync(int userId, UpdatePasswordDto dto);
    Task<(bool Success, string Message, TokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync(
        User user,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe);
    Task<(bool Success, string Message)> DeleteAccountAsync(int userId, DeleteAccountRequestDto dto);
    Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(int userId, string? currentSessionId);
    Task<bool> RevokeSessionAsync(int userId, string sessionId, string reason = "manual_revoke");
    Task<int> RevokeOtherSessionsAsync(int userId, string? currentSessionId);
    Task<(bool Success, MfaSetupStartDto? Data, string Message)> StartMfaSetupAsync(int userId, string issuer);
    Task<MfaProfileDto?> GetMfaProfileAsync(int userId);
    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code);
    Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode);
    Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode);
    Task<bool> VerifyMfaOrRecoveryCodeAsync(User user, string? code, string? recoveryCode, bool persistRecoveryConsumption);
    Task<RiskEvaluationResult> EvaluateLoginRiskAsync(int userId, string clientIp, string? deviceFingerprint, string? userAgent);
    Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(string refreshToken, string? sessionId);
    Task<UserSession?> GetSessionByRefreshTokenAsync(string refreshToken);
    Task<bool> RevokeRefreshTokenAsync(string refreshToken);
}