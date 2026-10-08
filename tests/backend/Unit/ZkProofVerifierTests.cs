using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ZkProofVerifierTests
{
    private const string CircuitId = "fsus.anonymous.comment.v5";
    private static readonly string s_verifyingKeyHash = new('d', 64);
    private const ushort PublicInputLayoutVersion = 6;
    private const long CredentialEpoch = 7;
    private static readonly string s_credentialRoot = new('e', 64);
    private static readonly string s_revocationRoot = new('8', 64);
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private const string PublicInputNullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";
    private static readonly string s_policyHash = new('9', 64);

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
                ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "true",
                ["AnonymousIdentity:ZkVerifier:Backend"] = ZkVerifierOptions.NativeGroth16Backend,
                ["AnonymousIdentity:ZkCommentPolicy:RequireCredential"] = "true",
                ["AnonymousIdentity:ZkCommentPolicy:RequireTrustedSetupVerified"] = "true",
            }),
            new DisabledZkProofVerifier());

        ZkCommentPolicySnapshot policy = service.CurrentZkCommentPolicy;

        Assert.True(policy.Enabled);
        Assert.False(policy.NativeVerifierConfigured);
        Assert.False(policy.TrustedSetupVerified);
        Assert.True(policy.CredentialRequired);
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

        ZkProofVerificationResult missing = await service.VerifyCommentProofAsync(ValidRequest() with
        {
            Proof = []
        });
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

        ZkProofVerificationResult missingNullifier = await service.VerifyCommentProofAsync(ValidRequest() with
        {
            NullifierHash = string.Empty
        });
        ZkProofVerificationResult missingRoot = await service.VerifyCommentProofAsync(ValidRequest() with
        {
            CredentialRoot = string.Empty
        });

        Assert.False(missingNullifier.Verified);
        Assert.False(missingRoot.Verified);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missingNullifier.Status);
        Assert.Equal(ZkProofVerificationStatuses.MissingProof, missingRoot.Status);
        Assert.Equal(0, verifier.CallCount);
    }

    [Fact]
    public async Task CommentActorResolver_ZkAnonymousRequiresSingleUseTicketInsteadOfDirectProof()
    {
        IUserAccountReader accountReader = Substitute.For<IUserAccountReader>();
        var proofService = new CapturingZkProofService(ZkProofVerificationResult.Success());
        IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
            ["Moderation:Pepper"] = ModerationPepper
        });
        var resolver = new CommentActorResolver(
            accountReader,
            new AnonymousCommentPolicyService(configuration));

        CommentActorResolveResult result = await resolver.ResolveAsync(ValidActorResolveRequest() with
        {
            UserId = 42,
            ProofToken = "proof-token-must-not-be-used"
        });

        Assert.False(result.Allowed);
        Assert.Null(result.Actor);
        Assert.Equal("anonymous_ticket_required", result.Status);
        Assert.Equal(0, proofService.CallCount);
        Assert.Empty(accountReader.ReceivedCalls());
    }

    [Theory]
    [InlineData("nullifier")]
    [InlineData("credentialRoot")]
    [InlineData("revocationRoot")]
    [InlineData("issuerPublicKeyHash")]
    public async Task CommentActorResolver_ZkAnonymousDirectProofInputIsRejectedBeforeVerifier(string missingField)
    {
        var proofService = new CapturingZkProofService(ZkProofVerificationResult.Success());
        IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
            ["Moderation:Pepper"] = ModerationPepper
        });
        var resolver = new CommentActorResolver(
            Substitute.For<IUserAccountReader>(),
            new AnonymousCommentPolicyService(configuration));
        CommentActorResolveRequest request = missingField switch
        {
            "nullifier" => ValidActorResolveRequest() with { NullifierHash = string.Empty },
            "credentialRoot" => ValidActorResolveRequest() with { CredentialRoot = string.Empty },
            "revocationRoot" => ValidActorResolveRequest() with { RevocationRoot = string.Empty },
            "issuerPublicKeyHash" => ValidActorResolveRequest() with { IssuerPublicKeyHash = string.Empty },
            _ => ValidActorResolveRequest()
        };

        CommentActorResolveResult result = await resolver.ResolveAsync(request);

        Assert.False(result.Allowed);
        Assert.Equal("anonymous_ticket_required", result.Status);
        Assert.Equal(0, proofService.CallCount);
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
        services.AddSingleton<IAnonymousCredentialRootReader>(new FixedRootReader(s_credentialRoot, CredentialEpoch));

        services.AddFsusRuntimeSecurityAndLifecycleServices(configuration);

        ServiceDescriptor descriptor = Assert.Single(services, static item => item.ServiceType == typeof(IZkProofVerifier));
        Assert.Equal(typeof(ProductionZkProofVerifier), descriptor.ImplementationType);

        var verifier = new ProductionZkProofVerifier(
            configuration,
            new FixedRootReader(s_credentialRoot, CredentialEpoch),
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
        Assert.Equal(s_verifyingKeyHash, backend.LastRequest.VerifyingKeyHash);
        Assert.Equal(PublicInputLayoutVersion, backend.LastRequest.PublicInputLayoutVersion);
        Assert.Equal(s_revocationRoot, backend.LastRequest.RevocationRoot);
        Assert.Equal(s_issuerPublicKeyHash, backend.LastRequest.IssuerPublicKeyHash);
    }

    [Theory]
    [InlineData("other.circuit", "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", PublicInputLayoutVersion)]
    [InlineData(CircuitId, "other-vk", PublicInputLayoutVersion)]
    [InlineData(CircuitId, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", (ushort)9)]
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
            roots: new FixedRootReader(new string('7', 64), CredentialEpoch),
            backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest());

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal(0, backend.CallCount);
    }

    [Theory]
    [InlineData("7777777777777777777777777777777777777777777777777777777777777777", null)]
    [InlineData(null, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")]
    public async Task ProductionZkProofVerifier_RejectsRevocationRootOrIssuerMismatch(
        string? revocationRoot,
        string? issuerPublicKeyHash)
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(backend: backend);

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest() with
        {
            RevocationRoot = revocationRoot ?? s_revocationRoot,
            IssuerPublicKeyHash = issuerPublicKeyHash ?? s_issuerPublicKeyHash
        });

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
            NullifierHash = "not-a-hex-nullifier"
        });

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Equal(0, backend.CallCount);
    }

    [Theory]
    [InlineData("nullifier")]
    [InlineData("credentialRoot")]
    [InlineData("revocationRoot")]
    [InlineData("issuerPublicKeyHash")]
    public async Task ProductionZkProofVerifier_RejectsOversizedHexPublicInputsBeforeBackendCall(string field)
    {
        var backend = new RecordingProductionZkProofBackend();
        var verifier = CreateProductionVerifier(backend: backend);
        string oversizedHex = new('a', 128);
        ZkProofVerificationRequest request = field switch
        {
            "nullifier" => ValidRequest() with { NullifierHash = oversizedHex },
            "credentialRoot" => ValidRequest() with { CredentialRoot = oversizedHex },
            "revocationRoot" => ValidRequest() with { RevocationRoot = oversizedHex },
            "issuerPublicKeyHash" => ValidRequest() with { IssuerPublicKeyHash = oversizedHex },
            _ => ValidRequest()
        };

        ZkProofVerificationResult result = await verifier.VerifyAsync(request);

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

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidRequest() with
        {
            Proof = [1, 2, 3, 4, 5]
        });

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
                // Leave enough scheduling headroom for the backend to start even
                // while the production union is saturating the host. The assertion
                // below verifies cancellation of an entered backend, not the
                // separate concurrency-gate timeout path.
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "1000"
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
            Proof = "proof-raw-value"u8.ToArray()
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

        _ = await verifier.VerifyAsync(ValidRequest() with
        {
            NullifierHash = PublicInputNullifierHash
        });

        string logs = string.Join('\n', logger.Messages);
        Assert.NotEmpty(logger.Messages);
        Assert.DoesNotContain(PublicInputNullifierHash, logs, StringComparison.OrdinalIgnoreCase);
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
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = s_verifyingKeyHash,
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
            roots ?? new FixedRootReader(s_credentialRoot, CredentialEpoch),
            backend ?? new RecordingProductionZkProofBackend(),
            logger ?? new CapturingLogger<ProductionZkProofVerifier>());
    }

    private static ZkProofVerificationRequest ValidRequest()
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: s_verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            NullifierHash: PublicInputNullifierHash,
            CredentialRoot: s_credentialRoot,
            PolicyHash: s_policyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: [1, 2, 3],
            RevocationRoot: s_revocationRoot,
            IssuerPublicKeyHash: s_issuerPublicKeyHash);

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
            CredentialRoot: s_credentialRoot,
            CircuitId: CircuitId,
            VerifyingKeyHash: s_verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            RevocationRoot: s_revocationRoot,
            IssuerPublicKeyHash: s_issuerPublicKeyHash);

    private sealed class RecordingZkVerifier(bool configured, ZkProofVerificationResult result) : IZkProofVerifier
    {
        public int CallCount
        {
            get; private set;
        }

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
        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot
        {
            get;
        } = new(
            [new AnonymousCredentialAcceptedRoot(acceptedEpoch, acceptedRoot, s_revocationRoot, s_issuerPublicKeyHash, AnonymousCredentialRootStatuses.Active, DateTimeOffset.UtcNow.AddHours(1))],
            1,
            DateTimeOffset.UtcNow);

        public Task RefreshAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch)
            => epoch == acceptedEpoch && string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal);

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => epoch == acceptedEpoch &&
                string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal) &&
                string.Equals(revocationRootHash, s_revocationRoot, StringComparison.Ordinal) &&
                string.Equals(issuerPublicKeyHash, s_issuerPublicKeyHash, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class CapturingZkProofService(ZkProofVerificationResult result) : IZkAnonymousProofService
    {
        public int CallCount
        {
            get; private set;
        }

        public ZkProofVerificationRequest LastRequest { get; private set; } = null!;

        public AnonymousCommentPolicySnapshot CurrentCommentPolicy
        {
            get;
        } = AnonymousCommentPolicySnapshot.Default with
        {
            ZkAnonymousEnabled = true,
            SnapshotHash = s_policyHash
        };

        public ZkAnonymousPolicySnapshot CurrentZkPolicy
        {
            get;
        } = new(
            true,
            true,
            "comment.create",
            []);

        public ZkCommentPolicySnapshot CurrentZkCommentPolicy
        {
            get;
        } = new(
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

        public int CallCount
        {
            get; private set;
        }

        public ProductionZkProofBackendRequest LastRequest
        {
            get; private set;
        }

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
        public bool WasCanceled
        {
            get; private set;
        }

        public bool IsAvailable(string backendName)
            => string.Equals(backendName, "unit", StringComparison.Ordinal);

        public async Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            using CancellationTokenRegistration registration =
                cancellationToken.Register(static state => ((BlockingProductionZkProofBackend)state!).WasCanceled = true, this);
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
