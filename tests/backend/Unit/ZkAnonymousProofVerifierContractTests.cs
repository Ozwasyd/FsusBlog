using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ZkAnonymousProofVerifierContractTests
{
    private const string CircuitId = "fsus.anonymous.comment.v1";
    private const string VerifyingKeyHash = "vk-sha256";
    private const ushort PublicInputLayoutVersion = 2;
    private const long CredentialEpoch = 7;
    private const string CredentialRoot = "credential-root-active";

    [Fact]
    public void CommentAuthorModes_RetainZkAnonymousAsFirstClassMode()
    {
        Assert.Equal("anonymous", CommentAuthorModes.Anonymous);
        Assert.Equal("pseudonymous", CommentAuthorModes.Pseudonymous);
        Assert.Equal("public", CommentAuthorModes.Public);
        Assert.Equal("zk_anonymous", CommentAuthorModes.ZkAnonymous);
    }

    [Fact]
    public void CommentPolicy_DefaultsAnonymousAndZkDisabled()
    {
        AnonymousCommentPolicySnapshot policy = AnonymousCommentPolicySnapshot.Default;

        Assert.True(policy.AnonymousCommentsEnabled);
        Assert.True(policy.PublicCommentsEnabled);
        Assert.False(policy.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.Anonymous, policy.DefaultAuthorMode);
        Assert.Contains("zh-CN", policy.SupportedDisplayLanguages);
        Assert.Contains("en", policy.SupportedDisplayLanguages);
    }

    [Fact]
    public async Task ZkAnonymousProofService_DisabledByDefaultFailsClosed()
    {
        var verifier = new RecordingZkVerifier(configured: true, ZkProofVerificationResult.Success());
        var service = new ZkAnonymousProofService(BuildConfiguration([]), verifier);

        ZkProofVerificationResult result = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.Disabled, result.Status);
        Assert.Equal(0, verifier.CallCount);
        Assert.False(service.CurrentZkPolicy.Enabled);
        Assert.True(service.CurrentZkPolicy.VerifierConfigured);
    }

    [Fact]
    public async Task ZkAnonymousProofService_EnabledWithoutVerifierFailsClosed()
    {
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            }),
            new DisabledZkProofVerifier());

        ZkProofVerificationResult result = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.VerifierUnavailable, result.Status);
        Assert.True(service.CurrentZkPolicy.Enabled);
        Assert.False(service.CurrentZkPolicy.VerifierConfigured);
    }

    [Fact]
    public async Task ZkAnonymousProofService_RejectsMissingAndInvalidProof()
    {
        var verifier = new RecordingZkVerifier(configured: true, ZkProofVerificationResult.InvalidProof("bad proof"));
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            }),
            verifier);

        ZkProofVerificationResult missing = await service.VerifyCommentProofAsync(ValidRequest() with { Proof = [] });
        ZkProofVerificationResult invalid = await service.VerifyCommentProofAsync(ValidRequest());

        Assert.False(missing.Verified);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missing.Status);
        Assert.False(invalid.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, invalid.Status);
        Assert.Equal(1, verifier.CallCount);
    }

    [Fact]
    public void RuntimeServices_UseDisabledZkVerifierWhenProductionVerifierConfigIsOff()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration([]));

        ServiceDescriptor descriptor = Assert.Single(services, static item => item.ServiceType == typeof(IZkProofVerifier));
        Assert.Equal(typeof(DisabledZkProofVerifier), descriptor.ImplementationType);
    }

    [Fact]
    public void RuntimeServices_RegisterProductionVerifierWhenEnabledButIncompleteConfigurationIsNotConfigured()
    {
        IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = "unit"
        });
        var services = new ServiceCollection();
        services.AddSingleton<IProductionZkProofBackend, AcceptingProductionZkProofBackend>();
        services.AddSingleton<IAnonymousCredentialRootReader>(new FixedRootReader(CredentialRoot, CredentialEpoch));

        services.AddFsusRuntimeSecurityAndLifecycleServices(configuration);

        ServiceDescriptor descriptor = Assert.Single(services, static item => item.ServiceType == typeof(IZkProofVerifier));
        Assert.Equal(typeof(ProductionZkProofVerifier), descriptor.ImplementationType);

        var verifier = new ProductionZkProofVerifier(
            configuration,
            new FixedRootReader(CredentialRoot, CredentialEpoch),
            new AcceptingProductionZkProofBackend(),
            new CapturingLogger<ProductionZkProofVerifier>());
        Assert.False(verifier.IsConfigured);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_AcceptsValidConfiguredProofAndCallsBackend()
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest());

        Assert.True(verifier.IsConfigured);
        Assert.True(result.Verified);
        Assert.Equal(1, backend.CallCount);
        Assert.Equal(CircuitId, backend.LastRequest.CircuitId);
        Assert.Equal(VerifyingKeyHash, backend.LastRequest.VerifyingKeyHash);
        Assert.Equal(PublicInputLayoutVersion, backend.LastRequest.PublicInputLayoutVersion);
    }

    [Theory]
    [InlineData("other.circuit", VerifyingKeyHash, PublicInputLayoutVersion)]
    [InlineData(CircuitId, "other-vk", PublicInputLayoutVersion)]
    [InlineData(CircuitId, VerifyingKeyHash, (ushort)9)]
    public async Task ProductionZkProofVerifier_RejectsPublicInputMetadataMismatch(
        string circuitId,
        string verifyingKeyHash,
        ushort publicInputLayoutVersion)
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest() with
        {
            CircuitId = circuitId,
            VerifyingKeyHash = verifyingKeyHash,
            PublicInputLayoutVersion = publicInputLayoutVersion
        });

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal("ZK proof is invalid", result.Message);
        Assert.Equal(0, backend.CallCount);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_RejectsRootOutsideActiveOrGraceSnapshot()
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(
            roots: new FixedRootReader("different-root", CredentialEpoch),
            backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal(0, backend.CallCount);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_RejectsMalformedPublicInputShapeBeforeBackendCall()
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest() with
        {
            NullifierHash = "not-a-hex-nullifier",
            CredentialCommitment = new string('z', 64)
        });

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal(0, backend.CallCount);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_RejectsOversizedProofBeforeBackendCall()
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(
            backend: backend,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4"
            });

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest() with { Proof = [1, 2, 3, 4, 5] });

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal(0, backend.CallCount);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_BackendTimeoutFailsClosed()
    {
        var backend = new BlockingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(
            backend: backend,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "5"
            });

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.True(backend.WasCanceled);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_DoesNotLogProofWitnessOrCredentialSecret()
    {
        var logger = new CapturingLogger<ProductionZkProofVerifier>();
        var verifier = CreateProductionVerifier(
            backend: new RecordingProductionZkProofBackend(ProductionZkProofBackendResult.Rejected("proof-witness-secret credential-secret")),
            logger: logger);

        _ = await verifier.VerifyAsync(ValidRequest() with
        {
            Proof = "proof-raw-value"u8.ToArray(),
            CredentialCommitment = new string('c', 64)
        });

        string logs = string.Join('\n', logger.Messages);
        Assert.NotEmpty(logger.Messages);
        Assert.DoesNotContain("proof-raw-value", logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("proof-witness-secret", logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("credential-secret", logs, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void NormalLoginAndAdminLogin_DoNotDependOnZkVerifier()
    {
        string userService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string passkeyService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/PasskeyService.cs");
        string adminPrincipalService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");

        Assert.DoesNotContain("IZkProofVerifier", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", userService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkProofVerifier", passkeyService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", passkeyService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkProofVerifier", adminPrincipalService, StringComparison.Ordinal);
        Assert.DoesNotContain("IZkAnonymousProofService", adminPrincipalService, StringComparison.Ordinal);
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static ProductionZkProofVerifier CreateProductionVerifier(
        IAnonymousCredentialRootReader? roots = null,
        IProductionZkProofBackend? backend = null,
        ILogger<ProductionZkProofVerifier>? logger = null,
        Dictionary<string, string?>? overrides = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:CircuitId"] = CircuitId,
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = VerifyingKeyHash,
            ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = PublicInputLayoutVersion.ToString(),
            ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4096",
            ["AnonymousIdentity:ZkVerifier:Backend"] = "unit",
            ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "1000",
            ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = "2"
        };
        if (overrides is not null)
        {
            foreach (KeyValuePair<string, string?> pair in overrides)
            {
                values[pair.Key] = pair.Value;
            }
        }

        return new ProductionZkProofVerifier(
            BuildConfiguration(values),
            roots ?? new FixedRootReader(CredentialRoot, CredentialEpoch),
            backend ?? new RecordingProductionZkProofBackend(),
            logger ?? new CapturingLogger<ProductionZkProofVerifier>());
    }

    private static ZkProofVerificationRequest ValidRequest()
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: VerifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            CredentialEpoch: CredentialEpoch,
            NullifierHash: new string('a', 64),
            CredentialCommitment: new string('b', 64),
            CredentialRoot: CredentialRoot,
            ReputationBucket: "trusted",
            Proof: [1, 2, 3]);

    private sealed class RecordingZkVerifier(bool configured, ZkProofVerificationResult result) : IZkProofVerifier
    {
        public int CallCount { get; private set; }

        public bool IsConfigured { get; } = configured;

        public Task<ZkProofVerificationResult> VerifyAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(result);
        }
    }

    private sealed class FixedRootReader(string acceptedRoot, long acceptedEpoch) : IAnonymousCredentialRootReader
    {
        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot { get; } = new(
            [new AnonymousCredentialAcceptedRoot(acceptedEpoch, acceptedRoot, AnonymousCredentialRootStatuses.Active, DateTimeOffset.UtcNow.AddHours(1))],
            1,
            DateTimeOffset.UtcNow);

        public Task RefreshAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch)
            => epoch == acceptedEpoch && string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal);
    }

    private sealed class AcceptingProductionZkProofBackend : IProductionZkProofBackend
    {
        public bool IsAvailable(string backendName)
            => string.Equals(backendName, "unit", StringComparison.Ordinal);

        public Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(ProductionZkProofBackendResult.Accepted());
    }

    private sealed class RecordingProductionZkProofBackend(
        ProductionZkProofBackendResult? result = null) : IProductionZkProofBackend
    {
        private readonly ProductionZkProofBackendResult _result = result ?? ProductionZkProofBackendResult.Accepted();

        public int CallCount { get; private set; }

        public ProductionZkProofBackendRequest LastRequest { get; private set; }

        public bool IsAvailable(string backendName)
            => string.Equals(backendName, "unit", StringComparison.Ordinal);

        public Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            LastRequest = request;
            return Task.FromResult(_result);
        }
    }

    private sealed class BlockingProductionZkProofBackend : IProductionZkProofBackend
    {
        public bool WasCanceled { get; private set; }

        public bool IsAvailable(string backendName)
            => string.Equals(backendName, "unit", StringComparison.Ordinal);

        public async Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken);
                return ProductionZkProofBackendResult.Accepted();
            }
            catch (OperationCanceledException)
            {
                WasCanceled = true;
                throw;
            }
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Messages.Add(formatter(state, exception));
            if (exception is not null)
            {
                Messages.Add(exception.Message);
            }
        }
    }
}
