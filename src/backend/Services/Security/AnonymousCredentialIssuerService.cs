using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.Extensions.Logging;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialIssuerService
{
    Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
        int userId,
        AnonymousCredentialIssueRequestCoreModel request,
        string? traceId,
        CancellationToken cancellationToken = default);
}

public interface IAnonymousCredentialIssuanceAuditStore
{
    Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default);
}

public readonly record struct AnonymousCredentialIssuanceAuditWrite(
    int UserId,
    long Epoch,
    string Status,
    DateTime CreatedAtUtc,
    string? TraceId);

public interface ICircuitNativeCredentialIssuer
{
    bool IsConfigured { get; }
    string IssuerPublicKeyId { get; }
    string IssuerPublicKeyHash { get; }

    ValueTask<Result<CircuitNativeCredentialIssueResult>> SignAsync(
        CircuitNativeCredentialIssueMaterial material,
        CancellationToken cancellationToken = default);
}

public readonly record struct CircuitNativeCredentialIssueMaterial(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    byte[] CredentialRequest);

public readonly record struct CircuitNativeCredentialIssueResult(
    string IssuerPublicKeyId,
    byte[] IssuerSignature);

public static class AnonymousCredentialIssuerLimits
{
    public const int MaxIssueRequestFrameBytes = 16 * 1024;
    public const int MaxCredentialRequestBytes = AnonymousPrivacyContract.MaxCircuitNativeCredentialRequestBytes;
    public const int MaxClientNonceBytes = AnonymousPrivacyContract.MaxClientNonceBytes;
    public const int MaxCircuitIdChars = 96;
    public const int MaxCredentialLevelChars = AnonymousPrivacyContract.MaxCredentialLevelBytes;
    public const int MaxIssuerPublicKeyIdChars = 128;
}

public sealed class UnavailableCircuitNativeCredentialIssuer(IConfiguration configuration) : ICircuitNativeCredentialIssuer
{
    public bool IsConfigured => false;

    public string IssuerPublicKeyId => AnonymousCredentialIssuerService.ResolveIssuerPublicKeyId(configuration);

    public string IssuerPublicKeyHash => Convert.ToHexStringLower(
        SHA256.HashData(Encoding.UTF8.GetBytes(IssuerPublicKeyId)));

    public ValueTask<Result<CircuitNativeCredentialIssueResult>> SignAsync(
        CircuitNativeCredentialIssueMaterial material,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Result<CircuitNativeCredentialIssueResult>.Failure(
            ErrorCode.InfraFailure,
            "anonymous_credential_issuer_unavailable"));
    }
}

public sealed class ProductionCircuitNativeCredentialIssuer : ICircuitNativeCredentialIssuer, IDisposable
{
    private readonly CircuitNativeCredentialIssuerOptions _options;
    private readonly CircuitNativeCredentialIssuerConfigurationStatus _status;
    private readonly byte[] _issuerPrivateKey;
    private readonly byte[] _issuerPublicKey;
    private readonly SemaphoreSlim _signatureSlots;
    private readonly ILogger<ProductionCircuitNativeCredentialIssuer> _logger;

    public ProductionCircuitNativeCredentialIssuer(
        IConfiguration configuration,
        ILogger<ProductionCircuitNativeCredentialIssuer> logger)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(logger);

        _logger = logger;
        _options = CircuitNativeCredentialIssuerOptions.FromConfiguration(configuration);
        CircuitNativeCredentialIssuerConfiguration validated = _options.ValidateConfiguration();
        _status = validated.Status;
        _issuerPrivateKey = validated.PrivateKey;
        _issuerPublicKey = validated.PublicKey;
        _signatureSlots = new SemaphoreSlim(_options.MaxConcurrentSignatures, _options.MaxConcurrentSignatures);
        IssuerPublicKeyId = AnonymousCredentialIssuerService.ResolveIssuerPublicKeyId(configuration);

        if (_options.Enabled && !IsConfigured)
        {
            _logger.LogWarning(
                "Managed circuit-native credential issuer is enabled but not configured. backend={Backend} supported={Supported} hasPrivateKey={HasPrivateKey} hasPublicKey={HasPublicKey} publicKeyHashMatches={PublicKeyHashMatches} backendLoaded={BackendLoaded}",
                _options.Backend,
                _status.HasSupportedBackend,
                _status.HasPrivateKey,
                _status.HasPublicKey,
                _status.PublicKeyHashMatches,
                _status.HasRealSigningBackend);
        }
    }

    public bool IsConfigured => _status.CanIssueCredentials;

    public string IssuerPublicKeyId { get; }

    public string IssuerPublicKeyHash => _status.IssuerPublicKeyHash.Length > 0
        ? _status.IssuerPublicKeyHash
        : Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(IssuerPublicKeyId)));

    public async ValueTask<Result<CircuitNativeCredentialIssueResult>> SignAsync(
        CircuitNativeCredentialIssueMaterial material,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsConfigured)
        {
            return Result<CircuitNativeCredentialIssueResult>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }

        TimeSpan queueTimeout = TimeSpan.FromMilliseconds(_options.TimeoutMs);
        if (!await _signatureSlots.WaitAsync(queueTimeout, cancellationToken).ConfigureAwait(false))
        {
            _logger.LogWarning(
                "Managed circuit-native credential issuer queue timed out after {TimeoutMs} ms.",
                _options.TimeoutMs);
            return Result<CircuitNativeCredentialIssueResult>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }

        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] signature = ManagedCircuitNativeCredentialSigner.Sign(
                _issuerPrivateKey,
                _issuerPublicKey,
                material);
            return Result<CircuitNativeCredentialIssueResult>.Success(
                new CircuitNativeCredentialIssueResult(IssuerPublicKeyId, signature));
        }
        catch (CryptographicException)
        {
            _logger.LogWarning("Managed circuit-native credential issuer failed closed during signature generation.");
            return Result<CircuitNativeCredentialIssueResult>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }
        finally
        {
            _signatureSlots.Release();
        }
    }

    public void Dispose() => _signatureSlots.Dispose();
}

internal sealed record CircuitNativeCredentialIssuerOptions(
    bool Enabled,
    string IssuerPrivateKeyPath,
    string IssuerPublicKeyPath,
    string IssuerPublicKeyHash,
    string Backend,
    int MaxConcurrentSignatures,
    int TimeoutMs)
{
    public const string SectionName = "AnonymousCredentialIssuer:CircuitNative";
    public const string ManagedCircuitNativeBackend = "managed_circuit_native_v2";
    private const int DefaultMaxConcurrentSignatures = 2;
    private const int DefaultTimeoutMs = 2_000;

    public static CircuitNativeCredentialIssuerOptions FromConfiguration(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        return new CircuitNativeCredentialIssuerOptions(
            section.GetValue(nameof(Enabled), false),
            NormalizePath(section[nameof(IssuerPrivateKeyPath)]),
            NormalizePath(section[nameof(IssuerPublicKeyPath)]),
            NormalizeSha256(section[nameof(IssuerPublicKeyHash)]),
            NormalizeToken(section[nameof(Backend)], fallback: string.Empty, maxLength: 64),
            Math.Clamp(
                section.GetValue(nameof(MaxConcurrentSignatures), DefaultMaxConcurrentSignatures),
                1,
                Environment.ProcessorCount <= 0 ? 1 : Environment.ProcessorCount),
            Math.Clamp(section.GetValue(nameof(TimeoutMs), DefaultTimeoutMs), 100, 30_000));
    }

    public CircuitNativeCredentialIssuerConfiguration ValidateConfiguration()
    {
        bool privateKeyReadable = ManagedCircuitNativeCredentialSigner.TryReadPrivateKeyFile(
            IssuerPrivateKeyPath,
            out byte[] privateKey);
        bool publicKeyReadable = ManagedCircuitNativeCredentialSigner.TryReadPublicKeyFile(
            IssuerPublicKeyPath,
            out byte[] publicKey);
        bool publicKeyDerivedFromPrivateKey = false;
        if (privateKeyReadable)
        {
            try
            {
                byte[] derivedPublicKey = ManagedCircuitNativeCredentialSigner.DerivePublicKey(privateKey);
                publicKeyDerivedFromPrivateKey = publicKeyReadable &&
                    CryptographicOperations.FixedTimeEquals(derivedPublicKey, publicKey);
            }
            catch (CryptographicException)
            {
                privateKeyReadable = false;
            }
        }

        string actualPublicKeyHash = publicKeyReadable
            ? Convert.ToHexStringLower(SHA256.HashData(publicKey))
            : string.Empty;
        bool publicKeyHashMatches = IssuerPublicKeyHash.Length > 0 &&
            string.Equals(actualPublicKeyHash, IssuerPublicKeyHash, StringComparison.Ordinal);
        bool supportedBackend = string.Equals(Backend, ManagedCircuitNativeBackend, StringComparison.Ordinal);
        bool hasRealSigningBackend = supportedBackend &&
            privateKeyReadable &&
            publicKeyReadable &&
            publicKeyDerivedFromPrivateKey &&
            publicKeyHashMatches;
        var status = new CircuitNativeCredentialIssuerConfigurationStatus(
            Enabled,
            supportedBackend,
            privateKeyReadable,
            publicKeyReadable,
            publicKeyHashMatches,
            publicKeyHashMatches ? actualPublicKeyHash : IssuerPublicKeyHash,
            hasRealSigningBackend);
        return new CircuitNativeCredentialIssuerConfiguration(
            status,
            hasRealSigningBackend ? privateKey : [],
            hasRealSigningBackend ? publicKey : []);
    }

    private static string NormalizePath(string? value)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= 4096 ? normalized : normalized[..4096];
    }

    private static string NormalizeToken(string? value, string fallback, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string NormalizeSha256(string? value)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        if (normalized.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized["sha256:".Length..];
        }

        if (normalized.Length != 64 || normalized.Any(static ch => !Uri.IsHexDigit(ch)))
        {
            return string.Empty;
        }

        return normalized.ToLowerInvariant();
    }

}

internal readonly record struct CircuitNativeCredentialIssuerConfiguration(
    CircuitNativeCredentialIssuerConfigurationStatus Status,
    byte[] PrivateKey,
    byte[] PublicKey);

internal readonly record struct CircuitNativeCredentialIssuerConfigurationStatus(
    bool Enabled,
    bool HasSupportedBackend,
    bool HasPrivateKey,
    bool HasPublicKey,
    bool PublicKeyHashMatches,
    string IssuerPublicKeyHash,
    bool HasRealSigningBackend)
{
    public bool CanIssueCredentials =>
        Enabled &&
        HasSupportedBackend &&
        HasPrivateKey &&
        HasPublicKey &&
        PublicKeyHashMatches &&
        HasRealSigningBackend;
}

public sealed class AnonymousCredentialIssuanceAuditStore(ISqlSugarClient db) : IAnonymousCredentialIssuanceAuditStore
{
    public async Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO anonymous_credential_issuance_audit
                (user_id, epoch, status, created_at_utc, trace_id)
            VALUES
                (@UserId, @Epoch, @Status, @CreatedAtUtc, @TraceId)
            ON CONFLICT(user_id, epoch) DO NOTHING;
            """,
            new SugarParameter("@UserId", write.UserId),
            new SugarParameter("@Epoch", write.Epoch),
            new SugarParameter("@Status", write.Status),
            new SugarParameter("@CreatedAtUtc", write.CreatedAtUtc),
            new SugarParameter("@TraceId", write.TraceId));
        return affected > 0;
    }
}

public sealed class AnonymousCredentialIssuerService(
    ISqlSugarClient db,
    IAnonymousCredentialIssuanceAuditStore issuanceAudit,
    ICircuitNativeCredentialIssuer credentialIssuer,
    IAuditEventService auditEvents,
    IConfiguration configuration) : IAnonymousCredentialIssuerService
{
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private const int DefaultEpochDurationMinutes = 1440;
    private const int DefaultCredentialTtlMinutes = 1440;

    public async Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
        int userId,
        AnonymousCredentialIssueRequestCoreModel request,
        string? traceId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (userId <= 0)
        {
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Unauthorized, "anonymous_credential_auth_required");
        }

        AnonymousCredentialIssuerOptions options = ResolveOptions(configuration);
        string circuitId = NormalizeToken(request.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars);
        if (!string.Equals(circuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) ||
            request.CircuitNumericId == 0 ||
            request.PublicInputLayoutVersion != AnonymousPrivacyContract.PublicInputLayoutVersion)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Validation, "anonymous_credential_circuit_required");
        }

        if (request.CredentialRequest is null ||
            request.CredentialRequest.Length == 0 ||
            request.CredentialRequest.Length > options.MaxCredentialRequestBytes ||
            request.ClientNonce is null ||
            request.ClientNonce.Length == 0 ||
            request.ClientNonce.Length > options.MaxClientNonceBytes)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Validation, "anonymous_credential_issue_request_invalid");
        }

        AnonymousCredentialEligibilityRow? account = await db.Queryable<User>()
            .Where(user => user.Id == userId)
            .Select(user => new AnonymousCredentialEligibilityRow
            {
                Id = user.Id,
                Status = user.Status,
                DeletedAt = user.DeletedAt,
                AnonymousCredentialLevel = user.AnonymousCredentialLevel,
                AnonymousCredentialStatus = user.AnonymousCredentialStatus
            })
            .FirstAsync();
        if (account is null || account.DeletedAt.HasValue || account.Status == UserStatusDeleted)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "account_deleted", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.NotFound, "anonymous_credential_account_unavailable");
        }

        if (account.Status == UserStatusBanned && !options.AllowBannedAccountIssuance)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "account_banned", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "anonymous_credential_account_banned");
        }

        if (!string.Equals(NormalizeToken(account.AnonymousCredentialStatus, 32), AnonymousCredentialStatuses.Active, StringComparison.Ordinal))
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "credential_disabled", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "anonymous_credential_disabled");
        }

        DateTimeOffset now = DateTimeOffset.UtcNow;
        long epoch = request.CredentialEpoch > 0
            ? request.CredentialEpoch
            : ResolveCurrentEpoch(now, options.EpochDurationMinutes);

        string credentialLevel = NormalizeToken(account.AnonymousCredentialLevel, AnonymousCredentialIssuerLimits.MaxCredentialLevelChars);
        if (credentialLevel.Length == 0)
        {
            credentialLevel = AnonymousCredentialLevels.Basic;
        }

        if (!credentialIssuer.IsConfigured)
        {
            await RecordIssuanceAuditAsync(userId, epoch, "issuer_unavailable", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }

        var material = new CircuitNativeCredentialIssueMaterial(
            epoch,
            request.CircuitNumericId,
            request.PublicInputLayoutVersion,
            circuitId,
            credentialLevel,
            [.. request.CredentialRequest]);
        Result<CircuitNativeCredentialIssueResult> issuerSignatureResult = await credentialIssuer.SignAsync(material, cancellationToken);
        if (!issuerSignatureResult.IsSuccess)
        {
            await RecordIssuanceAuditAsync(userId, epoch, "issuer_unavailable", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(
                issuerSignatureResult.Error.Code,
                issuerSignatureResult.Error.Message);
        }

        string issuerPublicKeyId = NormalizeIssuerPublicKeyId(issuerSignatureResult.Value.IssuerPublicKeyId);
        byte[] issuerSignature = [.. issuerSignatureResult.Value.IssuerSignature];
        if (issuerPublicKeyId.Length == 0 ||
            issuerSignature.Length == 0 ||
            issuerSignature.Length > AnonymousPrivacyContract.MaxCircuitNativeIssuerSignatureBytes)
        {
            await RecordIssuanceAuditAsync(userId, epoch, "issuer_invalid_response", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }

        bool recorded = await issuanceAudit.TryRecordIssuedAsync(
            new AnonymousCredentialIssuanceAuditWrite(
                userId,
                epoch,
                AnonymousCredentialIssuanceStatuses.Issued,
                now.UtcDateTime,
                NormalizeTraceId(traceId)),
            cancellationToken);
        if (!recorded)
        {
            await RecordIssuanceAuditAsync(userId, epoch, "rate_limited", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Conflict, "anonymous_credential_issue_rate_limited");
        }

        await RecordIssuanceAuditAsync(userId, epoch, AnonymousCredentialIssuanceStatuses.Issued, traceId, cancellationToken);

        long expiresAtUnixMs = now.AddMinutes(options.CredentialTtlMinutes).ToUnixTimeMilliseconds();
        var response = new AnonymousCredentialIssueResponseCoreModel(
            epoch,
            expiresAtUnixMs,
            request.CircuitNumericId,
            request.PublicInputLayoutVersion,
            circuitId,
            credentialLevel,
            issuerPublicKeyId,
            issuerSignature);
        return Result<AnonymousCredentialIssueResponseCoreModel>.Success(response);
    }

    private Task RecordIssuanceAuditAsync(
        int userId,
        long epoch,
        string status,
        string? traceId,
        CancellationToken cancellationToken)
    {
        string normalizedStatus = NormalizeToken(status, 32);
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            AuditActionCatalog.AnonymousCredentialIssued,
            string.Equals(normalizedStatus, AnonymousCredentialIssuanceStatuses.Issued, StringComparison.Ordinal)
                ? AuditOutcomeCatalog.Success
                : AuditOutcomeCatalog.Denied,
            string.Equals(normalizedStatus, AnonymousCredentialIssuanceStatuses.Issued, StringComparison.Ordinal)
                ? AuditSeverityCatalog.Info
                : AuditSeverityCatalog.Warning,
            "匿名凭证签发结果",
            ActorType: AuditActorTypeCatalog.User,
            ActorId: userId.ToString(CultureInfo.InvariantCulture),
            TargetType: "anonymous_credential_issuance",
            TargetId: epoch.ToString(CultureInfo.InvariantCulture),
            ReasonCode: normalizedStatus,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["epoch"] = epoch,
                ["status"] = normalizedStatus
            }),
            cancellationToken);
    }

    private static AnonymousCredentialIssuerOptions ResolveOptions(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection("AnonymousCredentialIssuer");
        int configuredCredentialRequestBytes = section.GetValue("MaxCredentialRequestBytes", AnonymousCredentialIssuerLimits.MaxCredentialRequestBytes);
        return new AnonymousCredentialIssuerOptions(
            section.GetValue("AllowBannedAccountIssuance", false),
            Math.Clamp(configuredCredentialRequestBytes, 1, AnonymousCredentialIssuerLimits.MaxCredentialRequestBytes),
            Math.Clamp(section.GetValue("MaxClientNonceBytes", AnonymousCredentialIssuerLimits.MaxClientNonceBytes), 1, AnonymousCredentialIssuerLimits.MaxClientNonceBytes),
            Math.Clamp(section.GetValue("EpochDurationMinutes", DefaultEpochDurationMinutes), 60, 60 * 24 * 31),
            Math.Clamp(section.GetValue("CredentialTtlMinutes", DefaultCredentialTtlMinutes), 60, 60 * 24 * 31));
    }

    internal static string ResolveIssuerPublicKeyId(IConfiguration configuration)
        => NormalizeIssuerPublicKeyId(configuration["AnonymousCredentialIssuer:IssuerPublicKeyId"]);

    private static string NormalizeIssuerPublicKeyId(string? value)
    {
        string normalized = (value ?? "issuer-key:local").Trim();
        if (normalized.Length == 0)
        {
            normalized = "issuer-key:local";
        }

        return normalized.Length <= AnonymousCredentialIssuerLimits.MaxIssuerPublicKeyIdChars
            ? normalized
            : normalized[..AnonymousCredentialIssuerLimits.MaxIssuerPublicKeyIdChars];
    }

    private static long ResolveCurrentEpoch(DateTimeOffset now, int epochDurationMinutes)
    {
        long epochDurationMs = (long)epochDurationMinutes * 60_000L;
        return now.ToUnixTimeMilliseconds() / epochDurationMs;
    }

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..maxLength];
    }

    private static string? NormalizeTraceId(string? traceId)
    {
        string normalized = (traceId ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private sealed record AnonymousCredentialIssuerOptions(
        bool AllowBannedAccountIssuance,
        int MaxCredentialRequestBytes,
        int MaxClientNonceBytes,
        int EpochDurationMinutes,
        int CredentialTtlMinutes);

    private sealed class AnonymousCredentialEligibilityRow
    {
        public int Id { get; set; }
        public int Status { get; set; }
        public DateTime? DeletedAt { get; set; }
        public string AnonymousCredentialLevel { get; set; } = AnonymousCredentialLevels.Basic;
        public string AnonymousCredentialStatus { get; set; } = AnonymousCredentialStatuses.Active;
    }
}
