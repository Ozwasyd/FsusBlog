using System.Data.Common;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserLoginWorkflowService(
    ISqlSugarClient db,
    ILogger<UserLoginWorkflowService> logger,
    IJwtHelper jwt,
    IUserSessionValidationCache sessionValidation,
    IAuthRiskService authRisk,
    IUserSessionMetadataProtector sessionMetadata,
    IConfiguration? configuration = null,
    IMessageNotificationStreamPort? notificationStream = null) : IUserLoginWorkflowService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private static readonly TimeSpan s_standardSessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan s_rememberMeSessionIdleTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan s_standardSessionAbsoluteTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan s_rememberMeSessionAbsoluteTtl = TimeSpan.FromDays(90);

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, UserAccountSnapshot? User)> CompleteLoginAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe,
        UserSessionAuthenticationContext? authenticationContext = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await db.Queryable<User>().InSingleAsync(userId);
        if (user is null)
        {
            return (false, "用户不存在", null, null);
        }

        var result = await CompleteLoginAsync(
            user,
            clientIp,
            deviceFingerprint,
            userAgent,
            mfaVerified,
            rememberMe,
            authenticationContext);
        return (
            result.Success,
            result.Message,
            result.Data,
            result.UserEntity is null ? null : UserAccountReader.ToAccountSnapshot(result.UserEntity));
    }

    public Task<RiskEvaluationResult> EvaluateLoginRiskAsync(
        int userId,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return authRisk.EvaluateLoginRiskAsync(userId, clientIp, deviceFingerprint, userAgent);
    }

    private static TimeSpan ResolveIdleSessionTtl(bool rememberMe)
        => rememberMe ? s_rememberMeSessionIdleTtl : s_standardSessionIdleTtl;

    private static TimeSpan ResolveAbsoluteSessionTtl(bool rememberMe)
        => rememberMe ? s_rememberMeSessionAbsoluteTtl : s_standardSessionAbsoluteTtl;

    public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync(
        User user,
        string clientIp,
        string? deviceFingerprint,
        string? userAgent,
        bool mfaVerified,
        bool rememberMe,
        UserSessionAuthenticationContext? authenticationContext = null)
    {
        if (!AccountRegistrationStates.IsActive(user.RegistrationState))
        {
            return (false, "账户尚未完成首枚通行密钥绑定", null, null);
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销", null, null);
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "login-restriction-audit");
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "login.restricted"),
                new KeyValuePair<string, object?>("AccountSubjectHash", accountSubject));
            LogBannedAccountLogin(accountSubject);
        }

        DateTime authenticatedAtUtc = DateTime.UtcNow;
        UserSessionAuthenticationContext sessionAuthentication = authenticationContext
            ?? UserSessionAuthenticationContext.FromLegacy(mfaVerified, rememberMe, authenticatedAtUtc);
        sessionAuthentication = sessionAuthentication with
        {
            AuthenticatedAtUtc = DateTime.SpecifyKind(sessionAuthentication.AuthenticatedAtUtc, DateTimeKind.Utc),
            DurationPolicy = UserSessionDurationPolicies.FromRememberMe(rememberMe),
            SessionMode = user.Status == UserStatusBanned
                ? UserSessionMode.Restricted
                : UserSessionMode.Normal
        };
        if (!UserSessionAuthenticationMethods.IsValid(sessionAuthentication.Method) ||
            !UserSessionAuthenticationStrengths.IsValid(sessionAuthentication.Strength) ||
            sessionAuthentication.AuthenticatedAtUtc == default)
        {
            return (false, "登录认证上下文无效", null, null);
        }

        string refreshToken = jwt.GenerateRefreshToken();
        string refreshTokenHash = HashToken(refreshToken);
        string sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        string refreshFamilyId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, sessionId, sessionAuthentication);
        DateTime idleExpiresAt = DateTime.MinValue;
        DateTime absoluteExpiresAt = DateTime.MinValue;

        UserSessionMetadataSnapshot metadata = sessionMetadata.Capture(
            user.Id,
            clientIp,
            deviceFingerprint,
            userAgent);
        var session = new UserSession
        {
            SessionId = sessionId,
            UserId = user.Id,
            RefreshTokenHash = refreshTokenHash,
            RefreshFamilyId = refreshFamilyId,
            RefreshGeneration = 0,
            DeviceSignalHash = metadata.DeviceSignalHash,
            DeviceSignalEpoch = metadata.DeviceSignalEpoch,
            NetworkSignalHash = metadata.NetworkSignalHash,
            NetworkSignalEpoch = metadata.NetworkSignalEpoch,
            BrowserFamily = metadata.BrowserFamily,
            OperatingSystemFamily = metadata.OperatingSystemFamily,
            FormFactor = metadata.FormFactor,
            CreatedAt = DateTime.UtcNow,
            LastSeenAt = DateTime.UtcNow,
            IdleExpiresAt = idleExpiresAt,
            AbsoluteExpiresAt = absoluteExpiresAt,
            SessionMode = sessionAuthentication.SessionMode,
            MfaVerified = UserSessionAuthenticationStrengths.IsCoarseMfa(sessionAuthentication.Strength),
            RememberMe = rememberMe,
            AuthenticationMethod = sessionAuthentication.Method,
            AuthenticationStrength = sessionAuthentication.Strength,
            AuthenticatedAtUtc = sessionAuthentication.AuthenticatedAtUtc,
            AuthenticatedCredentialRowId = sessionAuthentication.CredentialRowId,
            DurationPolicy = sessionAuthentication.DurationPolicy
        };

        long transactionStarted = Stopwatch.GetTimestamp();
        int expiredSessionCount = 0;
        int limitEvictedSessionCount = 0;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await UserSessionConcurrencyGate.AcquireAsync(db, user.Id);
            if (!await AccountCanAcceptSessionAsync(user.Id))
            {
                throw new UserSessionAdmissionRejectedException();
            }

            DateTime admittedAt = DateTime.UtcNow;
            idleExpiresAt = admittedAt.Add(ResolveIdleSessionTtl(rememberMe));
            absoluteExpiresAt = admittedAt.Add(ResolveAbsoluteSessionTtl(rememberMe));
            session.CreatedAt = admittedAt;
            session.LastSeenAt = admittedAt;
            session.IdleExpiresAt = idleExpiresAt;
            session.AbsoluteExpiresAt = absoluteExpiresAt;

            (expiredSessionCount, limitEvictedSessionCount) = await RevokeSessionsForAdmissionAsync(
                user.Id,
                admittedAt,
                Math.Max(0, UserSessionPolicy.ResolveMaxActiveSessions(configuration) - 1),
                revokedSessions);

            await db.Insertable(session).ExecuteCommandAsync();

            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(revokedSessions, allowOverwrite: true);
        });
        FsusObservability.RecordLoginSessionAdmission(
            expiredSessionCount,
            limitEvictedSessionCount,
            Stopwatch.GetElapsedTime(transactionStarted));
        if (!tran.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions);
            }

            if (tran.ErrorException is UserSessionAdmissionRejectedException)
            {
                return (false, "账户已注销", null, null);
            }

            logger.LogError(tran.ErrorException, "User session login transaction failed for account {AccountId}", user.Id);
            return (false, "登录失败，请重试", null, null);
        }

        if (revokedSessions.Count > 0 && notificationStream is not null)
        {
            try
            {
                await notificationStream.PublishToUserAsync(
                    NotificationStreamEventType.SessionRevoked,
                    user.Id,
                    new SessionRevokedPayload(
                        limitEvictedSessionCount > 0 ? "active_session_limit" : "session_expired",
                        revokedSessions.Count,
                        DateTime.UtcNow),
                    "user-session-admission-revoked");
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "User session admission notification failed for account {AccountId}", user.Id);
            }
        }

        return (true, "登录成功", new SessionTokenResponseDto(
            accessToken.Token,
            accessToken.ExpiresAtUtc,
            refreshToken,
            session.SessionId,
            idleExpiresAt,
            session.DurationPolicy), user);
    }

    private async Task<(int Expired, int LimitEvicted)> RevokeSessionsForAdmissionAsync(
        int userId,
        DateTime revokedAt,
        int existingSessionLimit,
        List<UserSessionValidationCacheState> revokedSessions)
    {
        int expired = 0;
        int limitEvicted = 0;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH ranked_sessions AS (
                SELECT sessionid,
                       (idleexpiresat <= @RevokedAt OR absoluteexpiresat <= @RevokedAt) AS is_expired,
                       SUM(
                           CASE
                               WHEN idleexpiresat <= @RevokedAt OR absoluteexpiresat <= @RevokedAt THEN 0
                               ELSE 1
                           END
                       ) OVER (
                           ORDER BY COALESCE(lastseenat, createdat) DESC NULLS LAST,
                                    createdat DESC,
                                    sessionid DESC
                       ) AS live_rank
                FROM sys_user_session
                WHERE userid = @UserId
                  AND revokedat IS NULL
            ),
            revoke_candidates AS (
                SELECT sessionid,
                       CASE
                           WHEN is_expired THEN 'session_expired'
                           ELSE 'active_session_limit'
                       END AS revoke_reason
                FROM ranked_sessions
                WHERE is_expired OR live_rank > @ExistingSessionLimit
            )
            UPDATE sys_user_session session
            SET revokedat = @RevokedAt,
                revokereason = candidate.revoke_reason,
                session_mode = 2
            FROM revoke_candidates candidate
            WHERE session.sessionid = candidate.sessionid
              AND session.revokedat IS NULL
            RETURNING session.sessionid,
                      session.userid,
                      session.revokedat,
                      session.idleexpiresat,
                      session.absoluteexpiresat,
                      session.revokereason,
                      session.xmin::text AS row_version;
            """,
            new SugarParameter("@UserId", userId),
            new SugarParameter("@RevokedAt", revokedAt),
            new SugarParameter("@ExistingSessionLimit", existingSessionLimit));

        while (await reader.ReadAsync())
        {
            revokedSessions.Add(ReadRevokedSessionValidationState(reader));
            if (string.Equals(reader.ReadString("revokereason"), "session_expired", StringComparison.Ordinal))
            {
                expired++;
            }
            else
            {
                limitEvicted++;
            }
        }

        return (expired, limitEvicted);
    }

    private async Task<bool> AccountCanAcceptSessionAsync(int userId)
    {
        if (db.CurrentConnectionConfig?.DbType != SqlSugar.DbType.PostgreSQL)
        {
            return true;
        }

        return await db.Ado.GetIntAsync(
            """
            SELECT CASE WHEN EXISTS (
                SELECT 1
                FROM sys_user
                WHERE id = @UserId
                  AND status <> 2
                  AND deleted_at IS NULL
            ) THEN 1 ELSE 0 END;
            """,
            new SugarParameter[] { new("@UserId", userId) }) == 1;
    }

    private static UserSessionValidationCacheState ReadRevokedSessionValidationState(DbDataReader reader)
        => new(
            reader.ReadString("sessionid"),
            reader.ReadInt32("userid"),
            AsUtc(reader.ReadDateTime("revokedat")),
            AsUtc(reader.ReadDateTime("idleexpiresat")),
            AsUtc(reader.ReadDateTime("absoluteexpiresat")),
            reader.ReadString("row_version"),
            UserStatusNormal,
            null,
            AnonymousIdentityRuntime.AnonymousAccountKind,
            SessionMode: UserSessionMode.Revoked);

    private static DateTime AsUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    private async Task BestEffortInvalidateRevocationSnapshotsAsync(
        IReadOnlyList<UserSessionValidationCacheState> revokedSessions)
    {
        try
        {
            await sessionValidation.InvalidateManyAsync(
                revokedSessions,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            // A failed cleanup leaves a revoked snapshot behind. That may deny a session
            // whose database transaction rolled back, but it cannot authorize a revoked one.
            logger.LogWarning(
                ex,
                "Failed to clean up {SessionCount} pre-commit user-session revocation snapshots",
                revokedSessions.Count);
        }
    }

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string? Truncate(string? input, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        return input.Length <= maxLen ? input : input[..maxLen];
    }

    [LoggerMessage(EventId = 3, Level = LogLevel.Information, Message = "受限账号登录 | AccountSubject: {AccountSubject} | 状态: 只读模式")]
    private partial void LogBannedAccountLogin(string accountSubject);

    private sealed class UserSessionAdmissionRejectedException : InvalidOperationException;
}
