using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using Microsoft.AspNetCore.WebUtilities;
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

public sealed record AdminSessionTokens(string AccessToken, string SessionId, DateTime IdleExpiresAtUtc);

public sealed class AdminPrincipalService(
    IFido2 fido2,
    ISqlSugarClient db,
    IUnifiedCache cache,
    IJwtHelper jwtHelper,
    IConfiguration configuration,
    ILogger<AdminPrincipalService> logger) : IAdminPrincipalService
{
    public const string BootstrapTokenEnvironmentVariable = "FSUSBLOG_ADMIN_BOOTSTRAP_TOKEN";
    private const string BootstrapCachePrefix = "admin-bootstrap";
    private const string LoginCachePrefix = "admin-login";
    private static readonly TimeSpan ChallengeTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan AdminIdleSessionTtl = TimeSpan.FromHours(8);
    private static readonly TimeSpan AdminAbsoluteSessionTtl = TimeSpan.FromHours(12);

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

        string sessionKey = Convert.ToHexString(Guid.NewGuid().ToByteArray());
        PasskeyRegisterBeginCoreModel coreOptions = ToRegisterBeginCore(sessionKey, options);
        var challenge = new AdminBootstrapChallenge(normalizedHandle, userHandle, coreOptions);
        await cache.SetStringAsync(
            CachePolicyId.SecurityPasskeyRegChallenge,
            CacheKey(BootstrapCachePrefix, sessionKey),
            JsonSerializer.Serialize(challenge),
            ChallengeTtl,
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

        AdminBootstrapChallenge? challenge = await ReadChallengeAsync<AdminBootstrapChallenge>(
            CachePolicyId.SecurityPasskeyRegChallenge,
            CacheKey(BootstrapCachePrefix, request.SessionKey),
            cancellationToken);
        if (challenge is null)
        {
            return (false, "Admin bootstrap challenge expired", null);
        }

        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, CacheKey(BootstrapCachePrefix, request.SessionKey), cancellationToken);

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
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Admin bootstrap Passkey registration failed. SessionKeyHash={SessionKeyHash}", HashForLog(request.SessionKey));
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
        principal.Id = await db.Insertable(principal).ExecuteReturnIdentityAsync();

        var credential = CreateCredential(principal.Id, challenge.UserHandle, result, request.FriendlyName);
        await db.Insertable(credential).ExecuteCommandAsync();

        AdminSessionTokens tokens = await CreateSessionAndTokenAsync(principal, clientContext, stepUpVerified: false, cancellationToken);
        await WriteAuditAsync(principal.Id, tokens.SessionId, "admin.bootstrap.completed", "success", clientContext, highImpact: true, cancellationToken);
        return (true, "Root admin bootstrapped", tokens);
    }

    public async Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAdminAssertionAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var options = fido2.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [],
            UserVerification = UserVerificationRequirement.Required
        });

        string challengeToken = Convert.ToHexString(Guid.NewGuid().ToByteArray());
        PasskeyLoginBeginCoreModel coreOptions = ToLoginBeginCore(challengeToken, options);
        await cache.SetStringAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(LoginCachePrefix, challengeToken),
            JsonSerializer.Serialize(coreOptions),
            ChallengeTtl,
            cancellationToken);

        return (true, "已生成 admin Passkey 登录选项", new PasskeyAuthBeginData(coreOptions));
    }

    public async Task<(bool Success, string Message, AdminSessionTokens? Tokens)> CompleteAdminAssertionAsync(
        PasskeyLoginCompleteCoreModel request,
        AdminAuthClientContext clientContext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PasskeyLoginBeginCoreModel? cachedOptions = await ReadChallengeAsync<PasskeyLoginBeginCoreModel>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            CacheKey(LoginCachePrefix, request.ChallengeToken),
            cancellationToken);
        if (cachedOptions is null)
        {
            return (false, "Admin login challenge expired", null);
        }

        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyAuthChallenge, CacheKey(LoginCachePrefix, request.ChallengeToken), cancellationToken);

        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);
        string credentialIdBase64 = assertionResponse.Id;
        AdminPasskeyCredential? storedCred = await db.Queryable<AdminPasskeyCredential>()
            .Where(c => c.CredentialId == credentialIdBase64)
            .FirstAsync();
        if (storedCred is null)
        {
            return (false, "Admin Passkey credential not found", null);
        }

        AdminPrincipal? principal = await db.Queryable<AdminPrincipal>().InSingleAsync(storedCred.AdminPrincipalId);
        if (principal is null || !string.Equals(principal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            return (false, "Admin principal is disabled", null);
        }

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
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Admin Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash}", HashForLog(request.ChallengeToken), HashForLog(credentialIdBase64));
            await WriteAuditAsync(storedCred.AdminPrincipalId, null, "admin.login.passkey_failed", "failure", clientContext, highImpact: true, cancellationToken);
            return (false, "Admin Passkey assertion failed", null);
        }

        storedCred.SignCount = (long)verifyResult.SignCount;
        storedCred.LastUsedAtUtc = DateTime.UtcNow;
        await db.Updateable(storedCred)
            .UpdateColumns(c => new { c.SignCount, c.LastUsedAtUtc })
            .ExecuteCommandAsync();

        principal.LastLoginAtUtc = DateTime.UtcNow;
        await db.Updateable(principal)
            .UpdateColumns(p => new { p.LastLoginAtUtc })
            .ExecuteCommandAsync();

        AdminSessionTokens tokens = await CreateSessionAndTokenAsync(principal, clientContext, stepUpVerified: false, cancellationToken);
        await WriteAuditAsync(principal.Id, tokens.SessionId, "admin.login.completed", "success", clientContext, highImpact: true, cancellationToken);
        return (true, "Admin login completed", tokens);
    }

    private async Task<AdminSessionTokens> CreateSessionAndTokenAsync(
        AdminPrincipal principal,
        AdminAuthClientContext clientContext,
        bool stepUpVerified,
        CancellationToken cancellationToken)
    {
        DateTime now = DateTime.UtcNow;
        var session = new AdminSession
        {
            SessionId = Convert.ToHexString(Guid.NewGuid().ToByteArray()),
            AdminPrincipalId = principal.Id,
            DeviceFingerprint = Truncate(clientContext.DeviceFingerprint, 128),
            LastIp = Truncate(clientContext.ClientIp, 64),
            UserAgent = Truncate(clientContext.UserAgent, 512),
            CreatedAtUtc = now,
            LastSeenAtUtc = now,
            IdleExpiresAtUtc = now.Add(AdminIdleSessionTtl),
            AbsoluteExpiresAtUtc = now.Add(AdminAbsoluteSessionTtl),
            StepUpVerified = stepUpVerified
        };

        string token = jwtHelper.GenerateAdminAccessToken(principal, session, ParsePermissions(principal.Permissions), stepUpVerified);
        session.AccessTokenHash = HashForStorage(token);
        await db.Insertable(session).ExecuteCommandAsync();
        return new AdminSessionTokens(token, session.SessionId, session.IdleExpiresAtUtc);
    }

    private async Task<bool> RootAdminExistsAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await db.Queryable<AdminPrincipal>()
            .Where(p => p.IsRoot && p.Status == AdminPrincipalStatus.Active)
            .AnyAsync();
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
        await db.Insertable(audit).ExecuteCommandAsync();
    }

    private async Task<bool> IsAdminCredentialIdUniqueAsync(IsCredentialIdUniqueToUserParams param, CancellationToken cancellationToken)
    {
        string credId = WebEncoders.Base64UrlEncode(param.CredentialId);
        int count = await db.Queryable<AdminPasskeyCredential>()
            .Where(c => c.CredentialId == credId)
            .CountAsync();
        return count == 0;
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
            UserName = options.User.Name,
            UserDisplayName = options.User.DisplayName,
            UserId = options.User.Id,
            Challenge = options.Challenge,
            PubKeyCredParams = [.. options.PubKeyCredParams.Select(param => new PasskeyPublicKeyCredentialParamCoreModel((int)param.Type, (int)param.Alg))],
            ExcludeCredentials = [.. options.ExcludeCredentials.Select(ToDescriptorCore)]
        };

    private static CredentialCreateOptions ToCredentialCreateOptions(PasskeyRegisterBeginCoreModel value)
        => new()
        {
            Rp = new PublicKeyCredentialRpEntity(value.RpId, value.RpName, null),
            User = new Fido2User { Id = value.UserId, Name = value.UserName, DisplayName = value.UserDisplayName },
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

    private async Task<T?> ReadChallengeAsync<T>(CachePolicyId policyId, string key, CancellationToken cancellationToken)
    {
        string? value = await cache.GetStringAsync(policyId, key, cancellationToken);
        return string.IsNullOrWhiteSpace(value) ? default : JsonSerializer.Deserialize<T>(value);
    }

    private static string CacheKey(string prefix, string identity)
        => $"{prefix}:{identity}";

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

    private sealed record AdminBootstrapChallenge(string Handle, byte[] UserHandle, PasskeyRegisterBeginCoreModel Options);
}
