using System.Runtime.CompilerServices;
using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class AnonymousAccountBootstrapService(
    ISqlSugarClient db,
    IConfiguration configuration,
    ILogger<AnonymousAccountBootstrapService> logger) : IAnonymousAccountBootstrapService
{
    private const int UserStatusNormal = 0;
    private const int MinPublicHandleLength = 3;
    private const int MaxPublicHandleLength = 20;

    public async Task<AnonymousAccountBootstrapResult> BootstrapAsync(
        string? publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await BootstrapAnonymousAccountAsync(publicHandle);
        return new AnonymousAccountBootstrapResult(
            result.Success,
            result.Message,
            result.User is null ? null : UserAccountReader.ToAccountSnapshot(result.User),
            result.EnrollmentToken,
            result.EnrollmentExpiresAt);
    }

    private static string NormalizePublicHandleToken(string input)
    {
        var span = input.AsSpan().Trim();
        if (span.IsEmpty)
            return string.Empty;
        if (span.Length > MaxPublicHandleLength)
            span = span[..MaxPublicHandleLength];
        return string.Create(span.Length, span, static (dst, src) => src.ToLowerInvariant(dst));
    }


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

        if (!FastCharValidator.IsPublicHandle(normalized))
        {
            return (false, null, "公开称呼允许中文、英文字母、数字和 #");
        }

        return (true, normalized, string.Empty);
    }

    public async Task<(bool Success, string Message, User? User, string? EnrollmentToken, DateTime? EnrollmentExpiresAt)> BootstrapAnonymousAccountAsync(string? publicHandle)
    {
        if (!AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, "匿名账号初始化仅在匿名身份模式下可用", null, null, null);
        }

        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message, null, null, null);
        }

        if (handle.PublicHandle is { Length: > 0 } normalizedHandle &&
            await db.Queryable<User>().AnyAsync(u => u.PublicHandle == normalizedHandle))
        {
            return (false, "公开称呼已被占用", null, null, null);
        }

        DateTime now = DateTime.UtcNow;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var newUser = new User
            {
                PublicHandle = handle.PublicHandle,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                RegistrationState = AccountRegistrationStates.Provisional,
                PasskeyEnabled = false,
                RecoveryEnabled = false,
                PrivacyInitializedAt = now,
                AnonymousCredentialLevel = "basic",
                AnonymousCredentialStatus = "active",
                CreateTime = now,
                Status = UserStatusNormal
            };

            string enrollmentToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            DateTime enrollmentExpiresAt = now.Add(ResolveEnrollmentTtl());
            Result<int> insertResult = await BoundaryExecutor.ExecuteResultAsync(
                () => InsertAnonymousAccountWithSubjectAsync(newUser, enrollmentToken, enrollmentExpiresAt),
                ex => ex.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
                      || ex.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase)
                    ? ErrorDetail.Create(ErrorCode.Conflict, "匿名账号初始化冲突，请重试")
                    : ErrorDetail.Create(ErrorCode.InfraFailure, "匿名账号初始化失败，请稍后重试"),
                logger,
                "anonymous-account-bootstrap");

            if (insertResult.IsSuccess && insertResult.Value > 0)
            {
                newUser.Id = insertResult.Value;
                return (true, "匿名账号待绑定首枚通行密钥", newUser, enrollmentToken, enrollmentExpiresAt);
            }

            if (insertResult.Error.Code != ErrorCode.Conflict || handle.PublicHandle is { Length: > 0 })
            {
                return (false, insertResult.Error.Message, null, null, null);
            }
        }

        return (false, "匿名账号初始化冲突，请重试", null, null, null);
    }

    private async Task<int> InsertAnonymousAccountWithSubjectAsync(User user, string enrollmentToken, DateTime enrollmentExpiresAt)
    {
        user.AccountSubjectHash = string.IsNullOrWhiteSpace(user.PublicHandle)
            ? AccountSubjectHasher.Create(
                user.IdentityKind,
                string.Concat("bootstrap:", Convert.ToHexString(RandomNumberGenerator.GetBytes(32))))
            : AccountSubjectHasher.Create(user);

        int accountId = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            accountId = await db.Insertable(user).ExecuteReturnIdentityAsync().ConfigureAwait(false);
            if (accountId <= 0)
            {
                throw new InvalidOperationException("Anonymous account insert did not return an identity.");
            }

            user.Id = accountId;
            string finalSubjectHash = AccountSubjectHasher.Create(user);
            if (!string.Equals(user.AccountSubjectHash, finalSubjectHash, StringComparison.Ordinal))
            {
                int updated = await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE sys_user
                    SET account_subject_hash = @AccountSubjectHash
                    WHERE id = @AccountId;
                    """,
                    new SugarParameter("@AccountSubjectHash", finalSubjectHash),
                    new SugarParameter("@AccountId", accountId)).ConfigureAwait(false);
                if (updated != 1)
                {
                    throw new InvalidOperationException("Anonymous account subject projection was not persisted.");
                }

                user.AccountSubjectHash = finalSubjectHash;
            }

            await db.Insertable(new AccountEnrollmentSession
            {
                TokenHash = HashEnrollmentToken(enrollmentToken),
                AccountId = accountId,
                State = AccountEnrollmentStates.Pending,
                PasskeyUserHandle = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
                CreatedAt = user.CreateTime,
                ExpiresAt = enrollmentExpiresAt
            }).ExecuteCommandAsync().ConfigureAwait(false);
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException
                ?? new InvalidOperationException("Anonymous account creation transaction failed.");
        }

        return accountId;
    }

    internal static string HashEnrollmentToken(string token)
        => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)));

    private TimeSpan ResolveEnrollmentTtl()
    {
        int minutes = configuration.GetValue<int?>("AuthEnrollment:ProvisionalTtlMinutes") ?? 20;
        return TimeSpan.FromMinutes(Math.Clamp(minutes, 15, 30));
    }


    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "匿名账号初始化竞态冲突 | AccountSubject: {AccountSubject}")]
    private partial void LogRegistrationConflict(string accountSubject);
}
