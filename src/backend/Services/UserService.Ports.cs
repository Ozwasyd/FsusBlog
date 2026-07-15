using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Shared.Contracts.Outputs;
using System.Globalization;
using System.Text.Json;

namespace FsusBlog.Server.Services;

public sealed class UserAccountReader(UserService users, IUnifiedCache cache) : IUserAccountReader
{
    private static readonly JsonSerializerOptions SnapshotJsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
    {
        long version = await GetSnapshotVersionAsync(id).ConfigureAwait(false);
        string identity = BuildSnapshotIdentity(id, version);
        CacheReadResult<AccountSnapshotCacheEnvelope> cached = await cache.TryGetAsync(
                CachePolicyId.AccountSnapshot,
                identity,
                static payload => DecodeSnapshotEnvelope(payload),
                CancellationToken.None)
            .ConfigureAwait(false);
        if (cached.Hit
            && cached.Value is { } envelope
            && envelope.Version == version
            && AccountSubjectHashRequirement.TryResolve(
                envelope.Snapshot.AccountSubjectHash,
                out _))
        {
            FsusObservability.RecordAccountSnapshotCacheHit(hit: true);
            return envelope.Snapshot;
        }

        FsusObservability.RecordAccountSnapshotCacheHit(hit: false);
        FsusObservability.RecordAccountSnapshotDbReadCount();
        UserAccountSnapshot? snapshot = await users.GetAccountSnapshotProjectionAsync(id).ConfigureAwait(false);
        if (snapshot.HasValue
            && AccountSubjectHashRequirement.TryResolve(snapshot.Value.AccountSubjectHash, out _))
        {
            byte[] payload = JsonSerializer.SerializeToUtf8Bytes(
                new AccountSnapshotCacheEnvelope(version, snapshot.Value),
                SnapshotJsonOptions);
            await cache.SetRawAsync(CachePolicyId.AccountSnapshot, identity, payload).ConfigureAwait(false);
        }
        else
        {
            await cache.RemoveAsync(CachePolicyId.AccountSnapshot, identity).ConfigureAwait(false);
        }

        return snapshot;
    }

    private async Task<long> GetSnapshotVersionAsync(int id)
    {
        string? value = await cache.GetStringAsync(
                CachePolicyId.AccountSnapshotVersion,
                id.ToString(CultureInfo.InvariantCulture))
            .ConfigureAwait(false);
        return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out long version) && version > 0
            ? version
            : 0;
    }

    private static string BuildSnapshotIdentity(int id, long version)
        => string.Concat(
            "account:subject-v1:",
            id.ToString(CultureInfo.InvariantCulture),
            ":v",
            version.ToString(CultureInfo.InvariantCulture));

    private static (bool Success, AccountSnapshotCacheEnvelope? Value) DecodeSnapshotEnvelope(ReadOnlyMemory<byte> payload)
    {
        try
        {
            AccountSnapshotCacheEnvelope? envelope = JsonSerializer.Deserialize<AccountSnapshotCacheEnvelope>(payload.Span, SnapshotJsonOptions);
            return envelope is null ? (false, null) : (true, envelope);
        }
        catch (JsonException)
        {
            return (false, null);
        }
    }

    private sealed record AccountSnapshotCacheEnvelope(long Version, UserAccountSnapshot Snapshot);

    internal static UserAccountSnapshot ToAccountSnapshot(User user)
        => new(
            user.Id,
            user.Status,
            user.BanReason,
            user.MfaEnabled,
            user.DeletedAt,
            user.PublicHandle,
            user.IdentityKind,
            user.PasskeyEnabled,
            user.RecoveryEnabled,
            user.AnonymousCredentialStatus,
            user.AnonymousCredentialLevel,
            user.AccountSubjectHash);

    internal static IdentityAccountSnapshotCoreModel ToAnonymousAccountSnapshot(UserAccountSnapshot account)
        => new(
            AccountId: account.Id,
            PublicHandle: string.IsNullOrWhiteSpace(account.PublicHandle) ? null : account.PublicHandle,
            PasskeyEnabled: account.PasskeyEnabled,
            RecoveryEnabled: account.RecoveryEnabled,
            TotpStepUpEnabled: account.MfaEnabled,
            AnonymousCredentialStatus: string.IsNullOrWhiteSpace(account.AnonymousCredentialStatus) ? null : account.AnonymousCredentialStatus,
            AnonymousCredentialLevel: string.IsNullOrWhiteSpace(account.AnonymousCredentialLevel) ? null : account.AnonymousCredentialLevel,
            IdentityKind: string.IsNullOrWhiteSpace(account.IdentityKind) ? AnonymousIdentityRuntime.AnonymousAccountKind : account.IdentityKind,
            Status: account.Status,
            BanReason: string.IsNullOrWhiteSpace(account.BanReason) ? null : account.BanReason,
            DeletedAt: account.DeletedAt);

}

public sealed class AnonymousAccountBootstrapService(UserService users) : IAnonymousAccountBootstrapService
{
    public async Task<(bool Success, string Message, UserAccountSnapshot? User)> BootstrapAsync(
        string? publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await users.BootstrapAnonymousAccountAsync(publicHandle);
        return (result.Success, result.Message, result.User is null ? null : UserAccountReader.ToAccountSnapshot(result.User));
    }
}

public sealed class UserLoginWorkflowService(UserService users) : IUserLoginWorkflowService
{
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
    public Task<(bool Success, string Message)> UpdatePublicHandleAsync(int userId, string? publicHandle, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.UpdatePublicHandleAsync(userId, publicHandle);
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

        DateTime expiresAt = result.Data.Value.RefreshTokenExpiresAt ?? DateTime.UtcNow.AddDays(7);
        return (true, result.Data, expiresAt);
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

    public Task<int> RevokeAllSessionsAsync(int userId, string reason, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return users.RevokeAllSessionsAsync(userId, reason, cancellationToken);
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
        string? recoveryCode = null,
        bool stepUpVerified = false)
        => users.StartMfaSetupAsync(userId, issuer, password, code, recoveryCode, stepUpVerified);

    public Task<MfaProfileDto?> GetMfaProfileAsync(int userId)
        => users.GetMfaProfileAsync(userId);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> VerifyMfaSetupAsync(int userId, string code)
        => users.VerifyMfaSetupAsync(userId, code);

    public Task<(bool Success, string Message)> DisableMfaAsync(int userId, string password, string? code, string? recoveryCode, bool stepUpVerified = false)
        => users.DisableMfaAsync(userId, password, code, recoveryCode, stepUpVerified);

    public Task<(bool Success, MfaSetupVerifyDto? Data, string Message)> RegenerateMfaRecoveryCodesAsync(
        int userId,
        string password,
        string? code,
        string? recoveryCode,
        bool stepUpVerified = false)
        => users.RegenerateMfaRecoveryCodesAsync(userId, password, code, recoveryCode, stepUpVerified);
}

public sealed class UserAdminModerationService(UserService users) : IUserAdminModerationService
{
    public Task<PageResult<AdminAccountListItemDto>> GetAdminUserListAsync(UserQueryDto dto)
        => users.GetAdminUserListAsync(dto);

    public Task<(bool Success, string Message)> AdminChangeStatusAsync(AdminChangeStatusDto dto)
        => users.AdminChangeStatusAsync(dto);
}
