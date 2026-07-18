using System.Security.Cryptography;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditDetachedCheckpointRuntimeOptions
{
    public const string SectionName = "Audit:DetachedCheckpoint";

    public bool Enabled
    {
        get; set;
    }
    public string DirectoryName { get; set; } = "audit-checkpoints";
    public int IntervalSeconds { get; set; } = 300;
    public int MaxRecords { get; set; } = 1_000;
    public string CurrentKeyId { get; set; } = string.Empty;
    public AuditDetachedCheckpointRuntimeKeyOptions[] Keys { get; set; } = [];
}

public sealed class AuditDetachedCheckpointRuntimeKeyOptions
{
    public string KeyId { get; set; } = string.Empty;
    public int Version
    {
        get; set;
    }
    public string PublicKeyPath { get; set; } = string.Empty;
    public string PrivateKeyPath { get; set; } = string.Empty;
    public DateTimeOffset? NotBeforeUtc
    {
        get; set;
    }
    public DateTimeOffset? NotAfterUtc
    {
        get; set;
    }
    public DateTimeOffset? RevokedAtUtc
    {
        get; set;
    }
    public DateTimeOffset? CompromisedAtUtc
    {
        get; set;
    }
}

public static class AuditDetachedCheckpointRuntimeConfiguration
{
    private const int MinimumIntervalSeconds = 30;
    private const int MaximumIntervalSeconds = 24 * 60 * 60;

    public static void Validate(
        IConfiguration configuration,
        bool enforceProductionRules,
        ICollection<string> errors)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(errors);
        AuditDetachedCheckpointRuntimeOptions options = configuration
            .GetSection(AuditDetachedCheckpointRuntimeOptions.SectionName)
            .Get<AuditDetachedCheckpointRuntimeOptions>() ?? new AuditDetachedCheckpointRuntimeOptions();

        if (!options.Enabled)
        {
            if (enforceProductionRules)
            {
                errors.Add("Audit:DetachedCheckpoint:Enabled must be true in production.");
            }
            return;
        }

        if (!IsSafeRelativeDirectory(options.DirectoryName))
        {
            errors.Add("Audit:DetachedCheckpoint:DirectoryName must be a safe relative data-root directory.");
        }
        if (options.IntervalSeconds is < MinimumIntervalSeconds or > MaximumIntervalSeconds)
        {
            errors.Add($"Audit:DetachedCheckpoint:IntervalSeconds must be in {MinimumIntervalSeconds}..{MaximumIntervalSeconds}.");
        }
        if (options.MaxRecords is < 1 or > 10_000)
        {
            errors.Add("Audit:DetachedCheckpoint:MaxRecords must be in 1..10000.");
        }
        if (string.IsNullOrWhiteSpace(options.CurrentKeyId) ||
            options.CurrentKeyId.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add("Audit:DetachedCheckpoint:CurrentKeyId is required when enabled.");
        }

        AuditDetachedCheckpointRuntimeKeyOptions[] keys = options.Keys ?? [];
        if (keys.Length == 0)
        {
            errors.Add("Audit:DetachedCheckpoint:Keys must contain at least one key.");
            return;
        }

        var keyIds = new HashSet<string>(StringComparer.Ordinal);
        var versions = new HashSet<int>();
        int currentMatches = 0;
        foreach (AuditDetachedCheckpointRuntimeKeyOptions key in keys)
        {
            string keyId = key.KeyId?.Trim() ?? string.Empty;
            if (keyId.Length is 0 or > 128 || !keyIds.Add(keyId))
            {
                errors.Add("Audit:DetachedCheckpoint key ids must be unique non-empty values up to 128 characters.");
            }
            if (key.Version <= 0 || !versions.Add(key.Version))
            {
                errors.Add("Audit:DetachedCheckpoint key versions must be unique positive values.");
            }
            if (!IsSafeDerPath(key.PublicKeyPath))
            {
                errors.Add($"Audit:DetachedCheckpoint key '{keyId}' requires an absolute public SPKI DER path.");
            }
            if (!key.NotBeforeUtc.HasValue ||
                key.NotAfterUtc.HasValue && key.NotAfterUtc <= key.NotBeforeUtc)
            {
                errors.Add($"Audit:DetachedCheckpoint key '{keyId}' requires a valid UTC activation window.");
            }

            if (StringComparer.Ordinal.Equals(keyId, options.CurrentKeyId?.Trim()))
            {
                currentMatches++;
                bool safePrivatePath = IsSafeDerPath(key.PrivateKeyPath);
                bool safePublicPath = IsSafeDerPath(key.PublicKeyPath);
                if (!safePrivatePath || !safePublicPath ||
                    StringComparer.Ordinal.Equals(
                        Path.GetFullPath(key.PrivateKeyPath),
                        Path.GetFullPath(key.PublicKeyPath)))
                {
                    errors.Add("Audit:DetachedCheckpoint current key requires a distinct absolute PKCS#8 DER private-key path.");
                }
                if (key.RevokedAtUtc.HasValue || key.CompromisedAtUtc.HasValue)
                {
                    errors.Add("Audit:DetachedCheckpoint current signing key cannot be revoked or compromised.");
                }
            }
            else if (!string.IsNullOrWhiteSpace(key.PrivateKeyPath))
            {
                errors.Add($"Audit:DetachedCheckpoint historical key '{keyId}' must not expose a private-key path.");
            }
        }

        if (currentMatches != 1)
        {
            errors.Add("Audit:DetachedCheckpoint:CurrentKeyId must match exactly one configured key.");
        }
    }

    internal static string ResolveRootPath(
        IConfiguration configuration,
        AuditDetachedCheckpointRuntimeOptions options)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? AppContext.BaseDirectory;
        string normalizedDataRoot = Path.GetFullPath(dataRoot);
        string directoryName = options.DirectoryName?.Trim()
            ?? throw new InvalidOperationException("audit_checkpoint_directory_invalid");
        string rootPath = Path.GetFullPath(Path.Combine(normalizedDataRoot, directoryName));
        string relative = Path.GetRelativePath(normalizedDataRoot, rootPath);
        if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("audit_checkpoint_root_escape");
        }
        return rootPath;
    }

    internal static AuditCheckpointKeyRegistry LoadKeyRegistry(
        AuditDetachedCheckpointRuntimeOptions options)
    {
        string currentKeyId = options.CurrentKeyId?.Trim()
            ?? throw new InvalidOperationException("audit_checkpoint_current_key_invalid");
        AuditDetachedCheckpointRuntimeKeyOptions[] keys = options.Keys
            ?? throw new InvalidOperationException("audit_checkpoint_keys_invalid");
        var records = new List<AuditCheckpointKeyRecord>(keys.Length);
        foreach (AuditDetachedCheckpointRuntimeKeyOptions key in keys)
        {
            string keyId = key.KeyId?.Trim()
                ?? throw new InvalidOperationException("audit_checkpoint_key_id_invalid");
            byte[] publicKey = ReadDer(key.PublicKeyPath, privateKey: false);
            byte[] privateKey = [];
            try
            {
                ValidatePublicKey(publicKey);
                bool current = StringComparer.Ordinal.Equals(keyId, currentKeyId);
                if (current)
                {
                    privateKey = ReadDer(key.PrivateKeyPath, privateKey: true);
                    ValidateKeyPair(publicKey, privateKey);
                }

                records.Add(new AuditCheckpointKeyRecord(
                    keyId,
                    key.Version,
                    AuditDetachedCheckpointConstants.Algorithm,
                    key.NotBeforeUtc!.Value.ToUniversalTime(),
                    key.NotAfterUtc?.ToUniversalTime(),
                    key.RevokedAtUtc?.ToUniversalTime(),
                    key.CompromisedAtUtc?.ToUniversalTime(),
                    WebEncoders.Base64UrlEncode(publicKey),
                    current ? WebEncoders.Base64UrlEncode(privateKey) : null));
            }
            finally
            {
                CryptographicOperations.ZeroMemory(publicKey);
                CryptographicOperations.ZeroMemory(privateKey);
            }
        }
        return AuditCheckpointKeyRegistry.Create(records, currentKeyId);
    }

    private static byte[] ReadDer(string configuredPath, bool privateKey)
    {
        string path = Path.GetFullPath(configuredPath.Trim());
        FileInfo info = new(path);
        if (!info.Exists || info.LinkTarget is not null || HasForbiddenSecretSegment(path) ||
            !string.Equals(info.Extension, ".der", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(privateKey
                ? "audit_checkpoint_private_key_file_invalid"
                : "audit_checkpoint_public_key_file_invalid");
        }
        if (privateKey && !OperatingSystem.IsWindows())
        {
            UnixFileMode mode = File.GetUnixFileMode(path);
            const UnixFileMode permitted = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            if ((mode & ~permitted) != 0)
            {
                throw new InvalidOperationException("audit_checkpoint_private_key_permissions_invalid");
            }
        }
        return File.ReadAllBytes(path);
    }

    private static void ValidatePublicKey(ReadOnlySpan<byte> publicKey)
    {
        using ECDsa ecdsa = ECDsa.Create();
        ecdsa.ImportSubjectPublicKeyInfo(publicKey, out int bytesRead);
        if (bytesRead != publicKey.Length || ecdsa.KeySize != 256 || !IsNistP256(ecdsa))
        {
            throw new InvalidOperationException("audit_checkpoint_public_key_invalid");
        }
    }

    private static void ValidateKeyPair(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> privateKey)
    {
        using ECDsa signer = ECDsa.Create();
        signer.ImportPkcs8PrivateKey(privateKey, out int privateBytesRead);
        using ECDsa verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(publicKey, out int publicBytesRead);
        if (privateBytesRead != privateKey.Length || publicBytesRead != publicKey.Length ||
            signer.KeySize != 256 || verifier.KeySize != 256 ||
            !IsNistP256(signer) || !IsNistP256(verifier))
        {
            throw new InvalidOperationException("audit_checkpoint_key_pair_invalid");
        }

        Span<byte> challenge = stackalloc byte[32];
        RandomNumberGenerator.Fill(challenge);
        byte[] signature = signer.SignData(challenge, HashAlgorithmName.SHA256);
        try
        {
            if (!verifier.VerifyData(challenge, signature, HashAlgorithmName.SHA256))
            {
                throw new InvalidOperationException("audit_checkpoint_key_pair_mismatch");
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(challenge);
            CryptographicOperations.ZeroMemory(signature);
        }
    }

    private static bool IsSafeRelativeDirectory(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value))
        {
            return false;
        }
        string normalized = value.Trim();
        return normalized != "." && normalized != ".." &&
            !normalized.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries)
                .Any(static segment => segment == "..");
    }

    private static bool IsSafeDerPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            !Path.IsPathRooted(value.Trim()) ||
            !string.Equals(Path.GetExtension(value.Trim()), ".der", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        try
        {
            return !HasForbiddenSecretSegment(Path.GetFullPath(value.Trim()));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    private static bool IsNistP256(ECDsa ecdsa)
        => string.Equals(
            ecdsa.ExportParameters(includePrivateParameters: false).Curve.Oid.Value,
            ECCurve.NamedCurves.nistP256.Oid.Value,
            StringComparison.Ordinal);

    private static bool HasForbiddenSecretSegment(string path)
        => Path.GetFullPath(path)
            .Split(
                [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(static segment =>
                string.Equals(segment, "wwwroot", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "uploads", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "backups", StringComparison.OrdinalIgnoreCase));
}

public sealed class AuditDetachedCheckpointHostedService(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    IOptionsMonitor<AuditDetachedCheckpointRuntimeOptions> optionsMonitor,
    TimeProvider timeProvider,
    ILogger<AuditDetachedCheckpointHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            AuditDetachedCheckpointRuntimeOptions options = optionsMonitor.CurrentValue;
            if (options.Enabled)
            {
                await RunOnceAsync(options, stoppingToken).ConfigureAwait(false);
            }
            await WaitForNextCycleAsync(options, stoppingToken).ConfigureAwait(false);
        }
    }

    internal async Task RunOnceAsync(
        AuditDetachedCheckpointRuntimeOptions options,
        CancellationToken cancellationToken)
    {
        try
        {
            var errors = new List<string>();
            AuditDetachedCheckpointRuntimeConfiguration.Validate(configuration, enforceProductionRules: false, errors);
            if (errors.Count > 0)
            {
                throw new InvalidOperationException("audit_checkpoint_runtime_configuration_invalid");
            }
            using IServiceScope scope = scopeFactory.CreateScope();
            IAuditCheckpointRecordSource source = scope.ServiceProvider.GetRequiredService<IAuditCheckpointRecordSource>();
            AuditCheckpointKeyRegistry registry = AuditDetachedCheckpointRuntimeConfiguration.LoadKeyRegistry(options);
            string rootPath = AuditDetachedCheckpointRuntimeConfiguration.ResolveRootPath(configuration, options);
            Directory.CreateDirectory(rootPath);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(rootPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            var transport = new LocalFileAuditCheckpointTransport(rootPath);
            IReadOnlyList<AuditDetachedCheckpointEnvelope> existing = await transport.ImportAsync(cancellationToken)
                .ConfigureAwait(false);
            AuditCheckpointKeyRegistry publicRegistry = AuditCheckpointKeyRegistry.Create(
                registry.PublicKeys,
                registry.CurrentKeyId);
            var verifier = new AuditDetachedCheckpointVerifier(source, transport, publicRegistry);
            if (existing.Count > 0)
            {
                AuditDetachedCheckpointVerificationResult before = await verifier.VerifyAsync(cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                if (!before.Accepted)
                {
                    throw new InvalidDataException(string.Concat("audit_checkpoint_precreate_verify_", before.Code));
                }
            }

            AuditDetachedCheckpointRuntimeOptions latest = optionsMonitor.CurrentValue;
            if (!latest.Enabled ||
                !StringComparer.Ordinal.Equals(latest.CurrentKeyId?.Trim(), options.CurrentKeyId?.Trim()))
            {
                return;
            }

            var creator = new AuditDetachedCheckpointService(
                source,
                transport,
                transport,
                new AuditCheckpointSigningService(registry),
                timeProvider);
            AuditDetachedCheckpointEnvelope? created = await creator.CreateNextAsync(options.MaxRecords, cancellationToken)
                .ConfigureAwait(false);
            if (created is null)
            {
                return;
            }

            AuditDetachedCheckpointVerificationResult after = await verifier.VerifyAsync(
                AuditDetachedCheckpointTrustAnchor.FromEnvelope(created),
                cancellationToken).ConfigureAwait(false);
            if (!after.Accepted)
            {
                throw new InvalidDataException(string.Concat("audit_checkpoint_postcreate_verify_", after.Code));
            }
            logger.LogInformation(
                "Detached audit checkpoint committed sequence {Sequence} with {RecordCount} records",
                created.Manifest.Sequence,
                created.Manifest.RecordCount);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or InvalidOperationException or ArgumentException or CryptographicException)
        {
            logger.LogError(
                "Detached audit checkpoint cycle failed closed with {FailureType}",
                ex.GetType().Name);
        }
    }

    private async Task WaitForNextCycleAsync(
        AuditDetachedCheckpointRuntimeOptions options,
        CancellationToken stoppingToken)
    {
        int seconds = Math.Clamp(options.IntervalSeconds, 30, 24 * 60 * 60);
        using var reload = new CancellationTokenSource();
        using IDisposable? registration = optionsMonitor.OnChange(_ => reload.Cancel());
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, reload.Token);
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(seconds), timeProvider, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (reload.IsCancellationRequested && !stoppingToken.IsCancellationRequested)
        {
        }
    }
}
