using System.Data.Common;

using FsusBlog.Server.Infrastructure.Data;
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
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class UserSessionCommandService(
    ISqlSugarClient db,
    ILogger<UserSessionCommandService> logger,
    IJwtHelper jwt,
    IUserSessionValidationCache sessionValidation,
    IMessageNotificationStreamPort? notificationStream = null) : IUserSessionCommandService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private static readonly TimeSpan s_standardSessionIdleTtl = TimeSpan.FromDays(7);
    private static readonly TimeSpan s_rememberMeSessionIdleTtl = TimeSpan.FromDays(30);
    private static readonly TimeSpan s_refreshConcurrencyGrace = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan s_refreshTombstoneRetention = TimeSpan.FromDays(30);

    private static TimeSpan ResolveIdleSessionTtl(string durationPolicy)
        => UserSessionDurationPolicies.IsPersistent(durationPolicy)
            ? s_rememberMeSessionIdleTtl
            : s_standardSessionIdleTtl;

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

    public async Task<RefreshTokenRotationResult> RotateRefreshTokenAsync(
        string refreshToken,
        string? sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        if (string.IsNullOrWhiteSpace(refreshToken))
        {
            return RefreshFailure(RefreshTokenRotationOutcome.MissingToken, "missing-token");
        }

        string currentHash = HashToken(refreshToken);
        DateTime now = DateTime.UtcNow;
        await DeleteExpiredRefreshTombstonesAsync(now).ConfigureAwait(false);

        UserSession? session = await db.Queryable<UserSession>()
            .Where(candidate => candidate.RefreshTokenHash == currentHash)
            .FirstAsync();
        if (session is null)
        {
            UserRefreshTokenTombstone? tombstone = await db.Queryable<UserRefreshTokenTombstone>()
                .Where(candidate => candidate.TokenHash == currentHash && candidate.ExpiresAtUtc > now)
                .FirstAsync();
            if (tombstone is null)
            {
                return RefreshFailure(RefreshTokenRotationOutcome.ExpiredOrUnknown, "expired-or-unknown");
            }

            int revoked = await CompromiseRefreshFamilyAsync(
                tombstone.RefreshFamilyId,
                "refresh_token_replay",
                now,
                cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordAuthRefreshReplayDetected();
            FsusObservability.RecordAuthRefreshFamilyRevoke(revoked);
            return RefreshFailure(RefreshTokenRotationOutcome.ReplayCompromised, "refresh-token-replay");
        }

        string familyId = ResolveRefreshFamilyId(session);
        if (session.RevokedAt.HasValue
            || session.RefreshCompromisedAtUtc.HasValue
            || session.IdleExpiresAt <= now
            || session.AbsoluteExpiresAt <= now)
        {
            return RefreshFailure(RefreshTokenRotationOutcome.ExpiredOrUnknown, "expired-or-revoked");
        }

        if (!string.IsNullOrWhiteSpace(sessionId)
            && !string.Equals(session.SessionId, sessionId, StringComparison.Ordinal))
        {
            int revoked = await CompromiseRefreshFamilyAsync(
                familyId,
                "refresh_session_mismatch",
                now,
                cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordAuthRefreshReplayDetected();
            FsusObservability.RecordAuthRefreshFamilyRevoke(revoked);
            return RefreshFailure(RefreshTokenRotationOutcome.SessionMismatchCompromised, "session-mismatch");
        }

        User? user = await db.Queryable<User>().InSingleAsync(session.UserId);
        if (user is null || user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return RefreshFailure(RefreshTokenRotationOutcome.AccountUnavailable, "account-unavailable");
        }

        if (!UserSessionAuthenticationContext.TryFromSession(session, out UserSessionAuthenticationContext authenticationContext))
        {
            return RefreshFailure(RefreshTokenRotationOutcome.InvalidSessionContext, "invalid-session-context");
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "token-refresh-restriction-audit");
            LogBannedAccountTokenRefresh(accountSubject);
        }

        UserSessionMode authoritativeMode = user.Status == UserStatusBanned
            ? UserSessionMode.Restricted
            : UserSessionMode.Normal;
        authenticationContext = authenticationContext with
        {
            SessionMode = authoritativeMode
        };

        string nextToken = jwt.GenerateRefreshToken();
        string nextHash = HashToken(nextToken);
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(authenticationContext.DurationPolicy));
        if (idleExpiresAt > session.AbsoluteExpiresAt)
        {
            idleExpiresAt = session.AbsoluteExpiresAt;
        }

        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, session.SessionId, authenticationContext);
        bool rotated = false;
        long nextGeneration = session.RefreshGeneration + 1;
        DateTime tombstoneExpiresAt = now.Add(s_refreshTombstoneRetention);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                WITH rotated AS (
                    UPDATE sys_user_session
                    SET refreshtokenhash = @NextHash,
                        refresh_family_id = @FamilyId,
                        refresh_generation = refresh_generation + 1,
                        refresh_rotated_at_utc = @RotatedAtUtc,
                        lastseenat = @RotatedAtUtc,
                        idleexpiresat = @IdleExpiresAt,
                        session_mode = @SessionMode
                    WHERE sessionid = @SessionId
                      AND refreshtokenhash = @CurrentHash
                      AND refresh_family_id = @FamilyId
                      AND refresh_generation = @Generation
                      AND revokedat IS NULL
                      AND refresh_compromised_at_utc IS NULL
                      AND idleexpiresat > @RotatedAtUtc
                      AND absoluteexpiresat > @RotatedAtUtc
                    RETURNING sessionid, refresh_generation
                ), tombstone AS (
                    INSERT INTO user_refresh_token_tombstone
                        (token_hash, refresh_family_id, session_id, generation, used_at_utc, expires_at_utc)
                    SELECT @CurrentHash, @FamilyId, sessionid, @Generation, @RotatedAtUtc, @TombstoneExpiresAt
                    FROM rotated
                    ON CONFLICT (token_hash) DO NOTHING
                    RETURNING token_hash
                )
                SELECT sessionid, refresh_generation
                FROM rotated;
                """,
                new SugarParameter("@NextHash", nextHash),
                new SugarParameter("@FamilyId", familyId),
                new SugarParameter("@Generation", session.RefreshGeneration),
                new SugarParameter("@RotatedAtUtc", now),
                new SugarParameter("@IdleExpiresAt", idleExpiresAt),
                new SugarParameter("@SessionMode", (int)authoritativeMode),
                new SugarParameter("@SessionId", session.SessionId),
                new SugarParameter("@CurrentHash", currentHash),
                new SugarParameter("@TombstoneExpiresAt", tombstoneExpiresAt));
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                rotated = string.Equals(reader.ReadString("sessionid"), session.SessionId, StringComparison.Ordinal)
                    && reader.ReadInt64("refresh_generation") == nextGeneration;
            }
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            FsusObservability.RecordAuthRefreshDatabaseFailure("lineage-rotation");
            throw transaction.ErrorException
                ?? new InvalidOperationException("refresh-token lineage rotation transaction failed");
        }

        if (!rotated)
        {
            FsusObservability.RecordAuthRefreshRotationConflict();
            return RefreshFailure(RefreshTokenRotationOutcome.ConcurrentConflict, "cas-conflict");
        }

        FsusObservability.RecordAuthRefreshSuccess(4, FsusObservability.GetElapsed(startedAt));
        var tokens = new TokenResponseDto(
            accessToken.Token,
            nextToken,
            idleExpiresAt,
            session.SessionId,
            accessToken.ExpiresAtUtc);
        return new RefreshTokenRotationResult(
            RefreshTokenRotationOutcome.Success,
            tokens,
            idleExpiresAt,
            authenticationContext.DurationPolicy);
    }

    public async Task<bool> RevokeRefreshDeliveryAsync(
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
        UserSession? session = await db.Queryable<UserSession>()
            .Where(candidate => candidate.RefreshTokenHash == hash && candidate.SessionId == sessionId)
            .FirstAsync();
        if (session is null)
        {
            return false;
        }

        int revoked = await CompromiseRefreshFamilyAsync(
            ResolveRefreshFamilyId(session),
            "refresh_token_delivery_failure",
            DateTime.UtcNow,
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordAuthRefreshDeliveryFailure(revoked > 0 ? "family-revoked" : "family-already-inactive");
        return revoked > 0;
    }

    private RefreshTokenRotationResult RefreshFailure(RefreshTokenRotationOutcome outcome, string reason)
    {
        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
            new KeyValuePair<string, object?>("Reason", reason));
        LogTokenRefreshFailure();
        return new RefreshTokenRotationResult(outcome, null, DateTime.UtcNow, null);
    }

    private async Task DeleteExpiredRefreshTombstonesAsync(DateTime now)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM user_refresh_token_tombstone AS tombstone
            WHERE tombstone.expires_at_utc <= @Now
               OR EXISTS (
                    SELECT 1
                    FROM sys_user_session AS session
                    WHERE session.refresh_family_id = tombstone.refresh_family_id
                      AND session.revokedat IS NOT NULL
               );
            """,
            new SugarParameter("@Now", now)).ConfigureAwait(false);
    }

    private static string ResolveRefreshFamilyId(UserSession session)
        => string.IsNullOrWhiteSpace(session.RefreshFamilyId)
            ? session.SessionId
            : session.RefreshFamilyId;

    private async Task<int> CompromiseRefreshFamilyAsync(
        string familyId,
        string reason,
        DateTime compromisedAt,
        CancellationToken cancellationToken)
    {
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @CompromisedAt,
                    revokereason = @Reason,
                    session_mode = 2,
                    refresh_compromised_at_utc = @CompromisedAt,
                    refresh_compromise_reason = @Reason
                WHERE refresh_family_id = @FamilyId
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@CompromisedAt", compromisedAt),
                new SugarParameter("@Reason", reason),
                new SugarParameter("@FamilyId", familyId)))
            {
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            await db.Deleteable<UserRefreshTokenTombstone>()
                .Where(tombstone => tombstone.RefreshFamilyId == familyId)
                .ExecuteCommandAsync()
                .ConfigureAwait(false);
            publicationAttempted = revokedSessions.Count > 0;
            await sessionValidation.PublishManyAsync(
                revokedSessions,
                allowOverwrite: true,
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            FsusObservability.RecordAuthRefreshDatabaseFailure("family-compromise");
            if (publicationAttempted)
            {
                await BestEffortInvalidateRevocationSnapshotsAsync(revokedSessions).ConfigureAwait(false);
            }

            throw transaction.ErrorException
                ?? new InvalidOperationException("refresh-token family compromise transaction failed");
        }

        if (revokedSessions.Count > 0)
        {
            await PublishSessionRevocationAsync(
                revokedSessions[0].AccountId,
                reason,
                revokedSessions.Count).ConfigureAwait(false);
        }
        return revokedSessions.Count;
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
                    revokereason = 'logout',
                    session_mode = 2
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
        // SqlSugar multi-table expressions must reuse the join alias names
        // (`session`, `credential`). Discard parameters (`_`) fail closed with
        // an alias-mismatch exception and surface as HTTP 500 on /auth/sessions.
        var sessions = await db.Queryable<UserSession>()
            .LeftJoin<PasskeyCredential>((session, credential) =>
                session.AuthenticatedCredentialRowId == credential.Id &&
                session.UserId == credential.AccountId)
            .Where((session, credential) =>
                session.UserId == userId &&
                session.RevokedAt == null &&
                session.IdleExpiresAt > DateTime.UtcNow &&
                session.AbsoluteExpiresAt > DateTime.UtcNow)
            .OrderByDescending((session, credential) => session.LastSeenAt)
            .Take(50)
            .Select((session, credential) => new UserSessionSummaryRow
            {
                SessionId = session.SessionId,
                BrowserFamily = session.BrowserFamily,
                OperatingSystemFamily = session.OperatingSystemFamily,
                FormFactor = session.FormFactor,
                CreatedAt = session.CreatedAt,
                LastSeenAt = session.LastSeenAt,
                AuthenticationMethod = session.AuthenticationMethod,
                AuthenticationStrength = session.AuthenticationStrength,
                PasskeyFriendlyName = credential.DeviceFriendlyName,
                DurationPolicy = session.DurationPolicy
            })
            .ToListAsync();

        return sessions.Select(s => new UserSessionSummaryDto(
            SessionId: s.SessionId,
            DeviceLabel: BuildDeviceLabel(s.BrowserFamily, s.OperatingSystemFamily, s.FormFactor),
            CreatedAt: s.CreatedAt,
            LastSeenAt: s.LastSeenAt,
            AuthenticationMethod: NormalizeAuthenticationMethod(s.AuthenticationMethod),
            AuthenticationStrength: NormalizeAuthenticationStrength(s.AuthenticationStrength),
            PasskeyFriendlyName: NormalizeFriendlyName(s.PasskeyFriendlyName),
            DurationPolicy: NormalizeDurationPolicy(s.DurationPolicy),
            IsCurrent: string.Equals(s.SessionId, currentSessionId, StringComparison.Ordinal))).ToList();
    }

    private sealed record UserSessionSummaryRow
    {
        public string SessionId { get; init; } = string.Empty;
        public string BrowserFamily { get; init; } = "Unknown";
        public string OperatingSystemFamily { get; init; } = "Unknown";
        public string FormFactor { get; init; } = "Unknown";
        public DateTime CreatedAt
        {
            get; init;
        }
        public DateTime? LastSeenAt
        {
            get; init;
        }
        public string AuthenticationMethod { get; init; } = UserSessionAuthenticationMethods.Other;
        public string AuthenticationStrength { get; init; } = UserSessionAuthenticationStrengths.LegacyUnverified;
        public string? PasskeyFriendlyName
        {
            get; init;
        }
        public string DurationPolicy { get; init; } = UserSessionDurationPolicies.BrowserSession;
    }

    private static string BuildDeviceLabel(
        string? browserFamily,
        string? operatingSystemFamily,
        string? formFactor)
        => $"{NormalizeCoarseLabel(browserFamily)} / {NormalizeCoarseLabel(operatingSystemFamily)} / {NormalizeCoarseLabel(formFactor)}";

    private static string NormalizeCoarseLabel(string? value)
        => string.IsNullOrWhiteSpace(value) ? "Unknown" : value.Trim();

    private static string NormalizeAuthenticationMethod(string? value)
        => UserSessionAuthenticationMethods.IsValid(value)
            ? value!
            : UserSessionAuthenticationMethods.Other;

    private static string NormalizeAuthenticationStrength(string? value)
        => UserSessionAuthenticationStrengths.IsValid(value)
            ? value!
            : UserSessionAuthenticationStrengths.LegacyUnverified;

    private static string NormalizeDurationPolicy(string? value)
        => UserSessionDurationPolicies.IsValid(value)
            ? value!
            : UserSessionDurationPolicies.BrowserSession;

    private static string? NormalizeFriendlyName(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

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
                    revokereason = @Reason,
                    session_mode = 2
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

        if (revokedSession is not null)
        {
            await PublishSessionRevocationAsync(userId, reason, 1);
        }

        return revokedSession is not null;
    }

    public async Task<int> RevokeOtherSessionsAsync(
        int userId,
        string? currentSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime requestedAt = DateTime.UtcNow;
        DateTime revokedAt = requestedAt;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await UserSessionConcurrencyGate.AcquireAsync(db, userId);
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = 'revoke_others',
                    session_mode = 2
                WHERE userid = @UserId
                  AND revokedat IS NULL
                  AND (@CurrentSessionId IS NULL OR sessionid <> @CurrentSessionId)
                  AND createdat <= @RequestedAt
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@UserId", userId),
                new SugarParameter("@CurrentSessionId", currentSessionId),
                new SugarParameter("@RequestedAt", requestedAt)))
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

        await PublishSessionRevocationAsync(userId, "revoke_others", revokedSessions.Count);
        return revokedSessions.Count;
    }

    public async Task<int> RevokeSessionsByCredentialAsync(
        int userId,
        int credentialRowId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (userId <= 0 || credentialRowId <= 0)
        {
            return 0;
        }

        DateTime revokedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = 'credential_deleted',
                    session_mode = 2
                WHERE userid = @UserId
                  AND authenticated_credential_row_id = @CredentialRowId
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", revokedAt),
                new SugarParameter("@UserId", userId),
                new SugarParameter("@CredentialRowId", credentialRowId));
            while (await reader.ReadAsync(cancellationToken))
            {
                revokedSessions.Add(ReadRevokedSessionValidationState(reader));
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
                ?? new InvalidOperationException("credential-bound session revocation failed");
        }

        await PublishSessionRevocationAsync(userId, "credential_deleted", revokedSessions.Count);
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
            await UserSessionConcurrencyGate.AcquireAsync(db, userId);
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = @Reason,
                    session_mode = 2
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

        await PublishSessionRevocationAsync(userId, normalizedReason, revokedSessions.Count);
        return revokedSessions.Count;
    }

    private async Task PublishSessionRevocationAsync(int userId, string reason, int revokedSessionCount)
    {
        if (notificationStream is null || revokedSessionCount <= 0)
        {
            return;
        }

        try
        {
            await notificationStream.PublishToUserAsync(
                NotificationStreamEventType.SessionRevoked,
                userId,
                new SessionRevokedPayload(reason, revokedSessionCount, DateTime.UtcNow),
                "user-session-revoked");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "User session revocation notification failed for account {AccountId}", userId);
        }
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
                if (await IsRecentConcurrentRefreshRotationHashAsync(hash, sessionId, DateTime.UtcNow, cancellationToken))
                {
                    LogTokenRefreshFailure();
                    return (false, null);
                }
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

        if (!UserSessionAuthenticationContext.TryFromSession(session, out UserSessionAuthenticationContext authenticationContext))
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Auth,
                AuditTypeCatalog.Security,
                new KeyValuePair<string, object?>("AuditAction", "refresh.failed"),
                new KeyValuePair<string, object?>("Reason", "invalid-session-authentication-context"),
                new KeyValuePair<string, object?>("SessionId", session.SessionId));
            LogTokenRefreshFailure();
            return (false, null);
        }

        if (user.Status == UserStatusBanned)
        {
            string accountSubject = AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "token-refresh-restriction-audit");
            LogBannedAccountTokenRefresh(accountSubject);
        }

        UserSessionMode authoritativeMode = user.Status == UserStatusBanned
            ? UserSessionMode.Restricted
            : UserSessionMode.Normal;
        authenticationContext = authenticationContext with
        {
            SessionMode = authoritativeMode
        };

        string newRefreshToken = jwt.GenerateRefreshToken();
        string newRefreshHash = HashToken(newRefreshToken);
        DateTime idleExpiresAt = now.Add(ResolveIdleSessionTtl(authenticationContext.DurationPolicy));
        if (idleExpiresAt > session.AbsoluteExpiresAt)
        {
            idleExpiresAt = session.AbsoluteExpiresAt;
        }
        IssuedAccessToken accessToken = jwt.GenerateAccessToken(user, session.SessionId, authenticationContext);

        int rotated = await db.Updateable<UserSession>()
            .SetColumns(s => s.RefreshTokenHash == newRefreshHash)
            .SetColumns(s => s.LastSeenAt == now)
            .SetColumns(s => s.IdleExpiresAt == idleExpiresAt)
            .SetColumns(s => s.SessionMode == authoritativeMode)
            .Where(s => s.SessionId == session.SessionId
                && s.RefreshTokenHash == hash
                && s.RevokedAt == null
                && s.IdleExpiresAt > now
                && s.AbsoluteExpiresAt > now)
            .ExecuteCommandAsync();

        if (rotated != 1)
        {
            if (await IsRecentConcurrentRefreshRotationHashAsync(hash, session.SessionId, DateTime.UtcNow, cancellationToken))
            {
                LogTokenRefreshFailure();
                return (false, null);
            }
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

    public Task<bool> IsRecentConcurrentRefreshRotationAsync(
        string refreshToken,
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(refreshToken) || string.IsNullOrWhiteSpace(sessionId))
        {
            return Task.FromResult(false);
        }

        return IsRecentConcurrentRefreshRotationHashAsync(
            HashToken(refreshToken),
            sessionId,
            DateTime.UtcNow,
            cancellationToken);
    }

    private async Task<bool> IsRecentConcurrentRefreshRotationHashAsync(
        string staleHash,
        string sessionId,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        UserSession? current = await db.Queryable<UserSession>()
            .Where(session => session.SessionId == sessionId
                && session.RevokedAt == null
                && session.IdleExpiresAt > now
                && session.AbsoluteExpiresAt > now)
            .FirstAsync();
        if (current?.LastSeenAt is not { } lastSeenAt
            || string.Equals(current.RefreshTokenHash, staleHash, StringComparison.Ordinal))
        {
            return false;
        }

        DateTime rotatedAtUtc = AsUtc(lastSeenAt);
        return rotatedAtUtc <= now && now - rotatedAtUtc <= s_refreshConcurrencyGrace;
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
                    SELECT sessionid,
                           userid
                    FROM sys_user_session
                    WHERE sessionid = @SessionId
                      AND revokedat IS NULL
                      AND refreshtokenhash <> @StaleHash
                    FOR UPDATE
                ),
                revoked AS (
                    UPDATE sys_user_session AS session
                    SET revokedat = @RevokedAt,
                        revokereason = @Reason,
                        session_mode = 2
                    FROM replay_target AS target
                    WHERE session.sessionid = target.sessionid
                      AND session.userid = target.userid
                      AND session.revokedat IS NULL
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
