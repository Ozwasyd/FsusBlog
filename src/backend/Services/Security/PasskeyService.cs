using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using System.Buffers.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IPasskeyService
{
    Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync(int userId, string username, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message)> CompleteRegistrationAsync(int userId, PasskeyRegisterCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, PasskeyAuthBeginData? Data)> BeginAssertionAsync(CancellationToken cancellationToken = default);
    Task<(bool Success, string Message, User? User)> CompleteAssertionAsync(PasskeyLoginCompleteCoreModel request, CancellationToken cancellationToken = default);
    Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int userId, CancellationToken cancellationToken = default);
    Task<bool> RemoveCredentialAsync(int userId, int credId, CancellationToken cancellationToken = default);
    Task<bool> RenameCredentialAsync(int userId, int credId, string name, CancellationToken cancellationToken = default);
}

public sealed record PasskeyRegBeginData(PasskeyRegisterBeginCoreModel Options);
public sealed record PasskeyAuthBeginData(PasskeyLoginBeginCoreModel Options);

public sealed class PasskeyService(
    IFido2 fido2,
    ISqlSugarClient db,
    IUnifiedCache cache,
    ILogger<PasskeyService> logger) : IPasskeyService
{
    private const int MaxCredentialsPerUser = 5;

    // ─────────────────────────────────────────────────────────────────────
    // Registration
    // ─────────────────────────────────────────────────────────────────────

    public async Task<(bool Success, string Message, PasskeyRegBeginData? Data)> BeginRegistrationAsync(int userId, string username, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var existingCreds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.UserId == userId)
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

        var fidoUser = new Fido2User
        {
            Id = BitConverter.GetBytes(userId),
            Name = username,
            DisplayName = username
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

        string sessionKey = Convert.ToHexString(Guid.NewGuid().ToByteArray());
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
        int userId,
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

        // 删除 challenge，防止重放
        await cache.RemoveAsync(CachePolicyId.SecurityPasskeyRegChallenge, request.SessionKey, cancellationToken);

        var options = ToCredentialCreateOptions(cached.Value);
        AuthenticatorAttestationRawResponse attestationResponse = ToAttestationResponse(request);

        // 检查上限（并发保护）
        int existingCount = await db.Queryable<PasskeyCredential>()
            .Where(c => c.UserId == userId)
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
                "Passkey registration failed. UserId={UserId} SessionKeyHash={SessionKeyHash} ExceptionType={ExceptionType}",
                userId,
                HashForLog(request.SessionKey),
                ex.GetType().Name);
            return (false, "通行密钥验证失败，请重试");
        }

        string credentialIdBase64 = Base64Url.EncodeToString(result.Id);
        string publicKeyBase64 = Base64Url.EncodeToString(result.PublicKey);
        string aaGuid = Guid.Empty.ToString();

        string? transportsStr = result.Transports is { Length: > 0 }
            ? string.Join(",", result.Transports.Select(t => t.ToEnumMemberValue()))
            : null;

        var credential = new PasskeyCredential
        {
            UserId = userId,
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

        string challengeToken = Convert.ToHexString(Guid.NewGuid().ToByteArray());
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
        AuthenticatorAssertionRawResponse assertionResponse = ToAssertionResponse(request);

        string credentialIdBase64 = assertionResponse.Id;
        var storedCred = await db.Queryable<PasskeyCredential>()
            .Where(c => c.CredentialId == credentialIdBase64)
            .FirstAsync();

        if (storedCred == null)
        {
            return (false, "未找到对应的通行密钥", null);
        }

        var user = await db.Queryable<User>()
            .InSingleAsync(storedCred.UserId);

        if (user == null || user.Status == 2 || user.DeletedAt.HasValue)
        {
            return (false, "账户不存在或已注销", null);
        }

        if (user.Status == 1)
        {
            return (false, "账户已被封禁", null);
        }

        byte[] storedPublicKey = Base64Url.DecodeFromChars(storedCred.PublicKey);

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
                {
                    if (param.UserHandle is null || param.UserHandle.Length != sizeof(int))
                    {
                        return Task.FromResult(false);
                    }

                    int uid = BitConverter.ToInt32(param.UserHandle, 0);
                    return Task.FromResult(uid == storedCred.UserId);
                }
            });
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Passkey assertion failed. ChallengeHash={ChallengeHash} CredentialHash={CredentialHash} UserId={UserId} ExceptionType={ExceptionType}",
                HashForLog(request.ChallengeToken),
                HashForLog(credentialIdBase64),
                storedCred.UserId,
                ex.GetType().Name);
            return (false, "通行密钥验证失败，请重试", null);
        }

        // 更新签名计数 + 上次使用时间
        storedCred.SignCount = (long)verifyResult.SignCount;
        storedCred.LastUsedAt = DateTime.UtcNow;
        await db.Updateable(storedCred)
            .UpdateColumns(c => new { c.SignCount, c.LastUsedAt })
            .ExecuteCommandAsync();

        return (true, "验证成功", user);
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

    private static string HashForLog(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)))[..32];

    // ─────────────────────────────────────────────────────────────────────
    // Credential management
    // ─────────────────────────────────────────────────────────────────────

    public async Task<IList<PasskeyCredentialSummaryDto>> GetCredentialsAsync(int userId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var creds = await db.Queryable<PasskeyCredential>()
            .Where(c => c.UserId == userId)
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

    public async Task<bool> RemoveCredentialAsync(int userId, int credId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int deleted = await db.Deleteable<PasskeyCredential>()
            .Where(c => c.Id == credId && c.UserId == userId)
            .ExecuteCommandAsync();
        return deleted > 0;
    }

    public async Task<bool> RenameCredentialAsync(int userId, int credId, string name, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length > 64) trimmed = trimmed[..64];

        int updated = await db.Updateable<PasskeyCredential>()
            .Where(c => c.Id == credId && c.UserId == userId)
            .SetColumns(c => c.DeviceFriendlyName == trimmed)
            .ExecuteCommandAsync();
        return updated > 0;
    }
}
