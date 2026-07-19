using System.Buffers;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAccountEnrollmentService
{
    Task<(bool Success, ErrorDetail Error, PasskeyRegBeginData? Data)> BeginPasskeyRegistrationAsync(string? token, CancellationToken cancellationToken = default);
    Task<AuthBinaryFlowResult> CompletePasskeyRegistrationAsync(string? token, PasskeyRegisterCompleteCoreModel request, AuthBinaryClientContext client, CancellationToken cancellationToken = default);
    Task<AuthBinaryFlowResult> GetStatusAsync(string? token, CancellationToken cancellationToken = default);
    Task<(bool Success, ErrorDetail Error)> CancelAsync(string? token, CancellationToken cancellationToken = default);
    Task<int> CleanupExpiredAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Owns the provisional-account state machine. The only transition that creates a
/// formal session is the transaction that also persists the first credential.
/// </summary>
public sealed class AccountEnrollmentService(
    ISqlSugarClient db,
    IPasskeyService passkeys,
    IJwtHelper jwt,
    ICacheCounterStore counters,
    ICacheInvalidationStore invalidation,
    IDataProtectionProvider dataProtection,
    ILogger<AccountEnrollmentService> logger) : IAccountEnrollmentService
{
    private static readonly TimeSpan s_completionLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan s_completedReceiptRetention = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan s_sessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan s_sessionAbsoluteTtl = TimeSpan.FromDays(30);
    private readonly IDataProtector _refreshProtector = dataProtection.CreateProtector("FsusBlog.AccountEnrollment.RefreshToken.v1");

    public async Task<(bool Success, ErrorDetail Error, PasskeyRegBeginData? Data)> BeginPasskeyRegistrationAsync(
        string? token,
        CancellationToken cancellationToken = default)
    {
        AccountEnrollmentSession? enrollment = await LoadPendingAsync(token, cancellationToken);
        if (enrollment is null)
        {
            return (false, ErrorDetail.Create(ErrorCode.Unauthorized, "注册会话不存在、已结束或已过期"), null);
        }

        byte[] handle;
        try
        {
            handle = Convert.FromHexString(enrollment.PasskeyUserHandle);
        }
        catch (FormatException)
        {
            return (false, ErrorDetail.Create(ErrorCode.InfraFailure, "注册会话中的通行密钥句柄无效"), null);
        }

        var begin = await passkeys.BeginEnrollmentRegistrationAsync(enrollment.AccountId, handle, cancellationToken);
        if (!begin.Success || begin.Data is null)
        {
            return (false, ErrorDetail.Create(ErrorCode.Conflict, begin.Message), null);
        }

        string? previousChallenge = enrollment.RegistrationChallengeKey;
        int updated = await db.Updateable<AccountEnrollmentSession>()
            .Where(item => item.TokenHash == enrollment.TokenHash &&
                           item.State == AccountEnrollmentStates.Pending &&
                           item.ExpiresAt > DateTime.UtcNow)
            .SetColumns(item => item.RegistrationChallengeKey == begin.Data.Options.SessionKey)
            .ExecuteCommandAsync();
        if (updated != 1)
        {
            await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, begin.Data.Options.SessionKey, cancellationToken);
            return (false, ErrorDetail.Create(ErrorCode.Conflict, "注册会话状态已变化"), null);
        }

        if (!string.IsNullOrWhiteSpace(previousChallenge) &&
            !string.Equals(previousChallenge, begin.Data.Options.SessionKey, StringComparison.Ordinal))
        {
            await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, previousChallenge, cancellationToken);
        }

        return (true, ErrorDetail.None, begin.Data);
    }

    public async Task<AuthBinaryFlowResult> CompletePasskeyRegistrationAsync(
        string? token,
        PasskeyRegisterCompleteCoreModel request,
        AuthBinaryClientContext client,
        CancellationToken cancellationToken = default)
    {
        if (!TryHashToken(token, out string tokenHash))
        {
            return Fail(ErrorCode.Unauthorized, "注册会话不存在");
        }

        string requestHash = HashRequest(request);
        AccountEnrollmentSession? current = await db.Queryable<AccountEnrollmentSession>()
            .Where(item => item.TokenHash == tokenHash)
            .FirstAsync();
        if (current is null)
        {
            return Fail(ErrorCode.Unauthorized, "注册会话不存在");
        }

        if (string.Equals(current.State, AccountEnrollmentStates.Completed, StringComparison.Ordinal))
        {
            return await ReplayCompletedAsync(current, requestHash, cancellationToken);
        }

        DateTime now = DateTime.UtcNow;
        if (current.ExpiresAt <= now ||
            !string.Equals(current.RegistrationChallengeKey, request.SessionKey, StringComparison.Ordinal))
        {
            return Fail(ErrorCode.Conflict, current.ExpiresAt <= now ? "注册会话已过期" : "注册 challenge 已失效");
        }

        int claimed = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE account_enrollment_session
            SET state = @Completing,
                completion_request_hash = @RequestHash,
                completion_lease_until = @LeaseUntil
            WHERE token_hash = @TokenHash
              AND expires_at > @Now
              AND registration_challenge_key = @ChallengeKey
              AND (
                    state = @Pending
                    OR (
                        state = @Completing
                        AND completion_request_hash = @RequestHash
                        AND completion_lease_until <= @Now
                    )
                  );
            """,
            new SugarParameter("@Completing", AccountEnrollmentStates.Completing),
            new SugarParameter("@Pending", AccountEnrollmentStates.Pending),
            new SugarParameter("@RequestHash", requestHash),
            new SugarParameter("@LeaseUntil", now.Add(s_completionLease)),
            new SugarParameter("@TokenHash", tokenHash),
            new SugarParameter("@Now", now),
            new SugarParameter("@ChallengeKey", request.SessionKey));
        if (claimed != 1)
        {
            AccountEnrollmentSession? raced = await db.Queryable<AccountEnrollmentSession>()
                .Where(item => item.TokenHash == tokenHash)
                .FirstAsync();
            return raced is not null && string.Equals(raced.State, AccountEnrollmentStates.Completed, StringComparison.Ordinal)
                ? await ReplayCompletedAsync(raced, requestHash, cancellationToken)
                : Fail(ErrorCode.Conflict, "首枚通行密钥注册正在完成或已由另一请求占用");
        }

        PasskeyRegistrationValidationResult validation = await passkeys.ValidateEnrollmentRegistrationAsync(
            current.AccountId,
            request,
            cancellationToken);
        if (!validation.Success || validation.Credential is null)
        {
            await ReleaseFailedClaimAsync(tokenHash, requestHash, cancellationToken);
            await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, request.SessionKey, cancellationToken);
            return Fail(ErrorCode.Validation, validation.Message);
        }

        string refreshToken = jwt.GenerateRefreshToken();
        string sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        string protectedRefreshToken = _refreshProtector.Protect(refreshToken);
        DateTime idleExpiresAt = now.Add(s_sessionIdleTtl);
        DateTime absoluteExpiresAt = now.Add(s_sessionAbsoluteTtl);
        IssuedAccessToken accessToken = default;
        User? activatedUser = null;

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            AccountEnrollmentSession? lockedEnrollment = await LockEnrollmentAsync(tokenHash, cancellationToken);
            if (lockedEnrollment is null ||
                !string.Equals(lockedEnrollment.State, AccountEnrollmentStates.Completing, StringComparison.Ordinal) ||
                !string.Equals(lockedEnrollment.CompletionRequestHash, requestHash, StringComparison.Ordinal) ||
                lockedEnrollment.ExpiresAt <= DateTime.UtcNow)
            {
                throw new InvalidOperationException("enrollment_completion_claim_lost");
            }

            activatedUser = await LockProvisionalUserAsync(lockedEnrollment.AccountId, cancellationToken)
                ?? throw new InvalidOperationException("provisional_account_unavailable");
            if (await db.Queryable<PasskeyCredential>().Where(item => item.AccountId == activatedUser.Id).AnyAsync())
            {
                throw new InvalidOperationException("provisional_account_already_has_passkey");
            }

            validation.Credential.AccountId = activatedUser.Id;
            await db.Insertable(validation.Credential).ExecuteCommandAsync();

            string stableHandle = WebEncoders.Base64UrlEncode(Convert.FromHexString(lockedEnrollment.PasskeyUserHandle));
            int activated = await db.Updateable<User>()
                .Where(item => item.Id == activatedUser.Id &&
                               item.RegistrationState == AccountRegistrationStates.Provisional &&
                               item.Status != 2 && item.DeletedAt == null)
                .SetColumns(item => item.RegistrationState == AccountRegistrationStates.Active)
                .SetColumns(item => item.PasskeyEnabled == true)
                .SetColumns(item => item.PasskeyUserHandle == stableHandle)
                .SetColumns(item => item.PasskeySignalVersion == item.PasskeySignalVersion + 1)
                .ExecuteCommandAsync();
            if (activated != 1)
            {
                throw new InvalidOperationException("provisional_account_activation_conflict");
            }

            activatedUser.RegistrationState = AccountRegistrationStates.Active;
            activatedUser.PasskeyEnabled = true;
            activatedUser.PasskeyUserHandle = stableHandle;
            accessToken = jwt.GenerateAccessToken(activatedUser, sessionId, mfaVerified: true);

            await db.Insertable(new UserSession
            {
                SessionId = sessionId,
                UserId = activatedUser.Id,
                RefreshTokenHash = HashOpaqueToken(refreshToken),
                DeviceFingerprint = Normalize(client.DeviceFingerprint, 128),
                LastIp = Normalize(client.ClientIp, 64),
                UserAgent = Normalize(client.UserAgent, 512),
                CreatedAt = now,
                LastSeenAt = now,
                IdleExpiresAt = idleExpiresAt,
                AbsoluteExpiresAt = absoluteExpiresAt,
                MfaVerified = true,
                RememberMe = false
            }).ExecuteCommandAsync();

            int completed = await db.Updateable<AccountEnrollmentSession>()
                .Where(item => item.TokenHash == tokenHash &&
                               item.State == AccountEnrollmentStates.Completing &&
                               item.CompletionRequestHash == requestHash)
                .SetColumns(item => item.State == AccountEnrollmentStates.Completed)
                .SetColumns(item => item.CompletedSessionId == sessionId)
                .SetColumns(item => item.ProtectedRefreshToken == protectedRefreshToken)
                .SetColumns(item => item.CompletedAt == now)
                .SetColumns(item => item.CompletionLeaseUntil == null)
                .SetColumns(item => item.RegistrationChallengeKey == null)
                .ExecuteCommandAsync();
            if (completed != 1)
            {
                throw new InvalidOperationException("enrollment_completion_projection_conflict");
            }
        });

        if (!transaction.IsSuccess || activatedUser is null)
        {
            logger.LogError(transaction.ErrorException, "Atomic account enrollment failed. AccountId={AccountId}", current.AccountId);
            return Fail(ErrorCode.Conflict, "账户激活发生并发冲突，请安全重试同一注册请求");
        }

        User committedUser = activatedUser!;
        await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, request.SessionKey, cancellationToken);
        await AccountSnapshotCacheInvalidator.BumpVersionAsync(counters, committedUser.Id, cancellationToken);
        return Success(committedUser, accessToken, refreshToken, sessionId, idleExpiresAt);
    }

    public async Task<AuthBinaryFlowResult> GetStatusAsync(string? token, CancellationToken cancellationToken = default)
    {
        if (!TryHashToken(token, out string tokenHash))
        {
            return Fail(ErrorCode.Unauthorized, "注册会话不存在");
        }

        AccountEnrollmentSession? enrollment = await db.Queryable<AccountEnrollmentSession>()
            .Where(item => item.TokenHash == tokenHash)
            .FirstAsync();
        if (enrollment is null || enrollment.State is AccountEnrollmentStates.Cancelled or AccountEnrollmentStates.Expired)
        {
            return Fail(ErrorCode.Unauthorized, "注册会话不存在或已结束");
        }

        User? user = await db.Queryable<User>().InSingleAsync(enrollment.AccountId);
        if (user is null)
        {
            return Fail(ErrorCode.NotFound, "待激活账户不存在");
        }

        string phase = string.Equals(enrollment.State, AccountEnrollmentStates.Completed, StringComparison.Ordinal)
            ? "authenticated"
            : "enrollment_required";
        return new AuthBinaryFlowResult(
            true,
            ErrorDetail.None,
            new AuthLoginFlowDto(user.Id, user.IdentityKind, phase, null, null),
            null);
    }

    public async Task<(bool Success, ErrorDetail Error)> CancelAsync(string? token, CancellationToken cancellationToken = default)
    {
        if (!TryHashToken(token, out string tokenHash))
        {
            return (false, ErrorDetail.Create(ErrorCode.Unauthorized, "注册会话不存在"));
        }

        string? challenge = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            AccountEnrollmentSession? enrollment = await LockEnrollmentAsync(tokenHash, cancellationToken)
                ?? throw new InvalidOperationException("enrollment_not_found");
            if (!string.Equals(enrollment.State, AccountEnrollmentStates.Pending, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("enrollment_not_cancellable");
            }

            challenge = enrollment.RegistrationChallengeKey;
            await db.Deleteable<AccountEnrollmentSession>().Where(item => item.TokenHash == tokenHash).ExecuteCommandAsync();
            await db.Deleteable<User>()
                .Where(item => item.Id == enrollment.AccountId &&
                               item.RegistrationState == AccountRegistrationStates.Provisional)
                .ExecuteCommandAsync();
        });
        if (!transaction.IsSuccess)
        {
            return (false, ErrorDetail.Create(ErrorCode.Conflict, "注册会话无法取消"));
        }

        if (!string.IsNullOrWhiteSpace(challenge))
        {
            await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, challenge, cancellationToken);
        }
        return (true, ErrorDetail.None);
    }

    public async Task<int> CleanupExpiredAsync(CancellationToken cancellationToken = default)
    {
        DateTime now = DateTime.UtcNow;
        DateTime completedReceiptCutoff = now.Subtract(s_completedReceiptRetention);
        List<AccountEnrollmentSession> expired = await db.Queryable<AccountEnrollmentSession>()
            .Where(item =>
                (item.ExpiresAt <= now && item.State != AccountEnrollmentStates.Completed) ||
                (item.State == AccountEnrollmentStates.Completed && item.CompletedAt <= completedReceiptCutoff))
            .Take(256)
            .ToListAsync();
        int removed = 0;
        foreach (AccountEnrollmentSession enrollment in expired)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                int deletedSession = await db.Deleteable<AccountEnrollmentSession>()
                    .Where(item =>
                        item.TokenHash == enrollment.TokenHash &&
                        ((item.ExpiresAt <= now && item.State != AccountEnrollmentStates.Completed) ||
                         (item.State == AccountEnrollmentStates.Completed && item.CompletedAt <= completedReceiptCutoff)))
                    .ExecuteCommandAsync();
                if (deletedSession == 0)
                {
                    return;
                }

                if (!string.Equals(enrollment.State, AccountEnrollmentStates.Completed, StringComparison.Ordinal))
                {
                    await db.Deleteable<User>()
                        .Where(item => item.Id == enrollment.AccountId &&
                                       item.RegistrationState == AccountRegistrationStates.Provisional)
                        .ExecuteCommandAsync();
                }
                removed++;
            });
            if (transaction.IsSuccess && !string.IsNullOrWhiteSpace(enrollment.RegistrationChallengeKey))
            {
                await invalidation.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, enrollment.RegistrationChallengeKey, cancellationToken);
            }
        }
        return removed;
    }

    private async Task<AccountEnrollmentSession?> LoadPendingAsync(string? token, CancellationToken cancellationToken)
    {
        if (!TryHashToken(token, out string hash))
        {
            return null;
        }
        DateTime now = DateTime.UtcNow;
        return await db.Queryable<AccountEnrollmentSession>()
            .Where(item => item.TokenHash == hash &&
                           item.State == AccountEnrollmentStates.Pending &&
                           item.ExpiresAt > now)
            .FirstAsync();
    }

    private async Task<AuthBinaryFlowResult> ReplayCompletedAsync(AccountEnrollmentSession enrollment, string requestHash, CancellationToken cancellationToken)
    {
        if (!string.Equals(enrollment.CompletionRequestHash, requestHash, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(enrollment.CompletedSessionId) ||
            string.IsNullOrWhiteSpace(enrollment.ProtectedRefreshToken))
        {
            return Fail(ErrorCode.Conflict, "注册已由另一请求完成");
        }

        User? user = await db.Queryable<User>().InSingleAsync(enrollment.AccountId);
        UserSession? session = await db.Queryable<UserSession>().InSingleAsync(enrollment.CompletedSessionId);
        if (user is null || session is null || session.RevokedAt.HasValue ||
            !AccountRegistrationStates.IsActive(user.RegistrationState))
        {
            return Fail(ErrorCode.Conflict, "注册已完成，但正式会话已失效");
        }

        string refreshToken;
        try
        {
            refreshToken = _refreshProtector.Unprotect(enrollment.ProtectedRefreshToken);
        }
        catch (CryptographicException)
        {
            return Fail(ErrorCode.InfraFailure, "注册完成凭据无法恢复");
        }

        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, session.SessionId, mfaVerified: true);
        return Success(user, accessToken, refreshToken, session.SessionId, session.IdleExpiresAt);
    }

    private async Task ReleaseFailedClaimAsync(string tokenHash, string requestHash, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Updateable<AccountEnrollmentSession>()
            .Where(item => item.TokenHash == tokenHash &&
                           item.State == AccountEnrollmentStates.Completing &&
                           item.CompletionRequestHash == requestHash)
            .SetColumns(item => item.State == AccountEnrollmentStates.Pending)
            .SetColumns(item => item.CompletionRequestHash == null)
            .SetColumns(item => item.CompletionLeaseUntil == null)
            .SetColumns(item => item.RegistrationChallengeKey == null)
            .ExecuteCommandAsync();
    }

    private async Task<AccountEnrollmentSession?> LockEnrollmentAsync(string tokenHash, CancellationToken cancellationToken)
    {
        await using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT 1 FROM account_enrollment_session WHERE token_hash = @TokenHash FOR UPDATE;",
            new SugarParameter("@TokenHash", tokenHash)))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }
        }
        return await db.Queryable<AccountEnrollmentSession>().Where(item => item.TokenHash == tokenHash).FirstAsync();
    }

    private async Task<User?> LockProvisionalUserAsync(int accountId, CancellationToken cancellationToken)
    {
        await using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT 1 FROM sys_user
            WHERE id = @AccountId AND registration_state = @Provisional
              AND status <> 2 AND deleted_at IS NULL
            FOR UPDATE;
            """,
            new SugarParameter("@AccountId", accountId),
            new SugarParameter("@Provisional", AccountRegistrationStates.Provisional)))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }
        }
        return await db.Queryable<User>().InSingleAsync(accountId);
    }

    private static AuthBinaryFlowResult Success(User user, IssuedAccessToken accessToken, string refreshToken, string sessionId, DateTime idleExpiresAt)
        => new(
            true,
            ErrorDetail.None,
            new AuthLoginFlowDto(user.Id, user.IdentityKind, "authenticated", null, null),
            new AuthBinarySessionTokens(accessToken.Token, accessToken.ExpiresAtUtc, refreshToken, sessionId, idleExpiresAt));

    private static AuthBinaryFlowResult Fail(ErrorCode code, string message)
        => new(false, ErrorDetail.Create(code, message), default, null);

    private static string HashRequest(PasskeyRegisterCompleteCoreModel request)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        PodBinaryCodec.WritePasskeyRegisterCompleteRequest(request, payload);
        return Convert.ToHexString(SHA256.HashData(payload.WrittenSpan));
    }

    private static string HashOpaqueToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static bool TryHashToken(string? token, out string hash)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length is < 32 or > 256)
        {
            hash = string.Empty;
            return false;
        }
        hash = AnonymousAccountBootstrapService.HashEnrollmentToken(token);
        return true;
    }

    private static string? Normalize(string? value, int maxLength)
    {
        string? normalized = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        return normalized is not null && normalized.Length > maxLength ? normalized[..maxLength] : normalized;
    }
}
