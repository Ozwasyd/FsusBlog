using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Shared.Contracts.Validation;

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
    string NullifierHash,
    string CredentialRoot,
    string PolicyHash,
    bool IsEligible,
    bool MayComment,
    string RateClass,
    bool RequiresModeration,
    ReadOnlyMemory<byte> Proof,
    string RevocationRoot = "",
    string IssuerPublicKeyHash = "");

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

public sealed class LocalDevZkProofBackend(IConfiguration configuration) : IProductionZkProofBackend
{
    public const string BackendName = "local_dev_fixture";
    private const string EnabledKey = "AnonymousIdentity:ZkVerifier:LocalDevFixture:Enabled";
    private readonly bool _enabled = IsEnabled(configuration);

    public static bool IsEnabled(IConfiguration configuration)
        => configuration.GetValue(EnabledKey, false) &&
            string.Equals(
                configuration["ASPNETCORE_ENVIRONMENT"] ??
                Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT"),
                "Development",
                StringComparison.OrdinalIgnoreCase);

    public bool IsAvailable(string backendName)
        => _enabled && string.Equals(backendName, BackendName, StringComparison.Ordinal);

    public Task<ProductionZkProofBackendResult> VerifyAsync(
        ProductionZkProofBackendRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_enabled
            ? ProductionZkProofBackendResult.Accepted()
            : ProductionZkProofBackendResult.Rejected("backend_unavailable"));
    }
}

public sealed class ProductionZkProofVerifier : IZkProofVerifier, IDisposable
{
    private const string SectionName = "AnonymousIdentity:ZkVerifier";
    private const string CommentActionContext = "comment.create";
    private const int DefaultMaxProofBytes = 16 * 1024;
    private static readonly TimeSpan s_backendCancellationObservationWindow = TimeSpan.FromMilliseconds(100);

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

        if (!IsRootAccepted(request))
        {
            return ZkProofVerificationResult.InvalidProof();
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_options.BackendTimeout);
        bool entered = false;
        Task<ProductionZkProofBackendResult>? backendTask = null;
        try
        {
            await _concurrencyGate.WaitAsync(timeout.Token);
            entered = true;
            backendTask = _backend.VerifyAsync(
                    new ProductionZkProofBackendRequest(
                        request.ActionContext.Trim(),
                        request.Scope.Trim(),
                        request.CircuitId.Trim(),
                        request.VerifyingKeyHash.Trim(),
                        request.PublicInputLayoutVersion,
                        request.NullifierHash.Trim(),
                        request.CredentialRoot.Trim(),
                        NormalizeToken(request.PolicyHash, 64),
                        request.IsEligible,
                        request.MayComment,
                        NormalizeToken(request.RateClass, AnonymousPrivacyContract.MaxRateClassBytes),
                        request.RequiresModeration,
                        request.Proof,
                        NormalizeToken(request.RevocationRoot, 128),
                        NormalizeToken(request.IssuerPublicKeyHash, 128)),
                    timeout.Token);
            ProductionZkProofBackendResult backendResult = await backendTask;

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
            if (backendTask is not null)
            {
                await ObserveBackendCancellationAsync(backendTask);
            }

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

    private static async Task ObserveBackendCancellationAsync(Task backendTask)
    {
        Task completed = await Task.WhenAny(backendTask, Task.Delay(s_backendCancellationObservationWindow));
        if (ReferenceEquals(completed, backendTask) && backendTask.IsFaulted)
        {
            _ = backendTask.Exception;
        }
    }

    private bool PassesCheapChecks(ZkProofVerificationRequest request)
    {
        if (!string.Equals(request.ActionContext, CommentActionContext, StringComparison.Ordinal) ||
            !string.Equals(request.CircuitId, _options.CircuitId, StringComparison.Ordinal) ||
            !string.Equals(request.VerifyingKeyHash, _options.VerifyingKeyHash, StringComparison.Ordinal) ||
            request.PublicInputLayoutVersion != _options.PublicInputLayoutVersion ||
            request.Proof.Length == 0 ||
            request.Proof.Length > _options.MaxProofBytes)
        {
            return false;
        }

        return IsScope(request.Scope) &&
            IsHexHash(request.NullifierHash, minLength: 64, maxLength: 64) &&
            IsHexHash(request.CredentialRoot, minLength: 64, maxLength: 64) &&
            IsHexHash(request.RevocationRoot, minLength: 64, maxLength: 64) &&
            IsHexHash(request.IssuerPublicKeyHash, minLength: 64, maxLength: 64) &&
            IsHexHash(request.PolicyHash, minLength: 64, maxLength: 64) &&
            request.IsEligible &&
            request.MayComment &&
            IsToken(request.RateClass, maxLength: AnonymousPrivacyContract.MaxRateClassBytes);
    }

    private bool IsRootAccepted(ZkProofVerificationRequest request)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return _rootReader.CurrentSnapshot.AcceptedRoots.Any(root =>
            root.GraceExpiresAtUtc > now &&
            string.Equals(root.RootHash, request.CredentialRoot, StringComparison.Ordinal) &&
            string.Equals(root.RevocationRootHash, request.RevocationRoot, StringComparison.Ordinal) &&
            string.Equals(root.IssuerPublicKeyHash, request.IssuerPublicKeyHash, StringComparison.Ordinal) &&
            (string.Equals(root.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
             string.Equals(root.Status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal)));
    }

    private static ProductionZkProofVerifierOptions ResolveOptions(IConfiguration configuration)
    {
        ZkVerifierOptions options = ZkVerifierOptions.FromConfiguration(configuration);
        return new ProductionZkProofVerifierOptions(
            options.Enabled,
            NormalizeToken(options.CircuitId, 128),
            NormalizeToken(options.VerifyingKeyHash, 128),
            options.PublicInputLayoutVersion <= 0 ? (ushort)0 : (ushort)Math.Min(options.PublicInputLayoutVersion, ushort.MaxValue),
            options.MaxProofBytes > 0 ? options.MaxProofBytes : DefaultMaxProofBytes,
            NormalizeToken(options.Backend, 64),
            TimeSpan.FromMilliseconds(Math.Clamp(options.BackendTimeoutMs, 1, 30_000)),
            Math.Clamp(options.MaxConcurrentVerifications, 1, 64));
    }

    private static bool IsScope(string value)
        => IsToken(value, maxLength: 128);

    private static bool IsHexHash(string value, int minLength, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        if (normalized.Length < minLength || normalized.Length > maxLength)
        {
            return false;
        }

        return HexText.IsHex(normalized.AsSpan());
    }

    private static bool IsToken(string value, int maxLength)
    {
        string normalized = NormalizeToken(value, maxLength);
        if (normalized.Length == 0)
        {
            return false;
        }

        return TextHelpers.HasOnlyAsciiTokenChars(normalized, "._-:/");
    }

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
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
