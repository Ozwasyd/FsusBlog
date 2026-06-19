using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ZkAnonymousProofVerifierContractTests
{
    private const string CircuitId = "fsus.anonymous.comment.v1";
    private const string VerifyingKeyHash = "vk-sha256";
    private const ushort PublicInputLayoutVersion = 2;
    private const long CredentialEpoch = 7;
    private const string CredentialRoot = "credential-root-active";
    private const string PublicInputNullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string CredentialCommitment = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
    public void ZkAnonymousProofService_ExposesCoarseZkProdPolicyReadiness()
    {
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkProd:Enabled"] = "true",
                ["AnonymousIdentity:ZkProd:RequireNativeVerifier"] = "true",
                ["AnonymousIdentity:ZkProd:RequireBbsCredential"] = "true",
                ["AnonymousIdentity:ZkProd:RequireTrustedSetupVerified"] = "true",
                ["AnonymousIdentity:ZkProd:VerifierBackend"] = "native_groth16",
                ["AnonymousIdentity:ZkProd:TrustedSetupVerified"] = "true",
                ["AnonymousIdentity:ZkProd:BbsCredentialReady"] = "true",
                ["AnonymousIdentity:ZkProd:VerifyingKeyHash"] = VerifyingKeyHash
            }),
            new DisabledZkProofVerifier());

        ZkProdPolicySnapshot policy = service.CurrentZkProdPolicy;

        Assert.True(policy.Enabled);
        Assert.False(policy.NativeVerifierConfigured);
        Assert.True(policy.TrustedSetupVerified);
        Assert.True(policy.BbsCredentialRequired);
        Assert.False(policy.CredentialRootReady);
        Assert.Equal("native_verifier_unavailable", policy.UnavailableReason);
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
    public async Task ZkAnonymousProofService_RejectsMissingPublicInputFieldsBeforeVerifier()
    {
        var verifier = new RecordingZkVerifier(configured: true, ZkProofVerificationResult.Success());
        var service = new ZkAnonymousProofService(
            BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            }),
            verifier);

        ZkProofVerificationResult missingNullifier = await service.VerifyCommentProofAsync(ValidRequest() with { NullifierHash = string.Empty });
        ZkProofVerificationResult missingRoot = await service.VerifyCommentProofAsync(ValidRequest() with { CredentialRoot = string.Empty });

        Assert.False(missingNullifier.Verified);
        Assert.False(missingRoot.Verified);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missingNullifier.Status);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missingRoot.Status);
        Assert.Equal(0, verifier.CallCount);
    }

    [Fact]
    public async Task CommentActorResolver_ZkAnonymousUsesPublicInputNullifierWithoutUserOrProofTokenDerivation()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var proofService = new CapturingZkProofService(ZkProofVerificationResult.Success());
        var resolver = new CommentActorResolver(
            db,
            new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            })),
            new CommentAnonymousDisplayNameGenerator(),
            new ThrowingCredentialService(),
            proofService);

        CommentActorResolveResult result = await resolver.ResolveAsync(ValidActorResolveRequest() with
        {
            UserId = 42,
            ProofToken = "proof-token-must-not-be-used"
        });

        Assert.True(result.Allowed, result.Message);
        Assert.NotNull(result.Actor);
        Assert.Null(result.Actor.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, result.Actor.AuthorMode);
        Assert.Equal(PublicInputNullifierHash, result.Actor.AnonymousNullifierHash);
        Assert.Equal("article:42", result.Actor.AnonymousScope);
        Assert.Equal(AnonymousCredentialLevels.StrongAnonymous, result.Actor.CredentialLevel);
        Assert.Equal(PublicInputNullifierHash, proofService.LastRequest.NullifierHash);
        Assert.Equal(CredentialCommitment, proofService.LastRequest.CredentialCommitment);
        Assert.Equal(CredentialRoot, proofService.LastRequest.CredentialRoot);
        Assert.Equal(CredentialEpoch, proofService.LastRequest.CredentialEpoch);
        Assert.Equal(CircuitId, proofService.LastRequest.CircuitId);
        Assert.Equal(VerifyingKeyHash, proofService.LastRequest.VerifyingKeyHash);
        Assert.Equal(PublicInputLayoutVersion, proofService.LastRequest.PublicInputLayoutVersion);
        Assert.Empty(db.ReceivedCalls());
    }

    [Theory]
    [InlineData("nullifier")]
    [InlineData("credentialRoot")]
    public async Task CommentActorResolver_ZkAnonymousMissingPublicInputIsRejectedBeforeVerifier(string missingField)
    {
        var proofService = new CapturingZkProofService(ZkProofVerificationResult.Success());
        var resolver = new CommentActorResolver(
            Substitute.For<ISqlSugarClient>(),
            new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            })),
            new CommentAnonymousDisplayNameGenerator(),
            new ThrowingCredentialService(),
            proofService);
        CommentActorResolveRequest request = missingField switch
        {
            "nullifier" => ValidActorResolveRequest() with { NullifierHash = string.Empty },
            "credentialRoot" => ValidActorResolveRequest() with { CredentialRoot = string.Empty },
            _ => ValidActorResolveRequest()
        };

        CommentActorResolveResult result = await resolver.ResolveAsync(request);

        Assert.False(result.Allowed);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, result.Status);
        Assert.Equal(0, proofService.CallCount);
    }

    [Fact]
    public void CommentActorResolver_ZkAnonymousSourceDoesNotDeriveNullifierFromUserOrProofToken()
    {
        string resolver = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentActorResolver.cs");
        string zkBlock = ExtractBetween(
            resolver,
            "if (string.Equals(decision.EffectiveAuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal))",
            "string credentialLevel =");

        Assert.DoesNotContain("account:{request.UserId", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("proof:{request.ProofToken", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("CredentialCommitment: string.Empty", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("CredentialRoot: string.Empty", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Join", zkBlock, StringComparison.Ordinal);
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
    public async Task ProductionZkProofVerifier_DoesNotLogRawNullifierHash()
    {
        var logger = new CapturingLogger<ProductionZkProofVerifier>();
        var verifier = CreateProductionVerifier(
            backend: new RecordingProductionZkProofBackend(ProductionZkProofBackendResult.Rejected(PublicInputNullifierHash)),
            logger: logger);

        _ = await verifier.VerifyAsync(ValidRequest() with { NullifierHash = PublicInputNullifierHash });

        string logs = string.Join('\n', logger.Messages);
        Assert.NotEmpty(logger.Messages);
        Assert.DoesNotContain(PublicInputNullifierHash, logs, StringComparison.OrdinalIgnoreCase);
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
            NullifierHash: PublicInputNullifierHash,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            ReputationBucket: "trusted",
            Proof: [1, 2, 3]);

    private static CommentActorResolveRequest ValidActorResolveRequest()
        => new(
            UserId: null,
            ArticleId: 42,
            AuthorMode: CommentAuthorModes.ZkAnonymous,
            PublicSendExplicitlySelected: false,
            AnonymousScope: "article:42",
            DisplayLanguage: "en",
            ProofToken: null,
            ZkProof: [1, 2, 3],
            SubmitRegion: "SG",
            NullifierHash: PublicInputNullifierHash,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            CredentialEpoch: CredentialEpoch,
            CircuitId: CircuitId,
            VerifyingKeyHash: VerifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            ReputationBucket: "trusted");

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

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

    private sealed class CapturingZkProofService(ZkProofVerificationResult result) : IZkAnonymousProofService
    {
        public int CallCount { get; private set; }

        public ZkProofVerificationRequest LastRequest { get; private set; } = null!;

        public AnonymousCommentPolicySnapshot CurrentCommentPolicy { get; } = AnonymousCommentPolicySnapshot.Default with
        {
            ZkAnonymousEnabled = true
        };

        public ZkAnonymousPolicySnapshot CurrentZkPolicy { get; } = new(
            true,
            true,
            "comment.create",
            []);

        public ZkProdPolicySnapshot CurrentZkProdPolicy { get; } = new(
            false,
            false,
            false,
            false,
            false,
            "disabled");

        public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            LastRequest = request;
            return Task.FromResult(result);
        }
    }

    private sealed class ThrowingCredentialService : IAnonymousCredentialService
    {
        public Task<AnonymousCredential> IssueAsync(
            int? userId,
            string commitmentHash,
            string credentialType = AnonymousCredentialTypes.AccountBound,
            string credentialLevel = AnonymousCredentialLevels.Basic,
            string metadataJson = "{}",
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ZK actor resolve must not issue credentials");

        public Task<AnonymousCredential?> GetActiveCredentialAsync(
            int? userId,
            string? commitmentHash = null,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ZK actor resolve must not query credentials");

        public Task<string?> GetCredentialLevelAsync(
            int? userId,
            string? commitmentHash = null,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ZK actor resolve must not query credential level");

        public Task<bool> RevokeAsync(long credentialId, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("ZK actor resolve must not revoke credentials");
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
