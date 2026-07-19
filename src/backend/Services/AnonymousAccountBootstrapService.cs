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
    ILogger<AnonymousAccountBootstrapService> logger) : IAnonymousAccountBootstrapService
{
    private const int UserStatusNormal = 0;
    private const int MinPublicHandleLength = 3;
    private const int MaxPublicHandleLength = 20;

    public async Task<(bool Success, string Message, UserAccountSnapshot? User)> BootstrapAsync(
        string? publicHandle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var result = await BootstrapAnonymousAccountAsync(publicHandle);
        return (
            result.Success,
            result.Message,
            result.User is null ? null : UserAccountReader.ToAccountSnapshot(result.User));
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

    public async Task<(bool Success, string Message, User? User)> BootstrapAnonymousAccountAsync(string? publicHandle)
    {
        if (!AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled())
        {
            return (false, "匿名账号初始化仅在匿名身份模式下可用", null);
        }

        var handle = NormalizePublicHandle(publicHandle);
        if (!handle.Success)
        {
            return (false, handle.Message, null);
        }

        if (handle.PublicHandle is { Length: > 0 } normalizedHandle &&
            await db.Queryable<User>().AnyAsync(u => u.PublicHandle == normalizedHandle))
        {
            return (false, "公开称呼已被占用", null);
        }

        DateTime now = DateTime.UtcNow;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            var newUser = new User
            {
                PublicHandle = handle.PublicHandle,
                IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
                PasskeyEnabled = false,
                RecoveryEnabled = false,
                PrivacyInitializedAt = now,
                AnonymousCredentialLevel = "basic",
                AnonymousCredentialStatus = "active",
                CreateTime = now,
                Status = UserStatusNormal
            };

            Result<int> insertResult = await BoundaryExecutor.ExecuteResultAsync(
                () => InsertAnonymousAccountWithSubjectAsync(newUser),
                ex => ex.Message.Contains("23505", StringComparison.OrdinalIgnoreCase)
                      || ex.Message.Contains("Unique", StringComparison.OrdinalIgnoreCase)
                    ? ErrorDetail.Create(ErrorCode.Conflict, "匿名账号初始化冲突，请重试")
                    : ErrorDetail.Create(ErrorCode.InfraFailure, "匿名账号初始化失败，请稍后重试"),
                logger,
                "anonymous-account-bootstrap");

            if (insertResult.IsSuccess && insertResult.Value > 0)
            {
                newUser.Id = insertResult.Value;
                return (true, "匿名账号已初始化", newUser);
            }

            if (insertResult.Error.Code != ErrorCode.Conflict || handle.PublicHandle is { Length: > 0 })
            {
                return (false, insertResult.Error.Message, null);
            }
        }

        return (false, "匿名账号初始化冲突，请重试", null);
    }

    private async Task<int> InsertAnonymousAccountWithSubjectAsync(User user)
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
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException
                ?? new InvalidOperationException("Anonymous account creation transaction failed.");
        }

        return accountId;
    }


    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "匿名账号初始化竞态冲突 | AccountSubject: {AccountSubject}")]
    private partial void LogRegistrationConflict(string accountSubject);
}
