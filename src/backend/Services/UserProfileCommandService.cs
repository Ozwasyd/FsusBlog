using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Security;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class UserProfileCommandService(
    ISqlSugarClient db,
    ILogger<UserProfileCommandService> logger,
    IBlacklistService blacklist,
    ICacheInvalidationStore invalidation,
    ICacheCounterStore counters,
    IUserSessionValidationCache sessionValidation) : IUserProfileCommandService
{
    private const int UserStatusNormal = 0;
    private const int UserStatusDeleted = 2;
    private const int MinPublicHandleLength = 3;
    private const int MaxPublicHandleLength = 20;

    public async Task<(bool Success, string Message)> UpdatePublicHandleAsync(
        int userId,
        string? publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message);
        }

        try
        {
            int updated = handle.PublicHandle is null
                ? await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_user
                    SET public_handle = NULL,
                        passkey_signal_version = passkey_signal_version + 1
                    WHERE id = @userId;
                    """,
                    new SugarParameter[] { new("@userId", userId) })
                : await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_user
                    SET public_handle = @publicHandle,
                        passkey_signal_version = passkey_signal_version + 1
                    WHERE id = @userId
                      AND NOT EXISTS (
                          SELECT 1
                          FROM sys_user
                          WHERE public_handle = @publicHandle
                            AND id <> @userId
                      );
                    """,
                    new SugarParameter[]
                    {
                        new("@userId", userId),
                        new("@publicHandle", handle.PublicHandle)
                    });

            if (updated > 0)
            {
                await InvalidateAccountSnapshotAsync(userId, cancellationToken).ConfigureAwait(false);
                return handle.PublicHandle is null
                    ? (true, "公开称呼已清空")
                    : (true, "公开称呼已保存");
            }
        }
        catch (Exception ex) when (IsUniqueViolation(ex))
        {
            return (false, "公开称呼已被占用");
        }

        return await UserExistsAsync(userId)
            ? (false, "公开称呼已被占用")
            : (false, "用户不存在");
    }

    public async Task<(bool Success, string Message)> DeleteAccountAsync(
        int userId,
        DeleteAccountRequestDto dto,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(dto.ConfirmText?.Trim(), "DELETE", StringComparison.Ordinal))
        {
            return (false, "确认文本不匹配");
        }

        User? user = await db.Queryable<User>().InSingleAsync(userId);
        if (user is null)
        {
            return (false, "用户不存在");
        }

        if (user.Status == UserStatusDeleted || user.DeletedAt.HasValue)
        {
            return (false, "账户已注销");
        }

        DateTime deletedAt = DateTime.UtcNow;
        List<UserSessionValidationCacheState> revokedSessions = [];
        bool publicationAttempted = false;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await UserSessionConcurrencyGate.AcquireAsync(db, userId);
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user_session
                SET revokedat = @RevokedAt,
                    revokereason = 'account_deleted'
                WHERE userid = @UserId
                  AND revokedat IS NULL
                RETURNING sessionid,
                          userid,
                          revokedat,
                          idleexpiresat,
                          absoluteexpiresat,
                          xmin::text AS row_version;
                """,
                new SugarParameter("@RevokedAt", deletedAt),
                new SugarParameter("@UserId", userId)))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    revokedSessions.Add(ReadRevokedSessionValidationState(reader));
                }
            }

            await db.Deleteable<PasskeyCredential>()
                .Where(credential => credential.AccountId == userId)
                .ExecuteCommandAsync();
            await db.Updateable<RecoveryKeyCredential>()
                .SetColumns(credential => credential.RevokedAt == deletedAt)
                .Where(credential => credential.AccountId == userId && credential.RevokedAt == null)
                .ExecuteCommandAsync();
            await db.Updateable<AnonymousCredential>()
                .SetColumns(credential => credential.Status == AnonymousCredentialStatuses.Revoked)
                .SetColumns(credential => credential.RevokedAtUtc == deletedAt)
                .Where(credential => credential.AccountId == userId && credential.RevokedAtUtc == null)
                .ExecuteCommandAsync();
            await db.Updateable<User>()
                .SetColumns(account => account.Status == UserStatusDeleted)
                .SetColumns(account => account.PublicHandle == null)
                .SetColumns(account => account.IdentityKind == AnonymousIdentityRuntime.AnonymousAccountKind)
                .SetColumns(account => account.PasskeyEnabled == false)
                .SetColumns(account => account.RecoveryEnabled == false)
                .SetColumns(account => account.AnonymousCredentialStatus == AnonymousCredentialStatuses.Revoked)
                .SetColumns(account => account.MfaEnabled == false)
                .SetColumns(account => account.RiskFlags == 0)
                .SetColumns(account => account.BanReason == null)
                .SetColumns(account => account.DeletedAt == deletedAt)
                .SetColumns(account => account.DeletedReason == "self-service")
                .Where(account => account.Id == userId)
                .ExecuteCommandAsync();
            await db.Updateable<UserMfaProfile>()
                .SetColumns(profile => profile.MfaSecretEncrypted == null)
                .SetColumns(profile => profile.MfaPendingSecretEncrypted == null)
                .SetColumns(profile => profile.MfaPendingCreatedAt == null)
                .SetColumns(profile => profile.MfaRecoveryCodesHash == null)
                .SetColumns(profile => profile.MfaVerifiedAt == null)
                .SetColumns(profile => profile.UpdatedAtUtc == deletedAt)
                .Where(profile => profile.UserId == userId)
                .ExecuteCommandAsync();

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

            logger.LogError(transaction.ErrorException, "Delete account transaction failed for user {UserId}", userId);
            return (false, "账户注销失败，请稍后重试");
        }

        await blacklist.UnbanUserAsync(userId);
        await invalidation.RemoveAsync(CachePolicyId.SecurityBlockedUser, userId.ToString());
        await InvalidateAccountSnapshotAsync(userId, cancellationToken).ConfigureAwait(false);
        return (true, "账户已注销");
    }

    private Task InvalidateAccountSnapshotAsync(int userId, CancellationToken cancellationToken)
        => AccountSnapshotCacheInvalidator.BumpVersionAsync(counters, userId, cancellationToken);

    private async Task<bool> UserExistsAsync(int userId)
        => await db.Ado.GetIntAsync(
            """
            SELECT COUNT(1)
            FROM sys_user
            WHERE id = @userId;
            """,
            new SugarParameter[] { new("@userId", userId) }) > 0;

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

    private static (bool Success, string? PublicHandle, string Message) NormalizePublicHandle(string? publicHandle)
    {
        if (string.IsNullOrWhiteSpace(publicHandle))
        {
            return (true, null, string.Empty);
        }

        string normalized = NormalizePublicHandleToken(publicHandle);
        if (normalized.Length < MinPublicHandleLength || normalized.Length > MaxPublicHandleLength)
        {
            return (false, null, $"公开称呼长度必须在 {MinPublicHandleLength}-{MaxPublicHandleLength} 个字符之间");
        }

        return FastCharValidator.IsPublicHandle(normalized)
            ? (true, normalized, string.Empty)
            : (false, null, "公开称呼允许中文、英文字母、数字和 #");
    }

    private static string NormalizePublicHandleToken(string input)
    {
        ReadOnlySpan<char> span = input.AsSpan().Trim();
        if (span.IsEmpty)
        {
            return string.Empty;
        }

        if (span.Length > MaxPublicHandleLength)
        {
            span = span[..MaxPublicHandleLength];
        }

        return string.Create(span.Length, span, static (destination, source) => source.ToLowerInvariant(destination));
    }

    private static bool IsUniqueViolation(Exception exception)
        => exception is PostgresException postgres
            && string.Equals(postgres.SqlState, PostgresErrorCodes.UniqueViolation, StringComparison.Ordinal)
            || exception.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
            || exception.Message.Contains("Duplicate", StringComparison.OrdinalIgnoreCase)
            || exception.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase);
}
