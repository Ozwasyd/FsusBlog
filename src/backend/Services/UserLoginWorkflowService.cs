using System.Data.Common;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserLoginWorkflowService(
    ISqlSugarClient db,
    ILogger<UserLoginWorkflowService> logger,
    IJwtHelper jwt,
    IUserSessionValidationCache sessionValidation,
    IAuthRiskService authRisk) : IUserLoginWorkflowService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private const int UserSessionLoginLockNamespace = 833064;
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
            rememberMe);
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
        bool rememberMe)
    {
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

        string refreshToken = jwt.GenerateRefreshToken();
        string refreshTokenHash = HashToken(refreshToken);
        string sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, sessionId, mfaVerified);
        DateTime now = DateTime.UtcNow;
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(rememberMe));
        DateTime absoluteExpiresAt = now.Add(ResolveAbsoluteSessionTtl(rememberMe));

        var session = new UserSession
        {
            SessionId = sessionId,
            UserId = user.Id,
            RefreshTokenHash = refreshTokenHash,
            DeviceFingerprint = string.IsNullOrWhiteSpace(deviceFingerprint) ? null : deviceFingerprint,
            LastIp = clientIp,
            UserAgent = Truncate(userAgent, 512),
            CreatedAt = now,
            LastSeenAt = now,
            IdleExpiresAt = idleExpiresAt,
            AbsoluteExpiresAt = absoluteExpiresAt,
            MfaVerified = mfaVerified,
            RememberMe = rememberMe
        };

        long transactionStarted = Stopwatch.GetTimestamp();
        int replacedSessionCount = 0;
        List<UserSessionValidationCacheState> replacedSessions = [];
        bool publicationAttempted = false;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireUserSessionLoginLockAsync(user.Id);

            replacedSessionCount = await RevokeActiveUserSessionsForLoginAsync(user.Id, now, replacedSessions);

            await db.Insertable(session).ExecuteCommandAsync();

            publicationAttempted = replacedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(replacedSessions, allowOverwrite: true);
        });
        FsusObservability.RecordLoginSessionReplacement(
            replacedSessionCount,
            sessionRevokeCommandCount: tran.IsSuccess ? 1 : 0,
            Stopwatch.GetElapsedTime(transactionStarted));
        if (!tran.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(replacedSessions);
            }

            logger.LogError(tran.ErrorException, "User session login transaction failed for account {AccountId}", user.Id);
            return (false, "登录失败，请重试", null, null);
        }

        return (true, "登录成功", new SessionTokenResponseDto(
            accessToken.Token,
            accessToken.ExpiresAtUtc,
            refreshToken,
            session.SessionId,
            idleExpiresAt), user);
    }

    private async Task<int> RevokeActiveUserSessionsForLoginAsync(
        int userId,
        DateTime revokedAt,
        List<UserSessionValidationCacheState> revokedSessions)
    {
        int count = 0;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE sys_user_session
            SET revokedat = @RevokedAt,
                revokereason = 'login_replaced'
            WHERE userid = @UserId
              AND revokedat IS NULL
            RETURNING sessionid,
                      userid,
                      revokedat,
                      idleexpiresat,
                      absoluteexpiresat,
                      xmin::text AS row_version;
            """,
            new SugarParameter("@UserId", userId),
            new SugarParameter("@RevokedAt", revokedAt));

        while (await reader.ReadAsync())
        {
            revokedSessions.Add(ReadRevokedSessionValidationState(reader));
            count++;
        }

        return count;
    }

    private async Task AcquireUserSessionLoginLockAsync(int userId)
    {
        if (db.CurrentConnectionConfig?.DbType != SqlSugar.DbType.PostgreSQL)
        {
            return;
        }

        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(@LockNamespace, @UserId);",
            new SugarParameter("@LockNamespace", UserSessionLoginLockNamespace),
            new SugarParameter("@UserId", userId));
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
            AnonymousIdentityRuntime.AnonymousAccountKind);

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
}
