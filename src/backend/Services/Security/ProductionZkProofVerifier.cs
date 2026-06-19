using FsusBlog.Server.Models.CommentIdentity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Services.Security;

public interface IProductionZkProofBackend
{
    bool IsAvailable(string backendName);

    Task<ProductionZkProofBackendResult> VerifyAsync(
        ProductionZkProofBackendRequest request,
        CancellationToken cancellationToken = default);
}

public readonly record struct ProductionZkProofBackendRequest(
    string ActionContext,
    string Scope,
    string CircuitId,
    string VerifyingKeyHash,
    ushort PublicInputLayoutVersion,
    long CredentialEpoch,
    string NullifierHash,
    string CredentialCommitment,
    string CredentialRoot,
    string? ReputationBucket,
    ReadOnlyMemory<byte> Proof);

public readonly record struct ProductionZkProofBackendResult(bool Verified, string Reason)
{
    public static ProductionZkProofBackendResult Accepted()
        => new(true, "verified");

    public static ProductionZkProofBackendResult Rejected(string? reason = null)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "invalid" : reason);
}

public sealed class UnavailableProductionZkProofBackend : IProductionZkProofBackend
{
    public bool IsAvailable(string backendName) => false;

    public Task<ProductionZkProofBackendResult> VerifyAsync(
        ProductionZkProofBackendRequest request,
        CancellationToken cancellationToken = default)
        => Task.FromResult(ProductionZkProofBackendResult.Rejected("backend_unavailable"));
}

public sealed class ProductionZkProofVerifier : IZkProofVerifier, IDisposable
{
    private const string SectionName = "AnonymousIdentity:ZkVerifier";
    private const string CommentActionContext = "comment.create";
    private const int DefaultMaxProofBytes = 16 * 1024;
    private static readonly TimeSpan DefaultBackendTimeout = TimeSpan.FromSeconds(2);

    private readonly ProductionZkProofVerifierOptions _options;
    private readonly IAnonymousCredentialRootReader _rootReader;
    private readonly IProductionZkProofBackend _backend;
    private readonly ILogger<ProductionZkProofVerifier> _logger;
    private readonly SemaphoreSlim _concurrencyGate;
    private readonly bool _backendAvailable;

    public ProductionZkProofVerifier(
        IConfiguration configuration,
        IAnonymousCredentialRootReader rootReader,
        IProductionZkProofBackend backend,
        ILogger<ProductionZkProofVerifier> logger)
    {
        _options = ResolveOptions(configuration);
        _rootReader = rootReader;
        _backend = backend;
        _logger = logger;
        _concurrencyGate = new SemaphoreSlim(_options.MaxConcurrentVerifications, _options.MaxConcurrentVerifications);
        _backendAvailable = _options.Enabled &&
            _options.IsComplete &&
            _backend.IsAvailable(_options.Backend);
    }

    public bool IsConfigured => _backendAvailable;

    public static bool IsEnabled(IConfiguration configuration)
        => configuration.GetValue($"{SectionName}:Enabled", false);

    public async Task<ZkProofVerificationResult> VerifyAsync(
        ZkProofVerificationRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!IsConfigured)
        {
            return ZkProofVerificationResult.VerifierUnavailable();
        }

        if (!PassesCheapChecks(request))
        {
            return ZkProofVerificationResult.InvalidProof();
        }

        if (!_rootReader.IsRootAccepted(request.CredentialRoot, request.CredentialEpoch))
        {
            return ZkProofVerificationResult.InvalidProof();
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_options.BackendTimeout);
        bool entered = false;
        try
        {
            await _concurrencyGate.WaitAsync(timeout.Token);
            entered = true;
            ProductionZkProofBackendResult backendResult = await _backend.VerifyAsync(
                    new ProductionZkProofBackendRequest(
                        request.ActionContext.Trim(),
                        request.Scope.Trim(),
                        request.CircuitId.Trim(),
                        request.VerifyingKeyHash.Trim(),
                        request.PublicInputLayoutVersion,
                        request.CredentialEpoch,
                        request.NullifierHash.Trim(),
                        request.CredentialCommitment.Trim(),
                        request.CredentialRoot.Trim(),
                        NormalizeNullable(request.ReputationBucket, 64),
                        request.Proof),
                    timeout.Token)
                .WaitAsync(_options.BackendTimeout, cancellationToken);

            if (backendResult.Verified)
            {
                return ZkProofVerificationResult.Success();
            }

            _logger.LogWarning("ZK proof backend rejected proof for configured backend {Backend}.", _options.Backend);
            return ZkProofVerificationResult.InvalidProof();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("ZK proof backend timed out for configured backend {Backend}.", _options.Backend);
            return ZkProofVerificationResult.InvalidProof();
        }
        catch (TimeoutException)
        {
            timeout.Cancel();
            _logger.LogWarning("ZK proof backend timed out for configured backend {Backend}.", _options.Backend);
            return ZkProofVerificationResult.InvalidProof();
        }
        catch (Exception)
        {
            _logger.LogWarning("ZK proof backend failed closed for configured backend {Backend}.", _options.Backend);
            return ZkProofVerificationResult.InvalidProof();
        }
        finally
        {
            if (entered)
            {
                _concurrencyGate.Release();
            }
        }
    }

    public void Dispose()
        => _concurrencyGate.Dispose();

    private bool PassesCheapChecks(ZkProofVerificationRequest request)
    {
        if (!string.Equals(request.ActionContext, CommentActionContext, StringComparison.Ordinal) ||
            !string.Equals(request.CircuitId, _options.CircuitId, StringComparison.Ordinal) ||
            !string.Equals(request.VerifyingKeyHash, _options.VerifyingKeyHash, StringComparison.Ordinal) ||
            request.PublicInputLayoutVersion != _options.PublicInputLayoutVersion ||
            request.CredentialEpoch <= 0 ||
            request.Proof.Length == 0 ||
            request.Proof.Length > _options.MaxProofBytes)
        {
            return false;
        }

        return IsScope(request.Scope) &&
            IsHexHash(request.NullifierHash, minLength: 32, maxLength: 128) &&
            IsHexHash(request.CredentialCommitment, minLength: 32, maxLength: 128) &&
            IsToken(request.CredentialRoot, maxLength: 128);
    }

    private static ProductionZkProofVerifierOptions ResolveOptions(IConfiguration configuration)
    {
        string circuitId = NormalizeToken(configuration[$"{SectionName}:CircuitId"], 128);
        string verifyingKeyHash = NormalizeToken(configuration[$"{SectionName}:VerifyingKeyHash"], 128);
        string backend = NormalizeToken(configuration[$"{SectionName}:Backend"], 64);
        ushort layoutVersion = ResolveUShort(configuration, $"{SectionName}:PublicInputLayoutVersion");
        int maxProofBytes = configuration.GetValue($"{SectionName}:MaxProofBytes", DefaultMaxProofBytes);
        if (maxProofBytes <= 0)
        {
            maxProofBytes = DefaultMaxProofBytes;
        }

        int timeoutMs = configuration.GetValue($"{SectionName}:BackendTimeoutMs", (int)DefaultBackendTimeout.TotalMilliseconds);
        timeoutMs = Math.Clamp(timeoutMs, 1, 30_000);
        int maxConcurrent = configuration.GetValue($"{SectionName}:MaxConcurrentVerifications", Math.Max(1, Environment.ProcessorCount / 2));
        maxConcurrent = Math.Clamp(maxConcurrent, 1, 64);

        return new ProductionZkProofVerifierOptions(
            configuration.GetValue($"{SectionName}:Enabled", false),
            circuitId,
            verifyingKeyHash,
            layoutVersion,
            maxProofBytes,
            backend,
            TimeSpan.FromMilliseconds(timeoutMs),
            maxConcurrent);
    }

    private static ushort ResolveUShort(IConfiguration configuration, string key)
    {
        int value = configuration.GetValue(key, 0);
        return value <= 0 ? (ushort)0 : (ushort)Math.Min(value, ushort.MaxValue);
    }

    private static bool IsScope(string value)
        => IsToken(value, maxLength: 128);

    private static bool IsHexHash(string value, int minLength, int maxLength)
    {
        string normalized = NormalizeToken(value, maxLength);
        if (normalized.Length < minLength)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            if (!Uri.IsHexDigit(normalized[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsToken(string value, int maxLength)
    {
        string normalized = NormalizeToken(value, maxLength);
        if (normalized.Length == 0)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char ch = normalized[i];
            if (char.IsAsciiLetterOrDigit(ch) ||
                ch is '.' or '_' or '-' or ':' or '/')
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        string normalized = NormalizeToken(value, maxLength);
        return normalized.Length == 0 ? null : normalized;
    }

    private readonly record struct ProductionZkProofVerifierOptions(
        bool Enabled,
        string CircuitId,
        string VerifyingKeyHash,
        ushort PublicInputLayoutVersion,
        int MaxProofBytes,
        string Backend,
        TimeSpan BackendTimeout,
        int MaxConcurrentVerifications)
    {
        public bool IsComplete =>
            CircuitId.Length > 0 &&
            VerifyingKeyHash.Length > 0 &&
            PublicInputLayoutVersion > 0 &&
            MaxProofBytes > 0 &&
            Backend.Length > 0 &&
            MaxConcurrentVerifications > 0;
    }
}
