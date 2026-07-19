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
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserSessionCommandService(
    ISqlSugarClient db,
    ILogger<UserSessionCommandService> logger,
    IJwtHelper jwt,
    IUserSessionValidationCache sessionValidation) : IUserSessionCommandService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private static readonly TimeSpan s_standardSessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan s_rememberMeSessionIdleTtl = TimeSpan.FromDays(30);

    private static TimeSpan ResolveIdleSessionTtl(bool rememberMe)
        => rememberMe ? s_rememberMeSessionIdleTtl : s_standardSessionIdleTtl;

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private async Task BestEffortInvalidateRevocationSnapshotsAsync(
        IReadOnlyList<UserSessionValidationCacheState> revokedSessions)
    {
        try
        {
            await sessionValidation.InvalidateManyAsync(revokedSessions, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Failed to clean up {SessionCount} pre-commit user-session revocation snapshots",
                revokedSessions.Count);
        }
    }

    public async Task<(bool Success, TokenResponseDto? Data, DateTime ExpiresAt)> RefreshTokenWithExpiryAsync(
        string refreshToken,
        string? sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await RefreshTokenAsync(refreshToken, sessionId, cancellationToken);
        return result.Success && result.Data.HasValue
            ? (true, result.Data, result.Data.Value.RefreshTokenExpiresAt ?? DateTime.UtcNow.AddDays(7))
            : (false, null, DateTime.UtcNow);
    }

    public async Task<bool> RevokeRefreshTokenAsync(string refreshToken, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(refreshToken))
            return false;

        string hash = HashToken(refreshToken);
        DateTime revokedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = 'logout'
                WHERE refreshtokenhash = @RefreshTokenHash
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@RefreshTokenHash", hash)))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            cancellationToken.ThrowIfCancellationRequested();
            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(
                revokedSessions,
                allowOverwrite: true,
                cancellationToken: cancellationToken);
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("refresh-token revocation transaction failed");
        }

        return revokedSessions.Count > 0;
    }


    public async Task<UserSession?> GetSessionByRefreshTokenAsync(
        string refreshToken,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            return null;
        }

        string hash = HashToken(refreshToken);
        return await db.Queryable<UserSession>()
            .FirstAsync(s => s.RefreshTokenHash == hash && s.RevokedAt == null);
    }

    public async Task<List<UserSessionSummaryDto>> GetUserSessionsAsync(
        int userId,
        string? currentSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var sessions = await db.Queryable<UserSession>()
            .Where(s => s.UserId == userId && s.RevokedAt == null && s.IdleExpiresAt > DateTime.UtcNow && s.AbsoluteExpiresAt > DateTime.UtcNow)
            .OrderByDescending(s => s.LastSeenAt)
            .Take(50)
            .Select(s => new UserSessionSummaryRow
            {
                SessionId = s.SessionId,
                DeviceFingerprint = s.DeviceFingerprint,
                UserAgent = s.UserAgent,
                LastSeenAt = s.LastSeenAt,
                MfaVerified = s.MfaVerified
            })
            .ToListAsync();

        return sessions.Select(s => new UserSessionSummaryDto(
            s.SessionId,
            s.DeviceFingerprint ?? "unknown",
            BuildDeviceLabel(s.UserAgent, s.DeviceFingerprint),
            s.LastSeenAt,
            string.Equals(s.SessionId, currentSessionId, StringComparison.Ordinal),
            s.MfaVerified)).ToList();
    }

    private sealed record UserSessionSummaryRow
    {
        public string SessionId { get; init; } = string.Empty;
        public string? DeviceFingerprint
        {
            get; init;
        }
        public string? UserAgent
        {
            get; init;
        }
        public DateTime? LastSeenAt
        {
            get; init;
        }
        public bool MfaVerified
        {
            get; init;
        }
    }

    private static string BuildDeviceLabel(string? userAgent, string? fingerprint)
    {
        if (!string.IsNullOrWhiteSpace(userAgent))
        {
            string normalized = userAgent.Trim();
            if (normalized.Length <= 96)
            {
                return normalized;
            }

            return $"{normalized[..96]}...";
        }

        return string.IsNullOrWhiteSpace(fingerprint) ? "unknown" : fingerprint;
    }

    public async Task<bool> RevokeSessionAsync(
        int userId,
        string sessionId,
        string reason = "manual_revoke",
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        DateTime revokedAt = DateTime.UtcNow;
        UserSessionValidationCacheState? revokedSession = null;
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = @Reason
                WHERE userid = @UserId
                  AND sessionid = @SessionId
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@Reason", reason),
                new SugarParameter("@UserId", userId),
                new SugarParameter("@SessionId", sessionId)))
            {
                if (await reader.ReadAsync())
                {
                    revokedSession = ReadRevokedSessionValidationState(reader);
                }
            }

            if (revokedSession is not null)
            {
                publicationAttempted = true;
                await sessionValidation.PublishManyAsync([revokedSession], allowOverwrite: true);
            }
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted && revokedSession is not null)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync([revokedSession]);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("user session revocation transaction failed");
        }

        return revokedSession is not null;
    }

    public async Task<int> RevokeOtherSessionsAsync(
        int userId,
        string? currentSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime revokedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = 'revoke_others'
                WHERE userid = @UserId
                  AND revokedat IS NULL
                  AND (@CurrentSessionId IS NULL OR sessionid <> @CurrentSessionId)
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@UserId", userId),
                new SugarParameter("@CurrentSessionId", currentSessionId)))
            {
                while (await reader.ReadAsync())
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(revokedSessions, allowOverwrite: true);
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("bulk user session revocation transaction failed");
        }

        return revokedSessions.Count;
    }

    public async Task<int> RevokeAllSessionsAsync(
        int userId,
        string reason,
        CancellationToken cancellationToken = default)
    {
        if (userId <= 0)
        {
            return 0;
        }

        string normalizedReason = string.IsNullOrWhiteSpace(reason)
            ? "security_revoke_all"
            : reason.Trim();
        if (normalizedReason.Length > 128)
        {
            normalizedReason = normalizedReason[..128];
        }

        DateTime revokedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = @Reason
                WHERE userid = @UserId
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@Reason", normalizedReason),
                new SugarParameter("@UserId", userId)))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(
                revokedSessions,
                allowOverwrite: true,
                cancellationToken);
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("bulk user session security revocation transaction failed");
        }

        return revokedSessions.Count;
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

    public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync(
        string refreshToken,
        string? sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
                new KeyValuePair<string, object?>("Reason", "missing-token"));
            LogTokenRefreshFailure();
            return (false, null);
        }

        string hash = HashToken(refreshToken);
        DateTime now = DateTime.UtcNow;
        var query = db.Queryable<UserSession>()
            .Where(s => s.RefreshTokenHash == hash && s.RevokedAt == null && s.IdleExpiresAt > now && s.AbsoluteExpiresAt > now);
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            query = query.Where(s => s.SessionId == sessionId);
        }

        var session = await query.FirstAsync();
        if (session == null)
        {
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                int revokedSessions = await RevokeLikelyRefreshReplayAsync(sessionId, hash);
                FsusObservability.RecordAuthRefreshReplayDetected();
                FsusObservability.RecordAuthRefreshFamilyRevoke(revokedSessions);
            }

            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
                new KeyValuePair<string, object?>("Reason", "session-not-found"));
            LogTokenRefreshFailure();
            return (false, null);
        }

        var user = await db.Queryable<User>().InSingleAsync(session.UserId);
        if (user == null || user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, null);
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "token-refresh-restriction-audit");
            LogBannedAccountTokenRefresh(accountSubject);
        }

        string newRefreshToken = jwt.GenerateRefreshToken();
        string newRefreshHash = HashToken(newRefreshToken);
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(session.RememberMe));
        if (idleExpiresAt > session.AbsoluteExpiresAt)
        {
            idleExpiresAt = session.AbsoluteExpiresAt;
        }
        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, session.SessionId, session.MfaVerified);

        int rotated = await db.Updateable<UserSession>()
            .SetColumns(s => s.RefreshTokenHash == newRefreshHash)
            .SetColumns(s => s.LastSeenAt == now)
            .SetColumns(s => s.IdleExpiresAt == idleExpiresAt)
            .Where(s => s.SessionId == session.SessionId
                && s.RefreshTokenHash == hash
                && s.RevokedAt == null
                && s.IdleExpiresAt > now
                && s.AbsoluteExpiresAt > now)
            .ExecuteCommandAsync();

        if (rotated != 1)
        {
            int revokedSessions = await RevokeLikelyRefreshReplayAsync(session.SessionId, hash);
            FsusObservability.RecordAuthRefreshReplayDetected();
            FsusObservability.RecordAuthRefreshFamilyRevoke(revokedSessions);
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh_token_reuse_detected"),
                new KeyValuePair<string, object?>("SessionId", session.SessionId),
                new KeyValuePair<string, object?>("UserId", session.UserId));
            LogRefreshTokenReuseDetected(session.SessionId, session.UserId);
            return (false, null);
        }

        FsusObservability.RecordAuthRefreshSuccess(3, FsusObservability.GetElapsed(startedAt));
        return (true, new TokenResponseDto(
            accessToken.Token,
            newRefreshToken,
            idleExpiresAt,
            session.SessionId,
            accessToken.ExpiresAtUtc));
    }

    public async Task<bool> VerifyRefreshRotationAsync(
        string refreshToken,
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(refreshToken) || string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        string hash = HashToken(refreshToken);
        DateTime now = DateTime.UtcNow;
        int matches = await db.Queryable<UserSession>()
            .Where(session => session.SessionId == sessionId
                && session.RefreshTokenHash == hash
                && session.RevokedAt == null
                && session.IdleExpiresAt > now
                && session.AbsoluteExpiresAt > now)
            .CountAsync();
        return matches == 1;
    }


    private async Task<int> RevokeLikelyRefreshReplayAsync(string sessionId, string staleHash)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(staleHash))
        {
            return 0;
        }

        const string Reason = "refresh_token_reuse_family_revoke";
        DateTime revokedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                WITH replay_target AS MATERIALIZED (
                    SELECT userid,
                           devicefingerprint
                    FROM sys_user_session
                    WHERE sessionid = @SessionId
                      AND revokedat IS NULL
                      AND refreshtokenhash <> @StaleHash
                    FOR UPDATE
                ),
                revoked AS (
                    UPDATE sys_user_session AS session
                    SET revokedat = @RevokedAt,
                        revokereason = @Reason
                    FROM replay_target AS target
                    WHERE session.userid = target.userid
                      AND session.revokedat IS NULL
                      AND session.devicefingerprint IS NOT DISTINCT FROM target.devicefingerprint
                    RETURNING session.sessionid,
                              session.userid,
                              session.revokedat,
                              session.idleexpiresat,
                              session.absoluteexpiresat,
                              session.xmin::text AS row_version
                )
                SELECT sessionid,
                       userid,
                       revokedat,
                       idleexpiresat,
                       absoluteexpiresat,
                       row_version
                FROM revoked;
                """,
                new SugarParameter("@SessionId", sessionId),
                new SugarParameter("@StaleHash", staleHash),
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@Reason", Reason)))
            {
                while (await reader.ReadAsync())
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(
                revokedSessions,
                allowOverwrite: true);
        });

        if (!transaction.IsSuccess)
        {
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("refresh token replay family revocation transaction failed");
        }

        return revokedSessions.Count;
    }


    [LoggerMessage(EventId = 4, Level = LogLevel.Information, Message = "续期失败 | 凭证失效")]
    private partial void LogTokenRefreshFailure();

    [LoggerMessage(EventId = 5, Level = LogLevel.Information, Message = "受限账号执行令牌续期 | AccountSubject: {AccountSubject} | 状态: 只读模式")]
    private partial void LogBannedAccountTokenRefresh(string accountSubject);

    [LoggerMessage(EventId = 7, Level = LogLevel.Warning, Message = "检测到刷新令牌重放 | SessionId: {SessionId} | UserId: {UserId}")]
    private partial void LogRefreshTokenReuseDetected(string sessionId, int userId);
}
