using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using System.Diagnostics;
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
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAssertionAsync(CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, User? User)> CompleteAssertionAsync(PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginStepUpAssertionAsync(int accountId, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message)> CompleteStepUpAssertionAsync(int accountId, PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int accountId, CancellationToken cancellationToken = default);
    Task<PasskeyCredentialMutationResult> RemoveCredentialAsync(int accountId, int credId, CancellationToken cancellationToken = default);
    Task<bool> RenameCredentialAsync(int accountId, int credId, string name, CancellationToken cancellationToken = default);
}

public sealed record PasskeyRegBeginData(PasskeyRegisterBeginCoreModel Options);
public sealed record PasskeyAuthBeginData(PasskeyLoginBeginCoreModel Options);
internal readonly record struct PasskeyAccountMetadata(string Name, string DisplayName, byte[] UserHandle);
internal sealed record PasskeyAssertionState(PasskeyCredential Credential, User User, string RowVersion);
internal readonly record struct PasskeyDeleteState(bool UserFound, bool CredentialFound, bool Deleted, int Remaining);
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
    ILogger<PasskeyService> logger) : IPasskeyService
{
    private const int MaxCredentialsPerUser = 5;
    private const int PasskeyUserHandleBytes = 32;
    private const string AnonymousPasskeyAccountName = "fsus-anonymous-account";
    private const string AnonymousPasskeyDisplayName = "Anonymous account";
    public const string CannotRemoveLastCredentialWithoutRecovery = "CannotRemoveLastCredentialWithoutRecovery";

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
            return (false, "注册会话已过期，请重新开始");
        }

        var options = ToCredentialCreateOptions(cached.Value);
        AuthenticatorAttestationRawResponse attestationResponse = ToAttestationResponse(request);

        // 检查上限（并发保护）
        int existingCount = await db.Queryable<PasskeyCredential>()
            .Where(c => c.AccountId == accountId)
            .CountAsync();
        if (existingCount >= MaxCredentialsPerUser)
        {
            return (false, $"已达到 {MaxCredentialsPerUser} 枚通行密钥上限");
        }

        RegisteredPublicKeyCredential result;
        try
        {
            result = await fido2.MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = attestationResponse,
                OriginalOptions = options,
                IsCredentialIdUniqueToUserCallback = IsCredentialIdUniqueAsync
            });
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey registration failed. AccountSubjectHash={AccountSubjectHash} SessionKeyHash={SessionKeyHash} ExceptionType={ExceptionType}",
                await ResolveAccountSubjectHashForLogAsync(accountId, cancellationToken),
                HashForLog(request.SessionKey),
                ex.GetType().Name);
            return (false, "通行密钥验证失败，请重试");
        }

        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, request.SessionKey, cancellationToken);

        string credentialIdBase64 = Base64Url.EncodeToString(result.Id);
        string publicKeyBase64 = Base64Url.EncodeToString(result.PublicKey);
        string aaGuid = Guid.Empty.ToString();

        string? transportsStr = result.Transports is { Length: > 0 }
            ? string.Join(",", result.Transports.Select(t => t.ToEnumMemberValue()))
            : null;

        var credential = new PasskeyCredential
        {
            AccountId = accountId,
            CredentialId = credentialIdBase64,
            PublicKey = publicKeyBase64,
            SignCount = (long)result.SignCount,
            DeviceFriendlyName = string.IsNullOrWhiteSpace(request.FriendlyName) ? null : request.FriendlyName.Trim()[..Math.Min(64, request.FriendlyName.Trim().Length)],
            AaGuid = aaGuid,
            Transports = transportsStr,
            BackupEligible = result.IsBackupEligible,
            BackupState = result.IsBackedUp,
            CreatedAt = DateTime.UtcNow
        };

        await db.Insertable(credential).ExecuteCommandAsync();
        await db.Updateable<User>()
            .Where(u => u.Id == accountId)
            .SetColumns(u => u.PasskeyEnabled == true)
            .ExecuteCommandAsync();

        return (true, "通行密钥注册成功");
    }

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
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash} AccountSubjectHash={AccountSubjectHash} ExceptionType={ExceptionType}",
                HashForLog(request.ChallengeToken),
                HashForLog(credentialIdBase64),
                AccountSubjectHasher.Create(user),
                ex.GetType().Name);
            FsusObservability.RecordPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(started), "verify_failed");
            return (false, "通行密钥验证失败，请重试", null);
        }

        if (!IsPasskeySignCountValid(expectedSignCount, (long)verifyResult.SignCount) ||
            !await TryUpdatePasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, (long)verifyResult.SignCount, DateTime.UtcNow, cancellationToken))
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

        if (!IsPasskeySignCountValid(expectedSignCount, (long)verifyResult.SignCount) ||
            !await TryUpdatePasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, (long)verifyResult.SignCount, DateTime.UtcNow, cancellationToken))
        {
            FsusObservability.RecordPasskeySignCountConflict("step_up");
            FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "sign_count_conflict");
            return (false, "通行密钥 step-up 验证失败，请重试");
        }

        FsusObservability.RecordPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(started), "success");
        return (true, "step-up 验证成功");
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
        return user is null
            ? AccountSubjectHasher.Create(AnonymousIdentityRuntime.AnonymousAccountKind, string.Concat("anonymous-account:", accountId.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            : AccountSubjectHasher.Create(user);
    }

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

                string? lockedHandle = lockedReader.IsDBNull(0) ? null : lockedReader.GetString(0);
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
                string returnedHandle = updateReader.GetString(0);
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
            reader.GetBoolean(0),
            reader.GetBoolean(1),
            reader.GetBoolean(2),
            Convert.ToInt32(reader.GetValue(3), System.Globalization.CultureInfo.InvariantCulture));
    }

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
