using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.WebUtilities;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAdminPrincipalService
{
    Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginBootstrapPasskeyRegistrationAsync(
        string? bootstrapToken,
        string? handle,
        CancellationToken cancellationToken = default);

    Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteBootstrapPasskeyRegistrationAsync(
        string? bootstrapToken,
        PasskeyRegisterCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default);

    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminAssertionAsync(CancellationToken cancellationToken = default);

    Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteAdminAssertionAsync(
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default);

    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        CancellationToken cancellationToken = default);

    Task<(bool Success, string Message, string? ProofToken)> CompleteAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default);

    Task<(bool Success, string Message)> VerifyAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default);

    Task<string> CreateAdminStepUpProofTokenAsync(
        long adminPrincipalId,
        string adminSessionId,
        string action,
        TimeSpan ttl,
        CancellationToken cancellationToken = default);

    Task<bool> ValidateAndConsumeAdminStepUpProofTokenAsync(
        long adminPrincipalId,
        string adminSessionId,
        string action,
        string token,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<AdminSessionSummaryDto>> GetAdminSessionsAsync(
        long adminPrincipalId,
        string currentSessionId,
        CancellationToken cancellationToken = default);

    Task<bool> EnsureAdminSessionBelongsToPrincipalAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default);

    Task<bool> LogoutAdminSessionAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default);

    Task<AdminSessionTokens?> RotateAdminSessionAccessTokenAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default);

    Task<bool> DisableAdminPrincipalAsync(
        long adminPrincipalId,
        CancellationToken cancellationToken = default);

    Task<AdminSessionRevokeResult> RevokeAdminSessionAsync(
        long adminPrincipalId,
        string sessionId,
        string reason,
        CancellationToken cancellationToken = default);

    Task<int> RevokeOtherAdminSessionsAsync(
        long adminPrincipalId,
        string currentSessionId,
        CancellationToken cancellationToken = default);
}

public sealed record AdminAuthClientContext(string ClientIp, string? DeviceFingerprint, string? UserAgent)
{
    public static AdminAuthClientContext From(HttpContext context)
        => new(context.GetClientIp(), GetDeviceFingerprint(context), context.GetUserAgent());

    private static string? GetDeviceFingerprint(HttpContext context)
        => context.Request.Headers.TryGetValue("X-Fsus-Device-Fp", out var values)
            ? values.ToString()
            : null;
}

public sealed record AdminSessionTokens(
    string AccessToken,
    DateTimeOffset AccessTokenExpiresAtUtc,
    string SessionId,
    DateTime IdleExpiresAtUtc);

internal sealed record AdminPasskeyAssertionState(AdminPasskeyCredential Credential, AdminPrincipal Principal, string RowVersion);

public enum AdminSessionRevokeResult
{
    Revoked,
    NotFound,
    Conflict
}

public sealed class AdminPrincipalService(
    IFido2 fido2,
    ISqlSugarClient db,
    ICacheStringWriter cacheWriter,
    ICacheOneTimeStore oneTimeStore,
    IJwtHelper jwtHelper,
    IConfiguration configuration,
    ILogger<AdminPrincipalService> logger,
    IAdminAuditLogChannel adminAuditLogChannel,
    IAdminSessionProjectionMutationCoordinator? sessionProjectionMutations = null,
    TimeProvider? timeProvider = null) : IAdminPrincipalService
{
    public const string BootstrapTokenEnvironmentVariable = "FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN";
    private const string BootstrapCachePrefix = "admin-bootstrap";
    private const string LoginCachePrefix = "admin-login";
    private const string StepUpCachePrefix = "admin-stepup";
    private const string AdminSensitiveAction = "admin-sensitive";
    private const int AdminSessionListLimit = 50;
    private const long RootBootstrapAdvisoryLockKey = 761245219401267874L;
    private static readonly TimeSpan s_challengeTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan s_stepUpProofTtl = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan s_adminIdleSessionTtl = TimeSpan.FromHours(8);
    private static readonly JsonSerializerOptions s_challengeCacheJsonOptions = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 32
    };
    private static readonly TimeSpan s_adminAbsoluteSessionTtl = TimeSpan.FromHours(12);

    public async Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginBootstrapPasskeyRegistrationAsync(
        string? bootstrapToken,
        string? handle,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ValidateBootstrapToken(bootstrapToken, out string tokenError))
        {
            return (false, tokenError, null);
        }

        if (await RootAdminExistsAsync(cancellationToken))
        {
            return (false, "Root admin already exists", null);
        }

        string normalizedHandle = NormalizeHandle(handle);
        if (normalizedHandle.Length == 0)
        {
            return (false, "Admin handle is required", null);
        }

        byte[] userHandle = RandomNumberGenerator.GetBytes(32);
        var fidoUser = new Fido2User
        {
            Id = userHandle,
            Name = $"fsus-admin-{normalizedHandle}",
            DisplayName = normalizedHandle
        };

        var options = fido2.RequestNewCredential(new RequestNewCredentialParams
        {
            User = fidoUser,
            ExcludeCredentials = [],
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Required
            },
            AttestationPreference = AttestationConveyancePreference.None
        });

        string sessionKey = GenerateSecretToken();
        PasskeyRegisterBeginCoreModel coreOptions = ToRegisterBeginCore(sessionKey, options);
        var challenge = new AdminBootstrapChallenge(normalizedHandle, userHandle, coreOptions);
        await cacheWriter.SetStringAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            CacheKey(BootstrapCachePrefix, sessionKey),
            JsonSerializer.Serialize(challenge),
            s_challengeTtl,
            cancellationToken);

        return (true, "已生成 root admin Passkey 注册选项", new PasskeyRegBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteBootstrapPasskeyRegistrationAsync(
        string? bootstrapToken,
        PasskeyRegisterCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ValidateBootstrapToken(bootstrapToken, out string tokenError))
        {
            return (false, tokenError, null);
        }

        if (await RootAdminExistsAsync(cancellationToken))
        {
            return (false, "Root admin already exists", null);
        }

        AdminBootstrapChallenge? challenge = await ConsumeChallengeAsync<AdminBootstrapChallenge>(
            CachePolicyId.SecurityPasskeyRegChallenge,
            CacheKey(BootstrapCachePrefix, request.SessionKey),
            cancellationToken);
        if (challenge is null)
        {
            return (false, "Admin bootstrap challenge expired", null);
        }

        RegisteredPublicKeyCredential result;
        try
        {
            result = await fido2.MakeNewCredentialAsync(new MakeNewCredentialParams
            {
                AttestationResponse = ToAttestationResponse(request),
                OriginalOptions = ToCredentialCreateOptions(challenge.Options),
                IsCredentialIdUniqueToUserCallback = IsAdminCredentialIdUniqueAsync
            });
        }
        catch (Exception)
        {
            logger.LogWarning("Admin bootstrap Passkey registration failed. SessionKeyHash={SessionKeyHash}", HashForLog(request.SessionKey));
            await WriteAuditAsync(null, null, "admin.bootstrap.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            return (false, "Admin Passkey registration failed", null);
        }

        var principal = new AdminPrincipal
        {
            Handle = challenge.Handle,
            DisplayName = challenge.Handle,
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = string.Join('\n', AdminPermissions.All),
            CreatedAtUtc = DateTime.UtcNow
        };
        PreparedAdminSession? preparedSession = null;
        var bootstrap = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireRootBootstrapLockAsync(cancellationToken);
            if (await RootAdminExistsAsync(cancellationToken))
            {
                return false;
            }

            principal.Id = await db.Insertable(principal).ExecuteReturnIdentityAsync();

            var credential = CreateCredential(principal.Id, challenge.UserHandle, result, request.FriendlyName);
            await db.Insertable(credential).ExecuteCommandAsync();

            preparedSession = await CreateSessionAndTokenAsync(principal, clientContext, stepUpVerified: false, cancellationToken);
            await WriteAuditAsync(principal.Id, preparedSession.Tokens.SessionId, "admin.bootstrap.completed", "success", clientContext, highImpact: true, cancellationToken);
            return true;
        });
        if (!bootstrap.IsSuccess)
        {
            if (IsUniqueViolation(bootstrap.ErrorException))
            {
                return (false, "Root admin already exists", null);
            }

            logger.LogError(bootstrap.ErrorException, "Admin bootstrap transaction failed.");
            return (false, "Root admin bootstrap failed", null);
        }

        if (!bootstrap.Data || preparedSession is null)
        {
            return (false, "Root admin already exists", null);
        }

        await PublishSessionProjectionMutationAsync(preparedSession.Mutation, cancellationToken);
        return (true, "Root admin bootstrapped", preparedSession.Tokens);
    }

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminAssertionAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required
        });

        string challengeToken = GenerateSecretToken();
        PasskeyLoginBeginCoreModel coreOptions = ToLoginBeginCore(challengeToken, options);
        await cacheWriter.SetStringAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(LoginCachePrefix, challengeToken),
            JsonSerializer.Serialize(coreOptions),
            s_challengeTtl,
            cancellationToken);

        return (true, "已生成 admin Passkey 登录选项", new PasskeyAuthBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteAdminAssertionAsync(
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PasskeyLoginBeginCoreModel? cachedOptions = await ConsumeChallengeAsync<PasskeyLoginBeginCoreModel>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(LoginCachePrefix, request.ChallengeToken),
            cancellationToken);
        if (cachedOptions is null)
        {
            return (false, "Admin login challenge expired", null);
        }

        long startedAt = Stopwatch.GetTimestamp();
        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);
        string credentialIdBase64 = assertionResponse.Id;
        AdminPasskeyAssertionState? assertionState = await LoadAdminPasskeyAssertionStateAsync(
            credentialIdBase64,
            adminPrincipalId: null,
            adminSessionId: null,
            cancellationToken);
        if (assertionState is null)
        {
            FsusObservability.RecordAdminPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(startedAt), "credential_not_found");
            return (false, "Admin Passkey credential not found", null);
        }

        AdminPasskeyCredential storedCred = assertionState.Credential;
        AdminPrincipal principal = assertionState.Principal;
        if (!string.Equals(principal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            FsusObservability.RecordAdminPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(startedAt), "principal_disabled");
            return (false, "Admin principal is disabled", null);
        }

        long expectedSignCount = storedCred.SignCount;
        VerifyAssertionResult verifyResult;
        try
        {
            verifyResult = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertionResponse,
                OriginalOptions = ToAssertionOptions(cachedOptions),
                StoredPublicKey = WebEncoders.Base64UrlDecode(storedCred.PublicKey),
                StoredSignatureCounter = (uint)storedCred.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (param, ct) =>
                    Task.FromResult(IsAdminUserHandleOwner(param.UserHandle, storedCred.UserHandle))
            });
        }
        catch (Exception)
        {
            logger.LogWarning("Admin Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash}", HashForLog(request.ChallengeToken), HashForLog(credentialIdBase64));
            await WriteAuditAsync(storedCred.AdminPrincipalId, null, "admin.login.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(startedAt), "verify_failed");
            return (false, "Admin Passkey assertion failed", null);
        }

        if (!await TryUpdateAdminPasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, (long)verifyResult.SignCount, DateTime.UtcNow, cancellationToken))
        {
            await WriteAuditAsync(storedCred.AdminPrincipalId, null, "admin.login.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeySignCountConflict("login");
            FsusObservability.RecordAdminPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(startedAt), "sign_count_conflict");
            return (false, "Admin Passkey assertion failed", null);
        }

        var login = await db.Ado.UseTranAsync(async () =>
        {
            principal.LastLoginAtUtc = DateTime.UtcNow;
            await db.Updateable(principal)
                .UpdateColumns(p => new { p.LastLoginAtUtc })
                .ExecuteCommandAsync();
            return await CreateSessionAndTokenAsync(principal, clientContext, stepUpVerified: false, cancellationToken);
        });
        if (!login.IsSuccess || login.Data is null)
        {
            logger.LogError(login.ErrorException, "Admin session creation transaction failed.");
            return (false, "Admin login failed", null);
        }

        PreparedAdminSession preparedSession = login.Data;
        await PublishSessionProjectionMutationAsync(preparedSession.Mutation, cancellationToken);
        await WriteAuditAsync(principal.Id, preparedSession.Tokens.SessionId, "admin.login.completed", "success", clientContext, highImpact: true, cancellationToken);
        FsusObservability.RecordAdminPasskeyAssertion("login", 1, Stopwatch.GetElapsedTime(startedAt), "success");
        return (true, "Admin login completed", preparedSession.Tokens);
    }

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (adminPrincipalId <= 0 || string.IsNullOrWhiteSpace(adminSessionId))
        {
            return (false, "Admin session is required", null);
        }

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        bool active = await db.Queryable<AdminSession>()
            .Where(s => s.AdminPrincipalId == adminPrincipalId &&
                s.SessionId == adminSessionId &&
                s.RevokedAtUtc == null &&
                s.IdleExpiresAtUtc > now &&
                s.AbsoluteExpiresAtUtc > now)
            .AnyAsync();
        if (!active)
        {
            return (false, "Admin session expired", null);
        }

        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required
        });

        string challengeToken = GenerateSecretToken();
        PasskeyLoginBeginCoreModel coreOptions = ToLoginBeginCore(challengeToken, options);
        var challenge = new AdminStepUpChallenge(
            AnonymousIdentityRuntime.AdminPrincipalKind,
            adminPrincipalId,
            adminSessionId,
            AdminSensitiveAction,
            challengeToken,
            DateTime.UtcNow.Add(s_challengeTtl),
            coreOptions);

        await cacheWriter.SetStringAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(StepUpCachePrefix, challengeToken),
            JsonSerializer.Serialize(challenge),
            s_challengeTtl,
            cancellationToken);

        return (true, "已生成 admin step-up Passkey 认证选项", new PasskeyAuthBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message, string? ProofToken)> CompleteAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AdminStepUpChallenge? challenge = await ConsumeChallengeAsync<AdminStepUpChallenge>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(StepUpCachePrefix, request.ChallengeToken),
            cancellationToken);
        if (challenge is null)
        {
            return (false, "Admin step-up challenge expired", null);
        }

        if (!challenge.IsFor(adminPrincipalId, adminSessionId, AdminSensitiveAction, request.ChallengeToken))
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.challenge_mismatch", "failure", clientContext, highImpact: true, cancellationToken);
            return (false, "Admin step-up challenge mismatch", null);
        }

        long startedAt = Stopwatch.GetTimestamp();
        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);
        string credentialIdBase64 = assertionResponse.Id;
        AdminPasskeyAssertionState? assertionState = await LoadAdminPasskeyAssertionStateAsync(
            credentialIdBase64,
            adminPrincipalId,
            adminSessionId,
            cancellationToken);
        if (assertionState is null)
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.credential_mismatch", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(startedAt), "credential_not_found");
            return (false, "Admin Passkey credential not found", null);
        }

        AdminPasskeyCredential storedCred = assertionState.Credential;
        AdminPrincipal principal = assertionState.Principal;
        if (!string.Equals(principal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            FsusObservability.RecordAdminPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(startedAt), "principal_disabled");
            return (false, "Admin principal is disabled", null);
        }

        long expectedSignCount = storedCred.SignCount;
        VerifyAssertionResult verifyResult;
        try
        {
            verifyResult = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertionResponse,
                OriginalOptions = ToAssertionOptions(challenge.Options),
                StoredPublicKey = WebEncoders.Base64UrlDecode(storedCred.PublicKey),
                StoredSignatureCounter = (uint)storedCred.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (param, ct) =>
                    Task.FromResult(IsAdminUserHandleOwner(param.UserHandle, storedCred.UserHandle))
            });
        }
        catch (Exception)
        {
            logger.LogWarning("Admin step-up Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash}", HashForLog(request.ChallengeToken), HashForLog(credentialIdBase64));
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(startedAt), "verify_failed");
            return (false, "Admin step-up Passkey assertion failed", null);
        }

        if (!await TryUpdateAdminPasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, (long)verifyResult.SignCount, DateTime.UtcNow, cancellationToken))
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeySignCountConflict("step_up");
            FsusObservability.RecordAdminPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(startedAt), "sign_count_conflict");
            return (false, "Admin step-up Passkey assertion failed", null);
        }

        string proofToken = await CreateAdminStepUpProofTokenAsync(adminPrincipalId, adminSessionId, AdminSensitiveAction, s_stepUpProofTtl, cancellationToken);
        await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.completed", "success", clientContext, highImpact: true, cancellationToken);
        FsusObservability.RecordAdminPasskeyAssertion("step_up", 1, Stopwatch.GetElapsedTime(startedAt), "success");
        return (true, "Admin step-up completed", proofToken);
    }

    public async Task<(bool Success, string Message)> VerifyAdminStepUpAssertionAsync(
        long adminPrincipalId,
        string adminSessionId,
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AdminStepUpChallenge? challenge = await ConsumeChallengeAsync<AdminStepUpChallenge>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(StepUpCachePrefix, request.ChallengeToken),
            cancellationToken);
        if (challenge is null)
        {
            return (false, "Admin step-up challenge expired");
        }

        if (!challenge.IsFor(adminPrincipalId, adminSessionId, AdminSensitiveAction, request.ChallengeToken))
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.challenge_mismatch", "failure", clientContext, highImpact: true, cancellationToken);
            return (false, "Admin step-up challenge mismatch");
        }

        long startedAt = Stopwatch.GetTimestamp();
        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);
        string credentialIdBase64 = assertionResponse.Id;
        AdminPasskeyAssertionState? assertionState = await LoadAdminPasskeyAssertionStateAsync(
            credentialIdBase64,
            adminPrincipalId,
            adminSessionId,
            cancellationToken);
        if (assertionState is null)
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.credential_mismatch", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeyAssertion("risk_step_up", 1, Stopwatch.GetElapsedTime(startedAt), "credential_not_found");
            return (false, "Admin Passkey credential not found");
        }

        AdminPasskeyCredential storedCred = assertionState.Credential;
        AdminPrincipal principal = assertionState.Principal;
        if (!string.Equals(principal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            FsusObservability.RecordAdminPasskeyAssertion("risk_step_up", 1, Stopwatch.GetElapsedTime(startedAt), "principal_disabled");
            return (false, "Admin principal is disabled");
        }

        long expectedSignCount = storedCred.SignCount;
        VerifyAssertionResult verifyResult;
        try
        {
            verifyResult = await fido2.MakeAssertionAsync(new MakeAssertionParams
            {
                AssertionResponse = assertionResponse,
                OriginalOptions = ToAssertionOptions(challenge.Options),
                StoredPublicKey = WebEncoders.Base64UrlDecode(storedCred.PublicKey),
                StoredSignatureCounter = (uint)storedCred.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (param, ct) =>
                    Task.FromResult(IsAdminUserHandleOwner(param.UserHandle, storedCred.UserHandle))
            });
        }
        catch (Exception)
        {
            logger.LogWarning("Admin RiskControl step-up Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash}", HashForLog(request.ChallengeToken), HashForLog(credentialIdBase64));
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.risk_control_passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeyAssertion("risk_step_up", 1, Stopwatch.GetElapsedTime(startedAt), "verify_failed");
            return (false, "Admin step-up Passkey assertion failed");
        }

        if (!await TryUpdateAdminPasskeySignCountAsync(storedCred.Id, expectedSignCount, assertionState.RowVersion, (long)verifyResult.SignCount, DateTime.UtcNow, cancellationToken))
        {
            await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.risk_control_passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            FsusObservability.RecordAdminPasskeySignCountConflict("risk_step_up");
            FsusObservability.RecordAdminPasskeyAssertion("risk_step_up", 1, Stopwatch.GetElapsedTime(startedAt), "sign_count_conflict");
            return (false, "Admin step-up Passkey assertion failed");
        }

        await WriteAuditAsync(adminPrincipalId, adminSessionId, "admin.step_up.risk_control_verified", "success", clientContext, highImpact: true, cancellationToken);
        FsusObservability.RecordAdminPasskeyAssertion("risk_step_up", 1, Stopwatch.GetElapsedTime(startedAt), "success");
        return (true, "Admin step-up verified");
    }

    public async Task<string> CreateAdminStepUpProofTokenAsync(
        long adminPrincipalId,
        string adminSessionId,
        string action,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string token = GenerateSecretToken();
        string identity = AdminStepUpProofIdentity(adminPrincipalId, adminSessionId, action, token);
        await cacheWriter.SetStringAsync(CachePolicyId.SecurityMfaProof, identity, "1", ttl, cancellationToken);
        return token;
    }

    public Task<bool> ValidateAndConsumeAdminStepUpProofTokenAsync(
        long adminPrincipalId,
        string adminSessionId,
        string action,
        string token,
        CancellationToken cancellationToken = default)
    {
        if (adminPrincipalId <= 0 ||
            string.IsNullOrWhiteSpace(adminSessionId) ||
            string.IsNullOrWhiteSpace(action) ||
            string.IsNullOrWhiteSpace(token))
        {
            return Task.FromResult(false);
        }

        string identity = AdminStepUpProofIdentity(adminPrincipalId, adminSessionId, action, token);
        return oneTimeStore.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, identity, cancellationToken);
    }

    public async Task<IReadOnlyList<AdminSessionSummaryDto>> GetAdminSessionsAsync(
        long adminPrincipalId,
        string currentSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        List<AdminSession> sessions = await db.Queryable<AdminSession>()
            .Where(s => s.AdminPrincipalId == adminPrincipalId)
            .OrderBy(s => s.LastSeenAtUtc, OrderByType.Desc)
            .OrderBy(s => s.CreatedAtUtc, OrderByType.Desc)
            .Take(AdminSessionListLimit)
            .ToListAsync();

        AdminSessionSummaryDto[] summaries = sessions.Select(session => new AdminSessionSummaryDto(
            session.SessionId,
            session.DeviceFingerprint,
            session.UserAgent,
            session.CreatedAtUtc,
            session.LastSeenAtUtc,
            session.IdleExpiresAtUtc,
            session.AbsoluteExpiresAtUtc,
            string.Equals(session.SessionId, currentSessionId, StringComparison.Ordinal),
            session.RevokedAtUtc.HasValue)).ToArray();
        FsusObservability.RecordAdminSessionList(summaries.Length, Stopwatch.GetElapsedTime(startedAt));
        return summaries;
    }

    public async Task<bool> EnsureAdminSessionBelongsToPrincipalAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        if (adminPrincipalId <= 0 || string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        int count = await db.Queryable<AdminSession>()
            .Where(s => s.AdminPrincipalId == adminPrincipalId && s.SessionId == sessionId)
            .CountAsync(cancellationToken);
        return count == 1;
    }

    public Task<bool> LogoutAdminSessionAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default)
        => LogoutAdminSessionCoreAsync(adminPrincipalId, sessionId, cancellationToken);

    private async Task<bool> LogoutAdminSessionCoreAsync(long adminPrincipalId, string sessionId, CancellationToken cancellationToken)
        => await RevokeAdminSessionAsync(adminPrincipalId, sessionId, "logout", cancellationToken) == AdminSessionRevokeResult.Revoked;

    public async Task<AdminSessionTokens?> RotateAdminSessionAccessTokenAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (adminPrincipalId <= 0 || string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        PreparedAdminSessionProjectionMutation? mutation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            AdminPrincipal? principal = await db.Queryable<AdminPrincipal>()
                .Where(item => item.Id == adminPrincipalId && item.Status == AdminPrincipalStatus.Active)
                .FirstAsync(cancellationToken);
            AdminSession? session = await db.Queryable<AdminSession>()
                .Where(item => item.SessionId == sessionId
                    && item.AdminPrincipalId == adminPrincipalId
                    && item.RevokedAtUtc == null
                    && item.IdleExpiresAtUtc > now
                    && item.AbsoluteExpiresAtUtc > now)
                .FirstAsync(cancellationToken);
            if (principal is null || session is null)
            {
                return (AdminSessionTokens?)null;
            }

            IssuedAccessToken issued = jwtHelper.GenerateAdminAccessToken(
                principal,
                session,
                ParsePermissions(principal.Permissions),
                session.StepUpVerified);
            string tokenHash = HashForStorage(issued.Token);
            int updated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE admin_session
                SET accesstokenhash = @AccessTokenHash,
                    validationversion = validationversion + 1
                WHERE sessionid = @SessionId
                  AND validationversion = @ValidationVersion
                  AND revokedatutc IS NULL;
                """,
                new SugarParameter("@AccessTokenHash", tokenHash),
                new SugarParameter("@SessionId", sessionId),
                new SugarParameter("@ValidationVersion", session.ValidationVersion));
            if (updated != 1)
            {
                return (AdminSessionTokens?)null;
            }
            mutation = await PrepareSessionProjectionMutationAsync([sessionId], cancellationToken);
            return new AdminSessionTokens(issued.Token, issued.ExpiresAtUtc, sessionId, session.IdleExpiresAtUtc);
        });
        if (!transaction.IsSuccess || transaction.Data is null)
        {
            if (!transaction.IsSuccess)
            {
                logger.LogError(transaction.ErrorException, "Admin session token rotation transaction failed.");
            }
            return null;
        }

        await PublishSessionProjectionMutationAsync(mutation, cancellationToken);
        return transaction.Data;
    }

    public async Task<bool> DisableAdminPrincipalAsync(
        long adminPrincipalId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (adminPrincipalId <= 0)
        {
            return false;
        }

        PreparedAdminSessionProjectionMutation? mutation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            int updated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE admin_principal
                SET status = @Status,
                    validationversion = validationversion + 1
                WHERE id = @PrincipalId
                  AND status = @ActiveStatus;
                """,
                new SugarParameter("@Status", AdminPrincipalStatus.Disabled),
                new SugarParameter("@PrincipalId", adminPrincipalId),
                new SugarParameter("@ActiveStatus", AdminPrincipalStatus.Active));
            if (updated != 1)
            {
                return false;
            }
            mutation = sessionProjectionMutations is null
                ? null
                : await sessionProjectionMutations.PreparePrincipalAsync(adminPrincipalId, cancellationToken);
            return true;
        });
        if (!transaction.IsSuccess || !transaction.Data)
        {
            if (!transaction.IsSuccess)
            {
                logger.LogError(transaction.ErrorException, "Admin principal disable transaction failed.");
            }
            return false;
        }

        await PublishSessionProjectionMutationAsync(mutation, cancellationToken);
        return true;
    }

    public async Task<AdminSessionRevokeResult> RevokeAdminSessionAsync(
        long adminPrincipalId,
        string sessionId,
        string reason,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return AdminSessionRevokeResult.NotFound;
        }

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        string normalizedReason = NormalizeRevokeReason(reason);
        PreparedAdminSessionProjectionMutation? mutation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            AdminSessionRevokeCandidate? candidate = await LoadAdminSessionRevokeCandidateAsync(
                adminPrincipalId,
                sessionId,
                cancellationToken);
            if (candidate is null)
            {
                return AdminSessionRevokeResult.NotFound;
            }
            if (candidate.RevokedAtUtc.HasValue)
            {
                return AdminSessionRevokeResult.Conflict;
            }
            if (!await TryRevokeAdminSessionAsync(candidate, now, normalizedReason, cancellationToken))
            {
                return AdminSessionRevokeResult.Conflict;
            }
            mutation = await PrepareSessionProjectionMutationAsync([sessionId], cancellationToken);
            return AdminSessionRevokeResult.Revoked;
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(transaction.ErrorException, "Admin session revoke transaction failed.");
            return AdminSessionRevokeResult.Conflict;
        }
        if (transaction.Data != AdminSessionRevokeResult.Revoked)
        {
            return transaction.Data;
        }

        await PublishSessionProjectionMutationAsync(mutation, cancellationToken);
        await WriteAdminSessionRevokeAuditAsync(adminPrincipalId, sessionId, normalizedReason, now, cancellationToken);
        return AdminSessionRevokeResult.Revoked;
    }

    public async Task<int> RevokeOtherAdminSessionsAsync(
        long adminPrincipalId,
        string currentSessionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(currentSessionId))
        {
            return 0;
        }

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        long startedAt = Stopwatch.GetTimestamp();
        PreparedAdminSessionProjectionMutation? mutation = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            var revoked = new List<string>();
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                    UPDATE admin_session
                    SET revokedatutc = @Now,
                        revokereason = 'revoke_others',
                        validationversion = validationversion + 1
                    WHERE adminprincipalid = @AdminPrincipalId
                      AND sessionid <> @CurrentSessionId
                      AND revokedatutc IS NULL
                    RETURNING sessionid;
                    """,
                new SugarParameter("@AdminPrincipalId", adminPrincipalId),
                new SugarParameter("@CurrentSessionId", currentSessionId),
                new SugarParameter("@Now", now)))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    revoked.Add(reader.ReadString("sessionid"));
                }
            }
            mutation = await PrepareSessionProjectionMutationAsync(revoked, cancellationToken);
            return revoked;
        });
        if (!transaction.IsSuccess || transaction.Data is null)
        {
            logger.LogError(transaction.ErrorException, "Admin revoke-other-sessions transaction failed.");
            return 0;
        }
        List<string> revokedSessionIds = transaction.Data;

        await PublishSessionProjectionMutationAsync(mutation, cancellationToken);
        await WriteAdminSessionRevokeAuditsAsync(adminPrincipalId, revokedSessionIds, "revoke_others", now, cancellationToken);
        FsusObservability.RecordAdminSessionRevokeOthers(revokedSessionIds.Count, Stopwatch.GetElapsedTime(startedAt));
        return revokedSessionIds.Count;
    }

    private async Task<AdminSessionRevokeCandidate?> LoadAdminSessionRevokeCandidateAsync(
        long adminPrincipalId,
        string sessionId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT sessionid,
                   revokedatutc,
                   xmin::text AS row_version
            FROM admin_session
            WHERE adminprincipalid = @AdminPrincipalId
              AND sessionid = @SessionId;
            """,
            new SugarParameter("@AdminPrincipalId", adminPrincipalId),
            new SugarParameter("@SessionId", sessionId));

        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return new AdminSessionRevokeCandidate(
            reader.ReadString("sessionid"),
            reader.IsNull("revokedatutc") ? null : reader.ReadDateTime("revokedatutc"),
            reader.ReadString("row_version"));
    }

    private async Task<bool> TryRevokeAdminSessionAsync(
        AdminSessionRevokeCandidate candidate,
        DateTime revokedAtUtc,
        string reason,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE admin_session
            SET revokedatutc = @RevokedAtUtc,
                revokereason = @Reason,
                validationversion = validationversion + 1
            WHERE sessionid = @SessionId
              AND revokedatutc IS NULL
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@SessionId", candidate.SessionId),
            new SugarParameter("@RevokedAtUtc", revokedAtUtc),
            new SugarParameter("@Reason", reason),
            new SugarParameter("@RowVersion", candidate.RowVersion));
        return updated == 1;
    }

    private async Task WriteAdminSessionRevokeAuditAsync(
        long adminPrincipalId,
        string sessionId,
        string reason,
        DateTime occurredAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var audit = new AdminAuditLog
        {
            AdminPrincipalId = adminPrincipalId,
            AdminSessionId = sessionId,
            Action = "admin.session.revoked",
            Outcome = "success",
            TargetType = "admin_session",
            TargetId = sessionId,
            IsHighImpact = true,
            MetadataJson = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                ["reason"] = reason
            }),
            OccurredAtUtc = occurredAtUtc
        };
        await adminAuditLogChannel.EnqueueAsync(audit, cancellationToken);
    }

    private async Task WriteAdminSessionRevokeAuditsAsync(
        long adminPrincipalId,
        IReadOnlyCollection<string> sessionIds,
        string reason,
        DateTime occurredAtUtc,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (sessionIds.Count == 0)
        {
            return;
        }

        string metadataJson = JsonSerializer.Serialize(new Dictionary<string, string>
        {
            ["reason"] = reason
        });
        AdminAuditLog[] audits = sessionIds.Select(sessionId => new AdminAuditLog
        {
            AdminPrincipalId = adminPrincipalId,
            AdminSessionId = sessionId,
            Action = "admin.session.revoked",
            Outcome = "success",
            TargetType = "admin_session",
            TargetId = sessionId,
            IsHighImpact = true,
            MetadataJson = metadataJson,
            OccurredAtUtc = occurredAtUtc
        }).ToArray();
        await adminAuditLogChannel.EnqueueManyAsync(audits, cancellationToken);
    }

    private sealed record AdminSessionRevokeCandidate(string SessionId, DateTime? RevokedAtUtc, string RowVersion);

    private sealed record PreparedAdminSession(
        AdminSessionTokens Tokens,
        PreparedAdminSessionProjectionMutation? Mutation);

    private async Task<PreparedAdminSession> CreateSessionAndTokenAsync(
        AdminPrincipal principal,
        AdminAuthClientContext clientContext,
        bool stepUpVerified,
        CancellationToken cancellationToken)
    {
        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        var session = new AdminSession
        {
            SessionId = GenerateSecretToken(),
            AdminPrincipalId = principal.Id,
            DeviceFingerprint = Truncate(clientContext.DeviceFingerprint, 128),
            LastIp = Truncate(clientContext.ClientIp, 64),
            UserAgent = Truncate(clientContext.UserAgent, 512),
            CreatedAtUtc = now,
            LastSeenAtUtc = now,
            IdleExpiresAtUtc = now.Add(s_adminIdleSessionTtl),
            AbsoluteExpiresAtUtc = now.Add(s_adminAbsoluteSessionTtl),
            ValidationVersion = 1,
            StepUpVerified = stepUpVerified
        };

        IssuedAccessToken token = jwtHelper.GenerateAdminAccessToken(principal, session, ParsePermissions(principal.Permissions), stepUpVerified);
        session.AccessTokenHash = HashForStorage(token.Token);
        await db.Insertable(session).ExecuteCommandAsync();
        PreparedAdminSessionProjectionMutation? mutation = await PrepareSessionProjectionMutationAsync(
            [session.SessionId],
            cancellationToken);
        return new PreparedAdminSession(
            new AdminSessionTokens(token.Token, token.ExpiresAtUtc, session.SessionId, session.IdleExpiresAtUtc),
            mutation);
    }

    private Task<PreparedAdminSessionProjectionMutation?> PrepareSessionProjectionMutationAsync(
        IReadOnlyCollection<string> sessionIds,
        CancellationToken cancellationToken)
        => sessionProjectionMutations is null
            ? Task.FromResult<PreparedAdminSessionProjectionMutation?>(null)
            : PrepareCoreAsync(sessionIds, cancellationToken);

    private async Task<PreparedAdminSessionProjectionMutation?> PrepareCoreAsync(
        IReadOnlyCollection<string> sessionIds,
        CancellationToken cancellationToken)
        => await sessionProjectionMutations!
            .PrepareSessionsAsync(sessionIds, cancellationToken)
            .ConfigureAwait(false);

    private Task PublishSessionProjectionMutationAsync(
        PreparedAdminSessionProjectionMutation? mutation,
        CancellationToken cancellationToken)
        => mutation is null || sessionProjectionMutations is null
            ? Task.CompletedTask
            : sessionProjectionMutations.PublishPreparedAsync(mutation, cancellationToken);

    private async Task<bool> RootAdminExistsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<AdminPrincipal>()
            .Where(p => p.IsRoot && p.Status == AdminPrincipalStatus.Active)
            .AnyAsync();
    }

    private async Task AcquireRootBootstrapLockAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (db.CurrentConnectionConfig.DbType != DbType.PostgreSQL)
        {
            return;
        }

        await db.Ado.ExecuteCommandAsync($"SELECT pg_advisory_xact_lock({RootBootstrapAdvisoryLockKey});");
        cancellationToken.ThrowIfCancellationRequested();
    }

    private bool ValidateBootstrapToken(string? suppliedToken, out string error)
    {
        error = string.Empty;
        string configuredToken = Environment.GetEnvironmentVariable(BootstrapTokenEnvironmentVariable)
            ?? configuration["Admin:BootstrapToken"]
            ?? string.Empty;
        if (string.IsNullOrWhiteSpace(configuredToken))
        {
            error = "Admin bootstrap token is not configured";
            return false;
        }

        if (string.IsNullOrWhiteSpace(suppliedToken) || !FixedTimeEquals(configuredToken, suppliedToken.Trim()))
        {
            error = "Invalid admin bootstrap token";
            return false;
        }

        return true;
    }

    private static AdminPasskeyCredential CreateCredential(
        long principalId,
        byte[] userHandle,
        RegisteredPublicKeyCredential result,
        string? friendlyName)
        => new()
        {
            AdminPrincipalId = principalId,
            CredentialId = WebEncoders.Base64UrlEncode(result.Id),
            UserHandle = WebEncoders.Base64UrlEncode(userHandle),
            PublicKey = WebEncoders.Base64UrlEncode(result.PublicKey),
            SignCount = (long)result.SignCount,
            DeviceFriendlyName = Truncate(string.IsNullOrWhiteSpace(friendlyName) ? null : friendlyName.Trim(), 64),
            AaGuid = Guid.Empty.ToString(),
            Transports = result.Transports is { Length: > 0 }
                ? string.Join(",", result.Transports.Select(t => t.ToEnumMemberValue()))
                : null,
            BackupEligible = result.IsBackupEligible,
            BackupState = result.IsBackedUp,
            CreatedAtUtc = DateTime.UtcNow
        };

    private async Task<AdminPasskeyAssertionState?> LoadAdminPasskeyAssertionStateAsync(
        string credentialId,
        long? adminPrincipalId,
        string? adminSessionId,
        CancellationToken cancellationToken)
    {
        bool bindSession = !string.IsNullOrWhiteSpace(adminSessionId);
        string principalPredicate = adminPrincipalId.HasValue ? " AND pc.adminprincipalid = @AdminPrincipalId" : string.Empty;
        string sessionJoin = bindSession
            ? """
              JOIN admin_session s ON s.adminprincipalid = ap.id
                  AND s.sessionid = @AdminSessionId
                  AND s.revokedatutc IS NULL
                  AND s.idleexpiresatutc > @Now
                  AND s.absoluteexpiresatutc > @Now
              """
            : string.Empty;
        string sql = $$"""
            SELECT pc.id AS credential_row_id,
                   pc.adminprincipalid AS admin_principal_id,
                   pc.credentialid AS credential_id,
                   pc.userhandle AS user_handle,
                   pc.publickey AS public_key,
                   pc.signcount AS sign_count,
                   pc.devicefriendlyname AS device_friendly_name,
                   pc.aaguid AS aa_guid,
                   pc.transports AS transports,
                   pc.backupeligible AS backup_eligible,
                   pc.backupstate AS backup_state,
                   pc.createdatutc AS credential_created_at,
                   pc.lastusedatutc AS credential_last_used_at,
                   pc.xmin::text AS row_version,
                   ap.id AS principal_id,
                   ap.handle AS handle,
                   ap.displayname AS display_name,
                   ap.status AS principal_status,
                   ap.isroot AS is_root,
                   ap.permissions AS permissions,
                   ap.createdatutc AS principal_created_at,
                   ap.lastloginatutc AS principal_last_login_at,
                   ap.totpenabled AS totp_enabled,
                   ap.totpsecretencrypted AS totp_secret_encrypted,
                   ap.totpverifiedatutc AS totp_verified_at
            FROM admin_passkey_credential pc
            JOIN admin_principal ap ON ap.id = pc.adminprincipalid
            {{sessionJoin}}
            WHERE pc.credentialid = @CredentialId{{principalPredicate}}
            LIMIT 1;
            """;
        var parameters = new List<SugarParameter>
        {
            new("@CredentialId", credentialId)
        };
        if (adminPrincipalId.HasValue)
        {
            parameters.Add(new SugarParameter("@AdminPrincipalId", adminPrincipalId.Value));
        }

        if (bindSession)
        {
            parameters.Add(new SugarParameter("@AdminSessionId", adminSessionId));
            parameters.Add(new SugarParameter("@Now", DateTime.UtcNow));
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters.ToArray());
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        var credential = new AdminPasskeyCredential
        {
            Id = reader.GetInt64(reader.GetOrdinal("credential_row_id")),
            AdminPrincipalId = reader.GetInt64(reader.GetOrdinal("admin_principal_id")),
            CredentialId = reader.GetString(reader.GetOrdinal("credential_id")),
            UserHandle = reader.GetString(reader.GetOrdinal("user_handle")),
            PublicKey = reader.GetString(reader.GetOrdinal("public_key")),
            SignCount = reader.GetInt64(reader.GetOrdinal("sign_count")),
            DeviceFriendlyName = reader.IsDBNull(reader.GetOrdinal("device_friendly_name")) ? null : reader.GetString(reader.GetOrdinal("device_friendly_name")),
            AaGuid = reader.GetString(reader.GetOrdinal("aa_guid")),
            Transports = reader.IsDBNull(reader.GetOrdinal("transports")) ? null : reader.GetString(reader.GetOrdinal("transports")),
            BackupEligible = reader.GetBoolean(reader.GetOrdinal("backup_eligible")),
            BackupState = reader.GetBoolean(reader.GetOrdinal("backup_state")),
            CreatedAtUtc = reader.GetDateTime(reader.GetOrdinal("credential_created_at")),
            LastUsedAtUtc = reader.IsDBNull(reader.GetOrdinal("credential_last_used_at")) ? null : reader.GetDateTime(reader.GetOrdinal("credential_last_used_at"))
        };
        var principal = new AdminPrincipal
        {
            Id = reader.GetInt64(reader.GetOrdinal("principal_id")),
            Handle = reader.GetString(reader.GetOrdinal("handle")),
            DisplayName = reader.IsDBNull(reader.GetOrdinal("display_name")) ? null : reader.GetString(reader.GetOrdinal("display_name")),
            Status = reader.GetString(reader.GetOrdinal("principal_status")),
            IsRoot = reader.GetBoolean(reader.GetOrdinal("is_root")),
            Permissions = reader.GetString(reader.GetOrdinal("permissions")),
            CreatedAtUtc = reader.GetDateTime(reader.GetOrdinal("principal_created_at")),
            LastLoginAtUtc = reader.IsDBNull(reader.GetOrdinal("principal_last_login_at")) ? null : reader.GetDateTime(reader.GetOrdinal("principal_last_login_at")),
            TotpEnabled = reader.GetBoolean(reader.GetOrdinal("totp_enabled")),
            TotpSecretEncrypted = reader.IsDBNull(reader.GetOrdinal("totp_secret_encrypted")) ? null : reader.GetString(reader.GetOrdinal("totp_secret_encrypted")),
            TotpVerifiedAtUtc = reader.IsDBNull(reader.GetOrdinal("totp_verified_at")) ? null : reader.GetDateTime(reader.GetOrdinal("totp_verified_at"))
        };
        string rowVersion = reader.GetString(reader.GetOrdinal("row_version"));
        return new AdminPasskeyAssertionState(credential, principal, rowVersion);
    }

    private async Task<string?> LoadAdminPasskeyRowVersionAsync(long id, CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT xmin::text AS row_version
            FROM admin_passkey_credential
            WHERE id = @id;
            """,
            new SugarParameter[] { new("@id", id) });
        return await reader.ReadAsync(cancellationToken) ? reader.ReadString("row_version") : null;
    }

    private async Task<bool> TryUpdateAdminPasskeySignCountAsync(
        long id,
        long expectedSignCount,
        string rowVersion,
        long newSignCount,
        DateTime lastUsedAtUtc,
        CancellationToken cancellationToken)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE admin_passkey_credential
            SET signcount = @newSignCount,
                lastusedatutc = @lastUsedAtUtc
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
                new("@lastUsedAtUtc", lastUsedAtUtc)
            });
        cancellationToken.ThrowIfCancellationRequested();
        if (updated != 1)
        {
            return false;
        }

        return true;
    }

    private async Task WriteAuditAsync(
        long? adminPrincipalId,
        string? sessionId,
        string action,
        string outcome,
        AdminAuthClientContext context,
        bool highImpact,
        CancellationToken cancellationToken)
    {
        var audit = new AdminAuditLog
        {
            AdminPrincipalId = adminPrincipalId,
            AdminSessionId = sessionId,
            Action = action,
            Outcome = outcome,
            IpHash = HashForLog(context.ClientIp),
            UserAgentHash = HashForLog(context.UserAgent),
            IsHighImpact = highImpact,
            MetadataJson = "{}",
            OccurredAtUtc = DateTime.UtcNow
        };
        await adminAuditLogChannel.EnqueueAsync(audit, cancellationToken);
    }

    private async Task<bool> IsAdminCredentialIdUniqueAsync(IsCredentialIdUniqueToUserParams param, CancellationToken cancellationToken)
    {
        string credId = WebEncoders.Base64UrlEncode(param.CredentialId);
        int count = await db.Queryable<AdminPasskeyCredential>()
            .Where(c => c.CredentialId == credId)
            .CountAsync();
        return count == 0;
    }

    private static bool IsUniqueViolation(Exception? exception)
    {
        while (exception is not null)
        {
            if (exception is PostgresException postgres &&
                string.Equals(postgres.SqlState, PostgresErrorCodes.UniqueViolation, StringComparison.Ordinal) &&
                string.Equals(postgres.ConstraintName, "unique_idx_admin_principal_active_root", StringComparison.Ordinal))
            {
                return true;
            }

            if (exception.Message.Contains("unique_idx_admin_principal_active_root", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            exception = exception.InnerException;
        }

        return false;
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

    private async Task<T?> ConsumeChallengeAsync<T>(CachePolicyId policyId, string key, CancellationToken cancellationToken)
    {
        CacheReadResult<T> read = await oneTimeStore.ConsumeOnceAndGetAsync<T>(
            policyId,
            key,
            static bytes =>
            {
                string value = Encoding.UTF8.GetString(bytes.Span);
                if (string.IsNullOrWhiteSpace(value))
                {
                    return (false, default);
                }

                T? challenge = JsonSerializer.Deserialize<T>(value, s_challengeCacheJsonOptions);
                return challenge is null ? (false, default) : (true, challenge);
            },
            cancellationToken);
        return read.Hit ? read.Value : default;
    }

    private static string CacheKey(string prefix, string identity)
        => $"{prefix}:{identity}";

    private static string AdminStepUpProofIdentity(long adminPrincipalId, string adminSessionId, string action, string token)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"admin:{adminPrincipalId}:{adminSessionId.Trim()}:{action.Trim()}:{token.Trim()}");

    private static string NormalizeHandle(string? handle)
    {
        string trimmed = (handle ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            return string.Empty;
        }

        Span<char> chars = stackalloc char[Math.Min(trimmed.Length, 64)];
        int written = 0;
        foreach (char ch in trimmed)
        {
            if (written >= chars.Length)
            {
                break;
            }

            chars[written++] = char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '-';
        }

        return new string(chars[..written]).Trim('-');
    }

    private static IReadOnlyCollection<string> ParsePermissions(string permissions)
        => permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static bool IsAdminUserHandleOwner(byte[]? userHandle, string storedUserHandle)
    {
        if (userHandle is null || string.IsNullOrWhiteSpace(storedUserHandle))
        {
            return false;
        }

        byte[] expected = WebEncoders.Base64UrlDecode(storedUserHandle);
        return userHandle.AsSpan().SequenceEqual(expected);
    }

    private static string HashForStorage(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string NormalizeRevokeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason)
            ? "revoked_by_admin"
            : Truncate(reason.Trim(), 128) ?? "revoked_by_admin";

    private static string HashForLog(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..32];

    private static bool FixedTimeEquals(string expected, string actual)
    {
        byte[] expectedBytes = Encoding.UTF8.GetBytes(expected);
        byte[] actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length &&
            CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private static string? Truncate(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private static string GenerateSecretToken()
        => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private sealed record AdminBootstrapChallenge(string Handle, byte[] UserHandle, PasskeyRegisterBeginCoreModel Options);

    private sealed record AdminStepUpChallenge(
        string IdentityKind,
        long AdminPrincipalId,
        string AdminSessionId,
        string Action,
        string ChallengeToken,
        DateTime ExpiresAtUtc,
        PasskeyLoginBeginCoreModel Options)
    {
        public bool IsFor(long adminPrincipalId, string adminSessionId, string action, string challengeToken)
            => string.Equals(IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal) &&
                AdminPrincipalId == adminPrincipalId &&
                string.Equals(AdminSessionId, adminSessionId, StringComparison.Ordinal) &&
                string.Equals(Action, action, StringComparison.Ordinal) &&
                FixedTimeEquals(ChallengeToken, challengeToken) &&
                ExpiresAtUtc > DateTime.UtcNow;
    }
}
