using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;
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
    string SubjectHash,
    long Epoch,
    string Status,
    DateTime CreatedAtUtc);

public interface ICircuitNativeCredentialIssuer
{
    bool IsConfigured { get; }
    string IssuerPublicKeyId { get; }
    string IssuerPublicKeyHash { get; }

    ValueTask<Result<CircuitNativeCredentialIssueResult>> SignAsync(
        CircuitNativeCredentialIssueMaterial material,
        CancellationToken cancellationToken = default);

    bool VerifyIssuerSignature(CircuitNativeCredentialIssueMaterial material, ReadOnlySpan<byte> signature);
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

    public bool VerifyIssuerSignature(CircuitNativeCredentialIssueMaterial material, ReadOnlySpan<byte> signature)
        => false;
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
                "Managed circuit-native credential issuer is enabled but not configured. backend={Backend} issuer_unconfigured={IssuerUnconfigured}",
                _options.Backend,
                true);
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

    public bool VerifyIssuerSignature(CircuitNativeCredentialIssueMaterial material, ReadOnlySpan<byte> signature)
        => IsConfigured && ManagedCircuitNativeCredentialSigner.Verify(_issuerPublicKey, material, signature);

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
        ValidatePrivateKeyFileSecurity();

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

    private void ValidatePrivateKeyFileSecurity()
    {
        if (!Enabled || string.IsNullOrWhiteSpace(IssuerPrivateKeyPath))
        {
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(IssuerPrivateKeyPath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new InvalidOperationException(
                "AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath must be a valid local file path.",
                ex);
        }

        string[] segments = fullPath.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        string? forbiddenSegment = segments.FirstOrDefault(static segment =>
            string.Equals(segment, "wwwroot", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(segment, "uploads", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(segment, "backups", StringComparison.OrdinalIgnoreCase));
        if (forbiddenSegment is not null)
        {
            throw new InvalidOperationException(
                $"AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath must not be stored under {forbiddenSegment}.");
        }

        if (OperatingSystem.IsWindows() || !File.Exists(fullPath))
        {
            return;
        }

        UnixFileMode mode = File.GetUnixFileMode(fullPath);
        const UnixFileMode allowedMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if ((mode & ~allowedMode) != 0)
        {
            throw new InvalidOperationException(
                "AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath must use Unix permissions no broader than 0600.");
        }
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

        if (!HexText.IsSha256Hex(normalized))
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
                (subject_hash, epoch, status, created_at_utc)
            VALUES
                (@SubjectHash, @Epoch, @Status, @CreatedAtUtc)
            ON CONFLICT(subject_hash, epoch) DO NOTHING;
            """,
            new SugarParameter("@SubjectHash", write.SubjectHash),
            new SugarParameter("@Epoch", write.Epoch),
            new SugarParameter("@Status", write.Status),
            new SugarParameter("@CreatedAtUtc", TruncateToHour(write.CreatedAtUtc)));
        return affected > 0;
    }

    private static DateTime TruncateToHour(DateTime value) =>
        new(value.Year, value.Month, value.Day, value.Hour, 0, 0, DateTimeKind.Utc);
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
    private const int DefaultSlidingWindowHours = 24;
    private const int DefaultSlidingWindowMaxIssuances = 2;

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
        string subjectHash = BuildSubjectHash(userId, configuration);
        string circuitId = NormalizeToken(request.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars);
        if (!string.Equals(circuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) ||
            request.CircuitNumericId == 0 ||
            request.PublicInputLayoutVersion != AnonymousPrivacyContract.PublicInputLayoutVersion)
        {
            await RecordIssuanceAuditAsync(subjectHash, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Validation, "anonymous_credential_circuit_required");
        }

        if (request.CredentialRequest is null ||
            request.CredentialRequest.Length == 0 ||
            request.CredentialRequest.Length > options.MaxCredentialRequestBytes ||
            request.ClientNonce is null ||
            request.ClientNonce.Length == 0 ||
            request.ClientNonce.Length > options.MaxClientNonceBytes)
        {
            await RecordIssuanceAuditAsync(subjectHash, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
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
            await RecordIssuanceAuditAsync(subjectHash, request.CredentialEpoch, "account_deleted", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.NotFound, "anonymous_credential_account_unavailable");
        }

        if (account.Status == UserStatusBanned && !options.AllowBannedAccountIssuance)
        {
            await RecordIssuanceAuditAsync(subjectHash, request.CredentialEpoch, "account_banned", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "anonymous_credential_account_banned");
        }

        if (!string.Equals(NormalizeToken(account.AnonymousCredentialStatus, 32), AnonymousCredentialStatuses.Active, StringComparison.Ordinal))
        {
            await RecordIssuanceAuditAsync(subjectHash, request.CredentialEpoch, "credential_disabled", traceId, cancellationToken);
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
            await RecordIssuanceAuditAsync(subjectHash, epoch, "issuer_unavailable", traceId, cancellationToken);
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
            await RecordIssuanceAuditAsync(subjectHash, epoch, "issuer_unavailable", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(
                issuerSignatureResult.Error.Code,
                issuerSignatureResult.Error.Message);
        }

        string issuerPublicKeyId = NormalizeIssuerPublicKeyId(issuerSignatureResult.Value.IssuerPublicKeyId);
        byte[] issuerSignature = [.. issuerSignatureResult.Value.IssuerSignature];
        if (issuerPublicKeyId.Length == 0 ||
            issuerSignature.Length == 0 ||
            issuerSignature.Length > AnonymousPrivacyContract.MaxCircuitNativeIssuerSignatureBytes ||
            !credentialIssuer.VerifyIssuerSignature(material, issuerSignature))
        {
            await RecordIssuanceAuditAsync(subjectHash, epoch, "issuer_invalid_response", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_issuer_unavailable");
        }

        int recentIssuanceCount = await CountRecentIssuedCredentialsAsync(subjectHash, now.UtcDateTime, cancellationToken);
        if (recentIssuanceCount >= options.SlidingWindowMaxIssuances)
        {
            await RecordIssuanceAuditAsync(subjectHash, epoch, "rate_limited", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Conflict, "anonymous_credential_issue_rate_limited");
        }

        bool recorded = await issuanceAudit.TryRecordIssuedAsync(
            new AnonymousCredentialIssuanceAuditWrite(
                subjectHash,
                epoch,
                AnonymousCredentialIssuanceStatuses.Issued,
                now.UtcDateTime),
            cancellationToken);
        if (!recorded)
        {
            await RecordIssuanceAuditAsync(subjectHash, epoch, "rate_limited", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Conflict, "anonymous_credential_issue_rate_limited");
        }

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
        string subjectHash,
        long epoch,
        string status,
        string? traceId,
        CancellationToken cancellationToken)
    {
        string normalizedStatus = NormalizeToken(status, 32);
        string shortSubjectHash = ShortSubjectHash(subjectHash);
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
            ActorType: AuditActorTypeCatalog.Anonymous,
            ActorId: ShortSubjectHash(subjectHash),
            TargetType: "anonymous_credential_issuance",
            TargetId: string.Concat(shortSubjectHash, ":", epoch.ToString(CultureInfo.InvariantCulture)),
            ReasonCode: normalizedStatus,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["epoch"] = epoch,
                ["status"] = normalizedStatus,
                ["subjectHash"] = shortSubjectHash
            }),
            cancellationToken);
    }

    private async Task<int> CountRecentIssuedCredentialsAsync(
        string subjectHash,
        DateTime nowUtc,
        CancellationToken cancellationToken)
    {
        AnonymousCredentialIssuerOptions options = ResolveOptions(configuration);
        DateTime windowStart = nowUtc.AddHours(-options.SlidingWindowHours);
        return await db.Queryable<AnonymousCredentialIssuanceAudit>()
            .Where(row => row.SubjectHash == subjectHash
                && row.Status == AnonymousCredentialIssuanceStatuses.Issued
                && row.CreatedAtUtc >= windowStart)
            .CountAsync(cancellationToken);
    }

    internal static string BuildSubjectHashForTests(int userId, IConfiguration configuration)
        => BuildSubjectHash(userId, configuration);

    private static string BuildSubjectHash(int userId, IConfiguration configuration)
    {
        byte[] key = ResolveSubjectHashKey(configuration);
        byte[] material = Encoding.UTF8.GetBytes(string.Concat(
            "fsusblog:anonymous-credential-issuance:v1:",
            userId.ToString(CultureInfo.InvariantCulture)));
        return Convert.ToHexStringLower(HMACSHA256.HashData(key, material));
    }

    private static byte[] ResolveSubjectHashKey(IConfiguration configuration)
    {
        string? value = configuration["AnonymousCredentialIssuer:SubjectHashPepper"];
        if (string.IsNullOrWhiteSpace(value) || value.Trim().Length < 32)
        {
            throw new InvalidOperationException("AnonymousCredentialIssuer:SubjectHashPepper must be configured with at least 32 characters.");
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(value.Trim()));
    }

    private static string ShortSubjectHash(string subjectHash)
        => subjectHash.Length <= 16 ? subjectHash : subjectHash[..16];

    private static AnonymousCredentialIssuerOptions ResolveOptions(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection("AnonymousCredentialIssuer");
        int configuredCredentialRequestBytes = section.GetValue("MaxCredentialRequestBytes", AnonymousCredentialIssuerLimits.MaxCredentialRequestBytes);
        return new AnonymousCredentialIssuerOptions(
            section.GetValue("AllowBannedAccountIssuance", false),
            Math.Clamp(configuredCredentialRequestBytes, 1, AnonymousCredentialIssuerLimits.MaxCredentialRequestBytes),
            Math.Clamp(section.GetValue("MaxClientNonceBytes", AnonymousCredentialIssuerLimits.MaxClientNonceBytes), 1, AnonymousCredentialIssuerLimits.MaxClientNonceBytes),
            Math.Clamp(section.GetValue("EpochDurationMinutes", DefaultEpochDurationMinutes), 60, 60 * 24 * 31),
            Math.Clamp(section.GetValue("CredentialTtlMinutes", DefaultCredentialTtlMinutes), 60, 60 * 24 * 31),
            Math.Clamp(section.GetValue("SlidingWindowHours", DefaultSlidingWindowHours), 1, 24 * 31),
            Math.Clamp(section.GetValue("SlidingWindowMaxIssuances", DefaultSlidingWindowMaxIssuances), 1, 100));
    }

    internal static string ResolveIssuerPublicKeyId(IConfiguration configuration)
        => NormalizeIssuerPublicKeyId(configuration["AnonymousCredentialIssuer:IssuerPublicKeyId"]);

    private static string NormalizeIssuerPublicKeyId(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new InvalidOperationException("AnonymousCredentialIssuer:IssuerPublicKeyId must be configured.");
        }

        if (string.Equals(normalized, "CHANGE_ME_ISSUER_PUBLIC_KEY_ID", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("AnonymousCredentialIssuer:IssuerPublicKeyId must not use the checked-in placeholder value.");
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
        string normalized = TextHelpers.NormalizeModeToken(value) ?? string.Empty;
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..maxLength];
    }

    private sealed record AnonymousCredentialIssuerOptions(
        bool AllowBannedAccountIssuance,
        int MaxCredentialRequestBytes,
    int MaxClientNonceBytes,
    int EpochDurationMinutes,
    int CredentialTtlMinutes,
    int SlidingWindowHours,
    int SlidingWindowMaxIssuances);

    private sealed class AnonymousCredentialEligibilityRow
    {
        public int Id { get; set; }
        public int Status { get; set; }
        public DateTime? DeletedAt { get; set; }
        public string AnonymousCredentialLevel { get; set; } = AnonymousCredentialLevels.Basic;
        public string AnonymousCredentialStatus { get; set; } = AnonymousCredentialStatuses.Active;
    }
}
