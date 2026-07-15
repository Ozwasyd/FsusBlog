using Fido2NetLib;
using Fido2NetLib.Exceptions;
using Fido2NetLib.Objects;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;
using System.Diagnostics;
using System.Buffers.Binary;
using System.Buffers.Text;
using System.Data.Common;
using System.Security.Cryptography;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IPasskeyService
{
    Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync(int accountId, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message)> CompleteRegistrationAsync(int accountId, PasskeyRegisterCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<RecoveryPasskeyRegistrationResult> CompleteRecoveryRegistrationAsync(
        RecoveryKeySession session,
        string recoverySessionHash,
        string recoveryRequestHash,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken = default);
    Task<RecoveryPasskeyRegistrationResult?> TryResolveRecoveryRegistrationAsync(
        string recoverySessionHash,
        string recoveryRequestHash,
        string registrationSessionKey,
        CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAssertionAsync(CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, User? User)> CompleteAssertionAsync(PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginStepUpAssertionAsync(int accountId, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message)> CompleteStepUpAssertionAsync(int accountId, PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginActionStepUpAssertionAsync(int accountId, string action, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, string Action)> CompleteActionStepUpAssertionAsync(int accountId, PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int accountId, CancellationToken cancellationToken = default);
    Task<PasskeyCredentialMutationResult> RemoveCredentialAsync(int accountId, int credId, CancellationToken cancellationToken = default);
    Task<bool> RenameCredentialAsync(int accountId, int credId, string name, CancellationToken cancellationToken = default);
}

public sealed record PasskeyRegBeginData(PasskeyRegisterBeginCoreModel Options);
public sealed record PasskeyAuthBeginData(PasskeyLoginBeginCoreModel Options);
public enum RecoveryPasskeyRegistrationStatus
{
    Completed,
    AlreadyCompleted,
    ValidationFailed,
    Conflict,
    RetryableFailure
}

public readonly record struct RecoveryPasskeyRegistrationResult(
    RecoveryPasskeyRegistrationStatus Status,
    string Message)
{
    public bool IsSuccess => Status is RecoveryPasskeyRegistrationStatus.Completed or RecoveryPasskeyRegistrationStatus.AlreadyCompleted;

    public static RecoveryPasskeyRegistrationResult Completed()
        => new(RecoveryPasskeyRegistrationStatus.Completed, "通行密钥注册成功");

    public static RecoveryPasskeyRegistrationResult AlreadyCompleted()
        => new(RecoveryPasskeyRegistrationStatus.AlreadyCompleted, "RECOVERY_PASSKEY_ALREADY_COMPLETED");

    public static RecoveryPasskeyRegistrationResult ValidationFailed(string message)
        => new(RecoveryPasskeyRegistrationStatus.ValidationFailed, message);

    public static RecoveryPasskeyRegistrationResult Conflict(string message)
        => new(RecoveryPasskeyRegistrationStatus.Conflict, message);

    public static RecoveryPasskeyRegistrationResult RetryableFailure()
        => new(RecoveryPasskeyRegistrationStatus.RetryableFailure, "RECOVERY_PASSKEY_RETRYABLE");
}

internal readonly record struct PasskeyAccountMetadata(string Name, string DisplayName, byte[] UserHandle);
internal sealed record PasskeyAssertionState(PasskeyCredential Credential, User User, string RowVersion);
internal readonly record struct PasskeyDeleteState(bool UserFound, bool CredentialFound, bool Deleted, int Remaining);
internal sealed record PasskeyRegistrationValidationResult(bool Success, string Message, PasskeyCredential? Credential)
{
    public static PasskeyRegistrationValidationResult Rejected(string message) => new(false, message, null);

    public static PasskeyRegistrationValidationResult Accepted(PasskeyCredential credential) => new(true, "通行密钥验证成功", credential);
}
public readonly record struct PasskeyCredentialMutationResult(bool Success, string Message, bool NotFound)
{
    public static PasskeyCredentialMutationResult Succeeded(string message) => new(true, message, false);
    public static PasskeyCredentialMutationResult Missing(string message) => new(false, message, true);
    public static PasskeyCredentialMutationResult Rejected(string message) => new(false, message, false);
}

public sealed class PasskeyService(
    IFido2 fido2,
    ISqlSugarClient db,
    IUnifiedCache cache,
    IUserSessionCommandService sessions,
    IMessageNotificationStreamPort notificationStream,
    IAuditEventService auditEvents,
    ILogger<PasskeyService> logger) : IPasskeyService
{
    private const int MaxCredentialsPerUser = 5;
    private const int PasskeyUserHandleBytes = 32;
    private const string AnonymousPasskeyAccountName = "fsus-anonymous-account";
    private const string AnonymousPasskeyDisplayName = "Anonymous account";
    public const string CannotRemoveLastCredentialWithoutRecovery = "CannotRemoveLastCredentialWithoutRecovery";
    private const string CounterRollbackReason = "passkey_counter_rollback";

    // ─────────────────────────────────────────────────────────────────────
    // Registration
    // ─────────────────────────────────────────────────────────────────────

    public async Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync(int accountId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? user = await db.Queryable<User>().InSingleAsync(accountId);
        if (user is null || user.DeletedAt.HasValue || user.Status == 2)
        {
            return (false, "账户不存在或已注销", null);
        }

        var existingCreds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == accountId)
            .Select(c => c.CredentialId)
            .Take(MaxCredentialsPerUser + 1)
            .ToListAsync();

        if (existingCreds.Count >= MaxCredentialsPerUser)
        {
            return (false, $"每位用户最多只能注册 {MaxCredentialsPerUser} 枚通行密钥", null);
        }

        var excludeCredentials = existingCreds
            .Select(id => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(id)))
            .ToList();

        byte[] stableUserHandle = await GetOrCreateStablePasskeyUserHandleAsync(user, cancellationToken);
        PasskeyAccountMetadata accountMetadata = BuildAnonymousSafeMetadata(
            user.PublicHandle,
            AnonymousIdentityRuntime.IsAnonymousIdentityModeEnabled(),
            stableUserHandle);

        var fidoUser = new Fido2User
        {
            Id = accountMetadata.UserHandle,
            Name = accountMetadata.Name,
            DisplayName = accountMetadata.DisplayName
        };

        var authenticatorSelection = new AuthenticatorSelection
        {
            ResidentKey = ResidentKeyRequirement.Required,
            UserVerification = UserVerificationRequirement.Required
        };

        var options = fido2.RequestNewCredential(new RequestNewCredentialParams
        {
            User = fidoUser,
            ExcludeCredentials = excludeCredentials,
            AuthenticatorSelection = authenticatorSelection,
            AttestationPreference = AttestationConveyancePreference.None
        });

        string sessionKey = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var coreOptions = ToRegisterBeginCore(sessionKey, options);

        await cache.SetRawAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            sessionKey,
            PodBinaryCodec.EncodePasskeyRegisterBegin(coreOptions),
            TimeSpan.FromMinutes(5),
            cancellationToken);

        return (true, "已生成注册选项", new PasskeyRegBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message)> CompleteRegistrationAsync(
        int accountId,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken = default)
    {
        PasskeyRegistrationValidationResult validation = await ValidateRegistrationAsync(accountId, request, cancellationToken);
        if (!validation.Success || validation.Credential is null)
        {
            return (false, validation.Message);
        }

        await db.Insertable(validation.Credential).ExecuteCommandAsync();
        await db.Updateable<User>()
            .Where(u => u.Id == accountId)
            .SetColumns(u => u.PasskeyEnabled == true)
            .ExecuteCommandAsync();
        await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, accountId, cancellationToken).ConfigureAwait(false);
        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, request.SessionKey, cancellationToken);

        return (true, "通行密钥注册成功");
    }

    public async Task<RecoveryPasskeyRegistrationResult> CompleteRecoveryRegistrationAsync(
        RecoveryKeySession session,
        string recoverySessionHash,
        string recoveryRequestHash,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (session.AccountId <= 0 ||
            !IsSha256Hex(recoverySessionHash) ||
            !IsSha256Hex(recoveryRequestHash))
        {
            return RecoveryPasskeyRegistrationResult.Conflict("RECOVERY_PASSKEY_COMPLETION_INVALID");
        }

        RecoveryPasskeyRegistrationResult? replay = await ResolveRecoveryCompletionAsync(
            recoverySessionHash,
            recoveryRequestHash,
            cancellationToken);
        if (replay is { } existing)
        {
            if (existing.IsSuccess)
            {
                await FinalizeRegistrationCachesAsync(session.AccountId, request.SessionKey, cancellationToken);
            }
            return existing;
        }

        PasskeyRegistrationValidationResult validation;
        try
        {
            validation = await ValidateRegistrationAsync(session.AccountId, request, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(
                exception,
                "Recovery Passkey validation dependency failed. RecoverySessionHash={RecoverySessionHash} ExceptionType={ExceptionType}",
                ShortHash(recoverySessionHash),
                exception.GetType().Name);
            return RecoveryPasskeyRegistrationResult.RetryableFailure();
        }

        if (!validation.Success || validation.Credential is null)
        {
            return RecoveryPasskeyRegistrationResult.ValidationFailed(validation.Message);
        }

        return await PersistRecoveryRegistrationAsync(
            session,
            recoverySessionHash,
            recoveryRequestHash,
            request.SessionKey,
            validation.Credential,
            cancellationToken).ConfigureAwait(false);
    }

    internal async Task<RecoveryPasskeyRegistrationResult> PersistRecoveryRegistrationAsync(
        RecoveryKeySession session,
        string recoverySessionHash,
        string recoveryRequestHash,
        string registrationSessionKey,
        PasskeyCredential credential,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RecoveryPasskeyRegistrationResult? replay = await ResolveRecoveryCompletionAsync(
            recoverySessionHash,
            recoveryRequestHash,
            cancellationToken);
        if (replay is { } existing)
        {
            if (existing.IsSuccess)
            {
                await FinalizeRegistrationCachesAsync(session.AccountId, registrationSessionKey, cancellationToken);
            }
            return existing;
        }

        credential.RecoverySessionHash = recoverySessionHash;
        credential.RecoveryRequestHash = recoveryRequestHash;
        RecoveryPasskeyRegistrationResult? concurrentOutcome = null;
        SqlSugar.DbResult<bool> transaction;
        try
        {
            transaction = await db.Ado.UseTranAsync(async () =>
            {
                concurrentOutcome = await ResolveRecoveryCompletionAsync(
                    recoverySessionHash,
                    recoveryRequestHash,
                    cancellationToken);
                if (concurrentOutcome is not null)
                {
                    return;
                }

                credential.Id = await db.Insertable(credential).ExecuteReturnIdentityAsync();
                if (session.RevokePasskeys)
                {
                    await db.Deleteable<PasskeyCredential>()
                        .Where(item => item.AccountId == session.AccountId &&
                            item.Id != credential.Id &&
                            item.CreatedAt < session.IssuedAtUtc)
                        .ExecuteCommandAsync();
                }

                int userUpdated = await db.Updateable<User>()
                    .SetColumns(user => user.PasskeyEnabled == true)
                    .Where(user => user.Id == session.AccountId && user.Status != 2 && user.DeletedAt == null)
                    .ExecuteCommandAsync();
                if (userUpdated != 1)
                {
                    throw new InvalidOperationException("Recovery account is no longer available.");
                }
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger.LogWarning(
                exception,
                "Recovery Passkey persistence failed before commit. RecoverySessionHash={RecoverySessionHash} ExceptionType={ExceptionType}",
                ShortHash(recoverySessionHash),
                exception.GetType().Name);
            return RecoveryPasskeyRegistrationResult.RetryableFailure();
        }

        RecoveryPasskeyRegistrationResult outcome;
        if (!transaction.IsSuccess)
        {
            RecoveryPasskeyRegistrationResult? committed = await ResolveRecoveryCompletionAsync(
                recoverySessionHash,
                recoveryRequestHash,
                cancellationToken);
            if (committed is null)
            {
                logger.LogWarning(
                    transaction.ErrorException,
                    "Recovery Passkey transaction rolled back. RecoverySessionHash={RecoverySessionHash}",
                    ShortHash(recoverySessionHash));
                return RecoveryPasskeyRegistrationResult.RetryableFailure();
            }
            outcome = committed.Value;
        }
        else
        {
            outcome = concurrentOutcome ?? RecoveryPasskeyRegistrationResult.Completed();
        }

        if (outcome.IsSuccess)
        {
            await FinalizeRegistrationCachesAsync(session.AccountId, registrationSessionKey, cancellationToken);
        }
        return outcome;
    }

    public async Task<RecoveryPasskeyRegistrationResult?> TryResolveRecoveryRegistrationAsync(
        string recoverySessionHash,
        string recoveryRequestHash,
        string registrationSessionKey,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PasskeyCredential? completed = await db.Queryable<PasskeyCredential>()
            .Where(item => item.RecoverySessionHash == recoverySessionHash)
            .FirstAsync();
        if (completed is null)
        {
            return null;
        }

        if (!string.Equals(completed.RecoveryRequestHash, recoveryRequestHash, StringComparison.Ordinal))
        {
            return RecoveryPasskeyRegistrationResult.Conflict(
                "RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST");
        }

        await FinalizeRegistrationCachesAsync(completed.AccountId, registrationSessionKey, cancellationToken);
        return RecoveryPasskeyRegistrationResult.AlreadyCompleted();
    }

    private async Task<PasskeyRegistrationValidationResult> ValidateRegistrationAsync(
        int accountId,
        PasskeyRegisterCompleteCoreModel request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var cached = await cache.TryGetAsync<PasskeyRegisterBeginCoreModel>(
            CachePolicyId.SecurityPasskeyRegChallenge,
            request.SessionKey,
            static bytes => PodBinaryCodec.TryDecodePasskeyRegisterBegin(bytes, out var options)
                ? (true, options)
                : (false, null),
            cancellationToken);
        if (!cached.Hit || cached.Value is null)
        {
            return PasskeyRegistrationValidationResult.Rejected("注册会话已过期，请重新开始");
        }

        int existingCount = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == accountId)
            .CountAsync();
        if (existingCount >= MaxCredentialsPerUser)
        {
            return PasskeyRegistrationValidationResult.Rejected($"已达到 {MaxCredentialsPerUser} 枚通行密钥上限");
        }

        RegisteredPublicKeyCredential result;
        try
        {
            result = await fido2.MakeNewCredentialAsync(
                new MakeNewCredentialParams
                {
                    AttestationResponse = ToAttestationResponse(request),
                    OriginalOptions = ToCredentialCreateOptions(cached.Value),
                    IsCredentialIdUniqueToUserCallback = IsCredentialIdUniqueAsync
                },
                cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey registration failed. AccountSubjectHash={AccountSubjectHash} SessionKeyHash={SessionKeyHash} ExceptionType={ExceptionType}",
                await ResolveAccountSubjectHashForLogAsync(accountId, cancellationToken),
                HashForLog(request.SessionKey),
                ex.GetType().Name);
            return PasskeyRegistrationValidationResult.Rejected("通行密钥验证失败，请重试");
        }

        string? transports = result.Transports is { Length: > 0 }
            ? string.Join(",", result.Transports.Select(static value => value.ToEnumMemberValue()))
            : null;
        string? friendlyName = string.IsNullOrWhiteSpace(request.FriendlyName)
            ? null
            : request.FriendlyName.Trim()[..Math.Min(64, request.FriendlyName.Trim().Length)];

        return PasskeyRegistrationValidationResult.Accepted(new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = Base64Url.EncodeToString(result.Id),
            PublicKey = Base64Url.EncodeToString(result.PublicKey),
            SignCount = (long)result.SignCount,
            DeviceFriendlyName = friendlyName,
            AaGuid = Guid.Empty.ToString(),
            Transports = transports,
            BackupEligible = result.IsBackupEligible,
            BackupState = result.IsBackedUp,
            CreatedAt = DateTime.UtcNow
        });
    }

    private async Task<RecoveryPasskeyRegistrationResult?> ResolveRecoveryCompletionAsync(
        string recoverySessionHash,
        string recoveryRequestHash,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PasskeyCredential? completed = await db.Queryable<PasskeyCredential>()
            .Where(item => item.RecoverySessionHash == recoverySessionHash)
            .FirstAsync();
        if (completed is null)
        {
            return null;
        }

        return string.Equals(completed.RecoveryRequestHash, recoveryRequestHash, StringComparison.Ordinal)
            ? RecoveryPasskeyRegistrationResult.AlreadyCompleted()
            : RecoveryPasskeyRegistrationResult.Conflict("RECOVERY_PASSKEY_ALREADY_COMPLETED_WITH_DIFFERENT_REQUEST");
    }

    private async Task FinalizeRegistrationCachesAsync(
        int accountId,
        string registrationSessionKey,
        CancellationToken cancellationToken)
    {
        await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, accountId, cancellationToken).ConfigureAwait(false);
        await cache.RemoveAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            registrationSessionKey,
            cancellationToken).ConfigureAwait(false);
    }

    private static bool IsSha256Hex(string value)
        => value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'A' and <= 'F');

    private static string ShortHash(string value)
        => value.Length <= 16 ? value : value[..16];

    private async Task<bool> IsCredentialIdUniqueAsync(IsCredentialIdUniqueToUserParams param, CancellationToken ct)
    {
        string credId = Base64Url.EncodeToString(param.CredentialId);
        int count = await db.Queryable<PasskeyCredential>()
            .Where(c => c.CredentialId == credId)
            .CountAsync();
        return count == 0;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Authentication
    // ─────────────────────────────────────────────────────────────────────

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAssertionAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        // Discoverable credential — no allowCredentials, usernameless flow
        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required
        });

        string challengeToken = GenerateChallengeToken();
        var coreOptions = ToLoginBeginCore(challengeToken, options);
        await cache.SetRawAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            challengeToken,
            PodBinaryCodec.EncodePasskeyLoginBegin(coreOptions),
            TimeSpan.FromMinutes(5),
            cancellationToken);

        return (true, "已生成认证选项", new PasskeyAuthBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message, User? User)> CompleteAssertionAsync(PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default)
    {
        long started = Stopwatch.GetTimestamp();
        cancellationToken.ThrowIfCancellationRequested();
        var cached = await cache.TryGetAsync<PasskeyLoginBeginCoreModel>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            request.ChallengeToken,
            static bytes => PodBinaryCodec.TryDecodePasskeyLoginBegin(bytes, out var options)
                ? (true, options)
                : (false, null),
            cancellationToken);
        if (!cached.Hit || cached.Value is null)
        {
            return (false, "认证会话已过期，请重新开始", null);
        }

        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyAuthChallenge, request.ChallengeToken, cancellationToken);

        var options = ToAssertionOptions(cached.Value);
        if (options.UserVerification != UserVerificationRequirement.Required)
        {
            return (false, "通行密钥验证失败，请重试", null);
        }

        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);

        string credentialIdBase64 = assertionResponse.Id;
        PasskeyAssertionState? assertionState = await LoadPasskeyAssertionStateAsync(credentialIdBase64, accountId: null, cancellationToken);

        if (assertionState is null)
        {
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "credential_not_found");
            return (false, "未找到对应的通行密钥", null);
        }

        PasskeyCredential storedCred = assertionState.Credential;
        User user = assertionState.User;

        if (user.Status == 2 || user.DeletedAt.HasValue)
        {
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "account_deleted");
            return (false, "账户不存在或已注销", null);
        }

        string? storedUserHandle = user.PasskeyUserHandle;
        byte[] storedPublicKey = Base64Url.DecodeFromChars(storedCred.PublicKey);
        long expectedSignCount = storedCred.SignCount;

        VerifyAssertionResult verifyResult;
        try
        {
            verifyResult = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertionResponse,
                OriginalOptions = options,
                StoredPublicKey = storedPublicKey,
                StoredSignatureCounter = (uint)storedCred.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (param, ct) =>
                    Task.FromResult(IsUserHandleOwnerOfCredential(param.UserHandle, storedUserHandle))
            });
        }
        catch (Fido2VerificationException ex) when (ex.Code == Fido2ErrorCode.InvalidSignCount)
        {
            long actualSignCount = ReadAuthenticatorSignCount(request.AuthenticatorData);
            await RespondToCounterRollbackAsync(
                user,
                storedCred,
                expectedSignCount,
                actualSignCount,
                "login",
                cancellationToken);
            FsusObservability.RecordPasskeySignCountConflict("login");
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), CounterRollbackReason);
            return (false, "通行密钥验证失败，请重新认证", null);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash} AccountSubjectHash={AccountSubjectHash} ExceptionType={ExceptionType}",
                HashForLog(request.ChallengeToken),
                HashForLog(credentialIdBase64),
                ResolveAccountSubjectHashForLog(user),
                ex.GetType().Name);
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "verify_failed");
            return (false, "通行密钥验证失败，请重试", null);
        }

        long verifiedSignCount = verifyResult.SignCount;
        if (!IsPasskeySignCountValid(expectedSignCount, verifiedSignCount))
        {
            await RespondToCounterRollbackAsync(
                user,
                storedCred,
                expectedSignCount,
                verifiedSignCount,
                "login",
                cancellationToken);
            FsusObservability.RecordPasskeySignCountConflict("login");
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), CounterRollbackReason);
            return (false, "通行密钥验证失败，请重新认证", null);
        }

        if (!await TryUpdatePasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, verifiedSignCount, DateTime.UtcNow, cancellationToken))
        {
            FsusObservability.RecordPasskeySignCountConflict("login");
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "sign_count_conflict");
            return (false, "通行密钥验证失败，请重试", null);
        }

        FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "success");
        return (true, "验证成功", user);
    }

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginStepUpAssertionAsync(
        int accountId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (accountId <= 0)
        {
            return (false, "用户会话无效", null);
        }

        User? user = await db.Queryable<User>().InSingleAsync(accountId);
        if (user is null || user.DeletedAt.HasValue || user.Status == 2)
        {
            return (false, "账户不存在或已注销", null);
        }

        List<string> credentialIds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == accountId)
            .Select(c => c.CredentialId)
            .ToListAsync();
        if (credentialIds.Count == 0)
        {
            return (false, "账户未注册通行密钥", null);
        }

        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [.. credentialIds.Select(static id => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(id)))],
            UserVerification = UserVerificationRequirement.Required
        });

        string challengeToken = GenerateChallengeToken();
        var coreOptions = ToLoginBeginCore(challengeToken, options);
        await cache.SetRawAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            StepUpChallengeIdentity(challengeToken),
            PodBinaryCodec.EncodePasskeyLoginBegin(coreOptions),
            TimeSpan.FromMinutes(5),
            cancellationToken);

        return (true, "已生成 step-up 认证选项", new PasskeyAuthBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message)> CompleteStepUpAssertionAsync(
        int accountId,
        PasskeyLoginCompleteCoreModel request,
        CancellationToken cancellationToken = default)
    {
        long started = Stopwatch.GetTimestamp();
        cancellationToken.ThrowIfCancellationRequested();
        if (accountId <= 0)
        {
            return (false, "用户会话无效");
        }

        var cached = await cache.ConsumeOnceAndGetAsync<PasskeyLoginBeginCoreModel>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            StepUpChallengeIdentity(request.ChallengeToken),
            static bytes => PodBinaryCodec.TryDecodePasskeyLoginBegin(bytes, out var options)
                ? (true, options)
                : (false, null),
            cancellationToken);
        if (!cached.Hit || cached.Value is null)
        {
            return (false, "step-up 认证会话已过期，请重新开始");
        }

        var options = ToAssertionOptions(cached.Value);
        if (options.UserVerification != UserVerificationRequirement.Required)
        {
            return (false, "通行密钥 step-up 验证失败，请重试");
        }

        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);
        string credentialIdBase64 = assertionResponse.Id;
        PasskeyAssertionState? assertionState = await LoadPasskeyAssertionStateAsync(credentialIdBase64, accountId, cancellationToken);
        if (assertionState is null)
        {
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "credential_not_found");
            return (false, "未找到当前用户的通行密钥");
        }

        PasskeyCredential storedCred = assertionState.Credential;
        User user = assertionState.User;
        if (user.Status == 2 || user.DeletedAt.HasValue)
        {
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "account_deleted");
            return (false, "账户不存在或已注销");
        }

        string? storedUserHandle = user.PasskeyUserHandle;
        byte[] storedPublicKey = Base64Url.DecodeFromChars(storedCred.PublicKey);
        long expectedSignCount = storedCred.SignCount;
        VerifyAssertionResult verifyResult;
        try
        {
            verifyResult = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertionResponse,
                OriginalOptions = options,
                StoredPublicKey = storedPublicKey,
                StoredSignatureCounter = (uint)storedCred.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (param, ct) =>
                    Task.FromResult(IsUserHandleOwnerOfCredential(param.UserHandle, storedUserHandle))
            });
        }
        catch (Fido2VerificationException ex) when (ex.Code == Fido2ErrorCode.InvalidSignCount)
        {
            long actualSignCount = ReadAuthenticatorSignCount(request.AuthenticatorData);
            await RespondToCounterRollbackAsync(
                user,
                storedCred,
                expectedSignCount,
                actualSignCount,
                "step_up",
                cancellationToken);
            FsusObservability.RecordPasskeySignCountConflict("step_up");
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), CounterRollbackReason);
            return (false, "通行密钥 step-up 验证失败，请重新认证");
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey step-up assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash} AccountSubjectHash={AccountSubjectHash} ExceptionType={ExceptionType}",
                HashForLog(request.ChallengeToken),
                HashForLog(credentialIdBase64),
                await ResolveAccountSubjectHashForLogAsync(accountId, cancellationToken),
                ex.GetType().Name);
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "verify_failed");
            return (false, "通行密钥 step-up 验证失败，请重试");
        }

        long verifiedSignCount = verifyResult.SignCount;
        if (!IsPasskeySignCountValid(expectedSignCount, verifiedSignCount))
        {
            await RespondToCounterRollbackAsync(
                user,
                storedCred,
                expectedSignCount,
                verifiedSignCount,
                "step_up",
                cancellationToken);
            FsusObservability.RecordPasskeySignCountConflict("step_up");
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), CounterRollbackReason);
            return (false, "通行密钥 step-up 验证失败，请重新认证");
        }

        if (!await TryUpdatePasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, verifiedSignCount, DateTime.UtcNow, cancellationToken))
        {
            FsusObservability.RecordPasskeySignCountConflict("step_up");
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "sign_count_conflict");
            return (false, "通行密钥 step-up 验证失败，请重试");
        }

        FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "success");
        return (true, "step-up 验证成功");
    }

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginActionStepUpAssertionAsync(
        int accountId,
        string action,
        CancellationToken cancellationToken = default)
    {
        string normalizedAction = NormalizeStepUpAction(action);
        if (!UserSecurityStepUpActions.IsCredentialMutation(normalizedAction))
        {
            return (false, "STEP_UP_ACTION_UNSUPPORTED", null);
        }

        var result = await BeginStepUpAssertionAsync(accountId, cancellationToken).ConfigureAwait(false);
        if (!result.Success || result.Data is null)
        {
            return result;
        }

        await cache.SetStringAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            StepUpActionIdentity(result.Data.Options.ChallengeToken),
            normalizedAction,
            TimeSpan.FromMinutes(5),
            cancellationToken).ConfigureAwait(false);

        return result;
    }

    public async Task<(bool Success, string Message, string Action)> CompleteActionStepUpAssertionAsync(
        int accountId,
        PasskeyLoginCompleteCoreModel request,
        CancellationToken cancellationToken = default)
    {
        var result = await CompleteStepUpAssertionAsync(accountId, request, cancellationToken).ConfigureAwait(false);
        if (!result.Success)
        {
            return (false, result.Message, string.Empty);
        }

        var action = await cache.ConsumeOnceAndGetAsync<string>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            StepUpActionIdentity(request.ChallengeToken),
            static bytes => (true, System.Text.Encoding.UTF8.GetString(bytes.Span)),
            cancellationToken).ConfigureAwait(false);

        string normalizedAction = NormalizeStepUpAction(action.Value);
        if (!action.Hit || !UserSecurityStepUpActions.IsCredentialMutation(normalizedAction))
        {
            return (false, "STEP_UP_ACTION_INVALID", string.Empty);
        }

        return (true, result.Message, normalizedAction);
    }

    private async Task<PasskeyAssertionState?> LoadPasskeyAssertionStateAsync(
        string credentialId,
        int? accountId,
        CancellationToken cancellationToken)
    {
        string accountPredicate = accountId.HasValue ? " AND pc.account_id = @AccountId" : string.Empty;
        string sql = $$"""
            SELECT pc.id AS credential_row_id,
                   pc.account_id AS account_id,
                   pc.credentialid AS credential_id,
                   pc.publickey AS public_key,
                   pc.signcount AS sign_count,
                   pc.aaguid AS aa_guid,
                   pc.xmin::text AS row_version,
                   u.id AS user_id,
                   u.public_handle AS public_handle,
                   u.identity_kind AS identity_kind,
                   u.account_subject_hash AS account_subject_hash,
                   u.passkey_enabled AS passkey_enabled,
                   u.passkey_user_handle AS passkey_user_handle,
                   u.recovery_enabled AS recovery_enabled,
                   u.status AS user_status,
                   u.deleted_at AS deleted_at
            FROM passkey_credential pc
            JOIN sys_user u ON u.id = pc.account_id
            WHERE pc.credentialid = @CredentialId{{accountPredicate}}
            LIMIT 1;
            """;
        var parameters = new List<SugarParameter>
        {
            new("@CredentialId", credentialId)
        };
        if (accountId.HasValue)
        {
            parameters.Add(new SugarParameter("@AccountId", accountId.Value));
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters.ToArray());
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var credential = new PasskeyCredential
        {
            Id = reader.GetInt32(reader.GetOrdinal("credential_row_id")),
            AccountId = reader.GetInt32(reader.GetOrdinal("account_id")),
            CredentialId = reader.GetString(reader.GetOrdinal("credential_id")),
            PublicKey = reader.GetString(reader.GetOrdinal("public_key")),
            SignCount = reader.GetInt64(reader.GetOrdinal("sign_count")),
            AaGuid = reader.GetString(reader.GetOrdinal("aa_guid"))
        };
        string rowVersion = reader.GetString(reader.GetOrdinal("row_version"));
        var user = new User
        {
            Id = reader.GetInt32(reader.GetOrdinal("user_id")),
            PublicHandle = reader.IsDBNull(reader.GetOrdinal("public_handle")) ? null : reader.GetString(reader.GetOrdinal("public_handle")),
            IdentityKind = reader.IsDBNull(reader.GetOrdinal("identity_kind"))
                ? AnonymousIdentityRuntime.AnonymousAccountKind
                : reader.GetString(reader.GetOrdinal("identity_kind")),
            AccountSubjectHash = reader.IsDBNull(reader.GetOrdinal("account_subject_hash"))
                ? null
                : reader.GetString(reader.GetOrdinal("account_subject_hash")),
            PasskeyEnabled = !reader.IsDBNull(reader.GetOrdinal("passkey_enabled")) && reader.GetBoolean(reader.GetOrdinal("passkey_enabled")),
            PasskeyUserHandle = reader.IsDBNull(reader.GetOrdinal("passkey_user_handle")) ? null : reader.GetString(reader.GetOrdinal("passkey_user_handle")),
            RecoveryEnabled = !reader.IsDBNull(reader.GetOrdinal("recovery_enabled")) && reader.GetBoolean(reader.GetOrdinal("recovery_enabled")),
            Status = reader.GetInt32(reader.GetOrdinal("user_status")),
            DeletedAt = reader.IsDBNull(reader.GetOrdinal("deleted_at")) ? null : reader.GetDateTime(reader.GetOrdinal("deleted_at"))
        };

        return new PasskeyAssertionState(credential, user, rowVersion);
    }

    private static PasskeyRegisterBeginCoreModel ToRegisterBeginCore(string sessionKey, CredentialCreateOptions options)
        => new()
        {
            SessionKey = sessionKey,
            Timeout = options.Timeout,
            Attestation = (int)options.Attestation,
            ResidentKey = (int)options.AuthenticatorSelection.ResidentKey,
            UserVerification = (int)options.AuthenticatorSelection.UserVerification,
            AuthenticatorAttachment = options.AuthenticatorSelection.AuthenticatorAttachment.HasValue ? (int)options.AuthenticatorSelection.AuthenticatorAttachment.Value : null,
            RequireResidentKey = options.AuthenticatorSelection.ResidentKey == ResidentKeyRequirement.Required,
            RpId = options.Rp.Id ?? string.Empty,
            RpName = options.Rp.Name,
            AccountName = options.User.Name,
            AccountDisplayName = options.User.DisplayName,
            AccountHandle = options.User.Id,
            Challenge = options.Challenge,
            PubKeyCredParams = [.. options.PubKeyCredParams.Select(param => new PasskeyPublicKeyCredentialParamCoreModel((int)param.Type, (int)param.Alg))],
            ExcludeCredentials = [.. options.ExcludeCredentials.Select(ToDescriptorCore)]
        };

    private static CredentialCreateOptions ToCredentialCreateOptions(PasskeyRegisterBeginCoreModel value)
        => new()
        {
            Rp = new PublicKeyCredentialRpEntity(value.RpId, value.RpName, null),
            User = new Fido2User { Id = value.AccountHandle, Name = value.AccountName, DisplayName = value.AccountDisplayName },
            Challenge = value.Challenge,
            Timeout = value.Timeout,
            Attestation = (AttestationConveyancePreference)value.Attestation,
            AuthenticatorSelection = new AuthenticatorSelection
            {
                AuthenticatorAttachment = value.AuthenticatorAttachment.HasValue ? (AuthenticatorAttachment)value.AuthenticatorAttachment.Value : null,
                ResidentKey = (ResidentKeyRequirement)value.ResidentKey,
                UserVerification = (UserVerificationRequirement)value.UserVerification
            },
            PubKeyCredParams = [.. value.PubKeyCredParams.Select(param => new PubKeyCredParam((COSE.Algorithm)param.Alg, (PublicKeyCredentialType)param.Type))],
            ExcludeCredentials = [.. value.ExcludeCredentials.Select(ToDescriptor)]
        };

    private static PasskeyLoginBeginCoreModel ToLoginBeginCore(string challengeToken, AssertionOptions options)
        => new()
        {
            ChallengeToken = challengeToken,
            Timeout = options.Timeout,
            RpId = options.RpId ?? string.Empty,
            UserVerification = options.UserVerification.HasValue ? (int)options.UserVerification.Value : null,
            Challenge = options.Challenge,
            AllowCredentials = [.. options.AllowCredentials.Select(ToDescriptorCore)]
        };

    private static string StepUpChallengeIdentity(string challengeToken)
        => $"stepup:{challengeToken}";

    private static string StepUpActionIdentity(string challengeToken)
        => $"stepup-action:{challengeToken}";

    private static string NormalizeStepUpAction(string? action)
        => (action ?? string.Empty).Trim();

    private static string GenerateChallengeToken()
        => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    private static bool IsPasskeySignCountValid(long expectedSignCount, long actualSignCount)
        => actualSignCount > expectedSignCount;

    private static AssertionOptions ToAssertionOptions(PasskeyLoginBeginCoreModel value)
        => new()
        {
            Challenge = value.Challenge,
            Timeout = value.Timeout,
            RpId = value.RpId,
            UserVerification = value.UserVerification.HasValue ? (UserVerificationRequirement)value.UserVerification.Value : null,
            AllowCredentials = [.. value.AllowCredentials.Select(ToDescriptor)]
        };

    private static PasskeyCredentialDescriptorCoreModel ToDescriptorCore(PublicKeyCredentialDescriptor descriptor)
        => new((int)descriptor.Type, descriptor.Id, [.. (descriptor.Transports ?? []).Select(static transport => (int)transport)]);

    private static PublicKeyCredentialDescriptor ToDescriptor(PasskeyCredentialDescriptorCoreModel descriptor)
        => new((PublicKeyCredentialType)descriptor.Type, descriptor.Id, [.. descriptor.Transports.Select(static value => (AuthenticatorTransport)value)]);

    private static AuthenticatorAttestationRawResponse ToAttestationResponse(PasskeyRegisterCompleteCoreModel request)
        => new()
        {
            Id = request.Id,
            RawId = request.RawId,
            Type = PublicKeyCredentialType.PublicKey,
            Response = new AuthenticatorAttestationRawResponse.AttestationResponse
            {
                ClientData\u004Ason = request.ClientDataBytes,
                AttestationObject = request.AttestationObject,
                Transports = [.. request.Transports.Select(static value => (AuthenticatorTransport)value)]
            },
            ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
        };

    private static AuthenticatorAssertionRawResponse ToAssertionResponse(PasskeyLoginCompleteCoreModel request)
        => new()
        {
            Id = request.Id,
            RawId = request.RawId,
            Type = PublicKeyCredentialType.PublicKey,
            Response = new AuthenticatorAssertionRawResponse.AssertionResponse
            {
                ClientData\u004Ason = request.ClientDataBytes,
                AuthenticatorData = request.AuthenticatorData,
                Signature = request.Signature,
                UserHandle = request.UserHandle ?? []
            },
            ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
        };

    private async Task<string> ResolveAccountSubjectHashForLogAsync(int accountId, CancellationToken cancellationToken)
    {
        User? user = await db.Queryable<User>().InSingleAsync(accountId);
        return user is null ? string.Empty : ResolveAccountSubjectHashForLog(user);
    }

    private static string ResolveAccountSubjectHashForLog(User user)
        => AccountSubjectHashRequirement.TryResolve(user.AccountSubjectHash, out string accountSubjectHash)
            ? accountSubjectHash
            : string.Empty;

    private static string HashForLog(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)))[..32];

    internal static PasskeyAccountMetadata BuildAnonymousSafeMetadataForTests(
        string? publicHandle,
        bool anonymousIdentityModeEnabled,
        byte[] stableUserHandle)
        => BuildAnonymousSafeMetadata(publicHandle, anonymousIdentityModeEnabled, stableUserHandle);

    internal static bool IsUserHandleOwnerOfCredentialForTests(byte[]? userHandle, string? storedUserHandle)
        => IsUserHandleOwnerOfCredential(userHandle, storedUserHandle);

    private static PasskeyAccountMetadata BuildAnonymousSafeMetadata(
        string? publicHandle,
        bool anonymousIdentityModeEnabled,
        byte[] stableUserHandle)
    {
        byte[] userHandle = stableUserHandle.ToArray();
        string displayName = NormalizeMetadataText(publicHandle, AnonymousPasskeyDisplayName);
        if (!anonymousIdentityModeEnabled)
        {
            return new PasskeyAccountMetadata(displayName, displayName, userHandle);
        }

        return new PasskeyAccountMetadata(AnonymousPasskeyAccountName, displayName, userHandle);
    }

    private async Task<byte[]> GetOrCreateStablePasskeyUserHandleAsync(User user, CancellationToken cancellationToken)
    {
        if (TryDecodeStoredPasskeyUserHandle(user.PasskeyUserHandle, out byte[] existing))
        {
            return existing;
        }

        byte[]? finalHandle = null;
        string? finalEncoded = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var lockedReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT passkey_user_handle
                FROM sys_user
                WHERE id = @UserId
                FOR UPDATE;
                """,
                new SugarParameter[] { new("@UserId", user.Id) }))
            {
                if (!await lockedReader.ReadAsync(cancellationToken))
                {
                    throw new InvalidOperationException("Unable to allocate stable passkey user handle.");
                }

                string? lockedHandle = lockedReader.IsNull("passkey_user_handle") ? null : lockedReader.ReadString("passkey_user_handle");
                if (TryDecodeStoredPasskeyUserHandle(lockedHandle, out existing))
                {
                    finalHandle = existing;
                    finalEncoded = lockedHandle;
                    return;
                }
            }

            byte[] generated = RandomNumberGenerator.GetBytes(PasskeyUserHandleBytes);
            string encoded = Base64Url.EncodeToString(generated);
            using var updateReader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user
                SET passkey_user_handle = @PasskeyUserHandle
                WHERE id = @UserId
                  AND passkey_user_handle IS NULL
                RETURNING passkey_user_handle AS final_handle;
                """,
                new SugarParameter[]
                {
                    new("@PasskeyUserHandle", encoded),
                    new("@UserId", user.Id)
                });
            if (await updateReader.ReadAsync(cancellationToken))
            {
                string returnedHandle = updateReader.ReadString("final_handle");
                if (TryDecodeStoredPasskeyUserHandle(returnedHandle, out existing))
                {
                    finalHandle = existing;
                    finalEncoded = returnedHandle;
                }
            }
        });

        if (!transaction.IsSuccess || finalHandle is null || finalEncoded is null)
        {
            throw new InvalidOperationException("Unable to allocate stable passkey user handle.", transaction.ErrorException);
        }

        user.PasskeyUserHandle = finalEncoded;
        return finalHandle;
    }

    private static bool IsUserHandleOwnerOfCredential(byte[]? userHandle, string? storedUserHandle)
    {
        if (userHandle is null || !TryDecodeStoredPasskeyUserHandle(storedUserHandle, out byte[] expectedHandle))
        {
            return false;
        }

        return userHandle.AsSpan().SequenceEqual(expectedHandle);
    }

    private static bool TryDecodeStoredPasskeyUserHandle(string? value, out byte[] userHandle)
    {
        userHandle = [];
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        try
        {
            byte[] decoded = Base64Url.DecodeFromChars(value.Trim());
            if (decoded.Length != PasskeyUserHandleBytes)
            {
                return false;
            }

            userHandle = decoded;
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string NormalizeMetadataText(string? value, string fallback)
    {
        string trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return fallback;
        }

        return trimmed.Length > 64 ? trimmed[..64] : trimmed;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Credential management
    // ─────────────────────────────────────────────────────────────────────

    public async Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int accountId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var creds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == accountId)
            .OrderBy(c => c.CreatedAt)
            .ToListAsync();

        return creds.Select(c => new PasskeyCredentialSummaryDto(
            c.Id,
            c.DeviceFriendlyName,
            c.CreatedAt,
            c.LastUsedAt,
            c.AaGuid,
            c.BackupEligible,
            c.BackupState)).ToList();
    }

    public async Task<PasskeyCredentialMutationResult> RemoveCredentialAsync(int accountId, int credId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PasskeyCredentialMutationResult result = PasskeyCredentialMutationResult.Missing("通行密钥不存在");
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            PasskeyDeleteState deleteState = await TryDeletePasskeyCredentialAsync(accountId, credId, cancellationToken);
            if (!deleteState.UserFound)
            {
                result = PasskeyCredentialMutationResult.Missing("用户不存在");
                return;
            }

            if (!deleteState.CredentialFound)
            {
                result = PasskeyCredentialMutationResult.Missing("通行密钥不存在");
                return;
            }

            if (!deleteState.Deleted)
            {
                result = PasskeyCredentialMutationResult.Rejected(CannotRemoveLastCredentialWithoutRecovery);
                return;
            }

            if (deleteState.Remaining == 0)
            {
                await db.Updateable<User>()
                    .Where(u => u.Id == accountId)
                    .SetColumns(u => u.PasskeyEnabled == false)
                    .ExecuteCommandAsync(cancellationToken);
                await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, accountId, cancellationToken).ConfigureAwait(false);
            }

            result = PasskeyCredentialMutationResult.Succeeded("通行密钥已删除");
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("passkey_credential_remove_failed", transaction.ErrorException);
        }

        return result;
    }

    public async Task<bool> RenameCredentialAsync(int accountId, int credId, string name, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length > 64) trimmed = trimmed[..64];

        int updated = await db.Updateable<PasskeyCredential>()
            .Where(c => c.Id == credId && c.AccountId == accountId)
            .SetColumns(c => c.DeviceFriendlyName == trimmed)
            .ExecuteCommandAsync();
        return updated > 0;
    }

    private async Task<PasskeyDeleteState> TryDeletePasskeyCredentialAsync(
        int accountId,
        int credId,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH locked_user AS (
                SELECT id, deleted_at, status, recovery_enabled
                FROM sys_user
                WHERE id = @accountId
                FOR UPDATE
            ),
            locked_credentials AS (
                SELECT id
                FROM passkey_credential
                WHERE account_id = @accountId
                ORDER BY id
                FOR UPDATE
            ),
            target AS (
                SELECT id
                FROM locked_credentials
                WHERE id = @credId
            ),
            deleted AS (
                DELETE FROM passkey_credential pc
                WHERE pc.id = @credId
                  AND pc.account_id = @accountId
                  AND EXISTS (
                      SELECT 1
                      FROM locked_user
                      WHERE deleted_at IS NULL
                        AND status <> 2
                  )
                  AND EXISTS (SELECT 1 FROM target)
                  AND (
                      (SELECT recovery_enabled FROM locked_user) = true
                      OR (SELECT COUNT(*) FROM locked_credentials) >= 2
                  )
                RETURNING pc.id
            )
            SELECT EXISTS (
                       SELECT 1
                       FROM locked_user
                       WHERE deleted_at IS NULL
                         AND status <> 2
                   ) AS user_found,
                   EXISTS (SELECT 1 FROM target) AS credential_found,
                   EXISTS (SELECT 1 FROM deleted) AS deleted,
                   (SELECT COUNT(*) FROM locked_credentials) - (SELECT COUNT(*) FROM deleted) AS remaining;
            """,
            new SugarParameter[]
            {
                new("@credId", credId),
                new("@accountId", accountId)
            });
        if (!await reader.ReadAsync(cancellationToken))
        {
            return new PasskeyDeleteState(UserFound: false, CredentialFound: false, Deleted: false, Remaining: 0);
        }

        return new PasskeyDeleteState(
            reader.ReadBoolean("user_found"),
            reader.ReadBoolean("credential_found"),
            reader.ReadBoolean("deleted"),
            Convert.ToInt32(reader.ReadValue("remaining"), System.Globalization.CultureInfo.InvariantCulture));
    }

    private async Task RespondToCounterRollbackAsync(
        User user,
        PasskeyCredential credential,
        long expectedSignCount,
        long actualSignCount,
        string flow,
        CancellationToken cancellationToken)
    {
        int revokedSessionCount;
        try
        {
            revokedSessionCount = await sessions.RevokeAllSessionsAsync(
                user.Id,
                CounterRollbackReason,
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            FsusObservability.RecordSecurityEvent(
                "passkey_counter_rollback",
                "session_revoke_failed",
                "failed");
            logger.LogCritical(
                ex,
                "Passkey counter rollback response failed to revoke sessions. AccountSubjectHash={AccountSubjectHash} CredentialHash={CredentialHash} Flow={Flow}",
                ResolveAccountSubjectHashForLog(user),
                HashForLog(credential.CredentialId),
                flow);
            throw new InvalidOperationException("passkey_counter_rollback_session_revoke_failed", ex);
        }

        try
        {
            await AccountSnapshotCacheInvalidator.BumpVersionAsync(cache, user.Id, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(
                ex,
                "Passkey counter rollback account snapshot invalidation failed. AccountSubjectHash={AccountSubjectHash} Flow={Flow}",
                ResolveAccountSubjectHashForLog(user),
                flow);
        }

        try
        {
            await notificationStream.PublishToUserAsync(
                NotificationStreamEventType.SessionRevoked,
                user.Id,
                new SessionRevokedPayload(CounterRollbackReason, revokedSessionCount, DateTime.UtcNow),
                "passkey-counter-rollback-session-revoked");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(
                ex,
                "Passkey counter rollback notification failed. AccountSubjectHash={AccountSubjectHash} Flow={Flow}",
                ResolveAccountSubjectHashForLog(user),
                flow);
        }

        try
        {
            await auditEvents.RecordHighValueAsync(
                new AuditEvent(
                    Source: AuditSourceCatalog.Security,
                    Type: AuditTypeCatalog.Security,
                    Action: AuditActionCatalog.PasskeyCounterRollback,
                    Outcome: AuditOutcomeCatalog.Denied,
                    Severity: AuditSeverityCatalog.Critical,
                    EventInfo: "Verified passkey counter rollback forced account reauthentication.",
                    ActorType: AuditActorTypeCatalog.User,
                    ActorId: user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    TargetType: "passkey_credential",
                    TargetId: credential.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ReasonCode: CounterRollbackReason,
                    Context: new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["flow"] = flow,
                        ["expectedSignCount"] = expectedSignCount,
                        ["actualSignCount"] = actualSignCount,
                        ["revokedSessionCount"] = revokedSessionCount
                    },
                    IsHighValue: true),
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogCritical(
                ex,
                "Passkey counter rollback high-value audit failed. AccountSubjectHash={AccountSubjectHash} Flow={Flow}",
                ResolveAccountSubjectHashForLog(user),
                flow);
        }

        FsusObservability.RecordSecurityEvent(
            "passkey_counter_rollback",
            "counter_non_monotonic",
            "sessions_revoked");
    }

    private static long ReadAuthenticatorSignCount(ReadOnlySpan<byte> authenticatorData)
        => authenticatorData.Length >= 37
            ? BinaryPrimitives.ReadUInt32BigEndian(authenticatorData.Slice(33, sizeof(uint)))
            : -1;

    private async Task<bool> TryUpdatePasskeySignCountAsync(
        int id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount,
        DateTime lastUsedAt,
        CancellationToken cancellationToken)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE passkey_credential
            SET signcount = @newSignCount,
                lastusedat = @lastUsedAt
            WHERE id = @id
              AND signcount = @expectedSignCount
              AND xmin::text = @rowVersion;
            """,
            new SugarParameter[]
            {
                new("@id", id),
                new("@expectedSignCount", expectedSignCount),
                new("@rowVersion", rowVersion),
                new("@newSignCount", newSignCount),
                new("@lastUsedAt", lastUsedAt)
            });
        cancellationToken.ThrowIfCancellationRequested();
        if (updated != 1)
        {
            return false;
        }

        return true;
    }
}
