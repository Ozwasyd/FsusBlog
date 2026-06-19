using System.Security.Cryptography;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NativeGroth16ZkProofBackendTests
{
    private const string CircuitId = "fsus.anonymous.comment.v1";
    private const string CredentialRoot = "credential-root-active";
    private const string RevocationRoot = "revocation-root-active";
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private const long CredentialEpoch = 7;
    private const ushort PublicInputLayoutVersion = 2;
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string CredentialCommitment = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public async Task NativeGroth16ZkProofBackend_MissingNativeLibraryIsUnavailableAndRejects()
    {
        using var temp = TempNativeZkFixture.Create();
        IConfiguration configuration = BuildNativeConfiguration(temp, missingLibrary: true);
        var backend = new NativeGroth16ZkProofBackend(
            configuration,
            new CapturingLogger<NativeGroth16ZkProofBackend>());

        ProductionZkProofBackendResult result = await backend.VerifyAsync(ValidBackendRequest([1, 2, 3], temp.VerifyingKeySha256));

        Assert.False(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.False(result.Verified);
        Assert.Equal("backend_unavailable", result.Reason);
    }

    [Fact]
    public async Task NativeGroth16ZkProofBackend_VerifyingKeyHashMismatchIsUnavailable()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = CreateFixtureBackend(
            temp,
            new HashingNativeGroth16FixtureLibrary(),
            verifyingKeySha256: new string('0', 64));

        ProductionZkProofBackendResult result = await backend.VerifyAsync(ValidBackendRequest([1, 2, 3], new string('0', 64)));

        Assert.False(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.False(result.Verified);
        Assert.Equal("backend_unavailable", result.Reason);
    }

    [Fact]
    public async Task NativeGroth16ZkProofBackend_RoundTripFixtureAcceptsValidAndRejectsTamperedProof()
    {
        using var temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary();
        var backend = CreateFixtureBackend(temp, nativeLibrary);
        ProductionZkProofBackendRequest validRequest = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] validProof = ComputeFixtureProof(temp.VerifyingKeyBytes, validRequest);

        ProductionZkProofBackendResult accepted = await backend.VerifyAsync(validRequest with { Proof = validProof });
        byte[] tamperedProof = [.. validProof];
        tamperedProof[0] ^= 0xff;
        ProductionZkProofBackendResult rejected = await backend.VerifyAsync(validRequest with { Proof = tamperedProof });

        Assert.True(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.False(backend.IsAvailable("unit"));
        Assert.True(accepted.Verified);
        Assert.False(rejected.Verified);
        Assert.Equal(2, nativeLibrary.CallCount);
    }

    [Fact]
    public async Task NativeGroth16ZkProofBackend_NativeExceptionRejectsWithoutThrowingOrLoggingSensitiveInputs()
    {
        using var temp = TempNativeZkFixture.Create();
        var nativeLogger = new CapturingLogger<NativeGroth16ZkProofBackend>();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary
        {
            ThrowOnVerify = true
        };
        var backend = CreateFixtureBackend(temp, nativeLibrary, logger: nativeLogger);

        ProductionZkProofBackendResult result = await backend.VerifyAsync(
            ValidBackendRequest("proof-raw-value"u8.ToArray(), temp.VerifyingKeySha256));

        string logs = string.Join('\n', nativeLogger.Messages);
        Assert.False(result.Verified);
        Assert.Equal("native_error", result.Reason);
        Assert.DoesNotContain("proof-raw-value", logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(NullifierHash, logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("credential-secret", logs, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RuntimeServices_RegisterNativeGroth16BackendOnlyWhenZkProdNativeEnabled()
    {
        var nativeServices = new ServiceCollection();
        nativeServices.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:Enabled"] = "true",
            ["AnonymousIdentity:ZkProd:VerifierBackend"] = ZkProdOptions.NativeGroth16Backend,
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkProdOptions.NativeGroth16Backend
        }));

        ServiceDescriptor nativeBackend = Assert.Single(
            nativeServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(NativeGroth16ZkProofBackend), nativeBackend.ImplementationType);

        var unavailableServices = new ServiceCollection();
        unavailableServices.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkProd:Enabled"] = "false",
            ["AnonymousIdentity:ZkProd:VerifierBackend"] = ZkProdOptions.NativeGroth16Backend,
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkProdOptions.NativeGroth16Backend
        }));

        ServiceDescriptor unavailableBackend = Assert.Single(
            unavailableServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(UnavailableProductionZkProofBackend), unavailableBackend.ImplementationType);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_NativeBackendTimeoutFailsClosed()
    {
        using var temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary
        {
            AcceptAnyProof = true,
            Delay = TimeSpan.FromMilliseconds(100)
        };
        var backend = CreateFixtureBackend(temp, nativeLibrary);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "5"
            });

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidVerificationRequest([1, 2, 3], temp.VerifyingKeySha256));

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.True(nativeLibrary.CallCount >= 1);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_NativeBackendUsesExistingConcurrencyGate()
    {
        using var temp = TempNativeZkFixture.Create();
        var nativeLibrary = new HashingNativeGroth16FixtureLibrary
        {
            AcceptAnyProof = true,
            Delay = TimeSpan.FromMilliseconds(25)
        };
        var backend = CreateFixtureBackend(temp, nativeLibrary);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = "1",
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "1000"
            });

        Task<ZkProofVerificationResult>[] tasks = Enumerable
            .Range(0, 6)
            .Select(_ => verifier.VerifyAsync(ValidVerificationRequest([1, 2, 3], temp.VerifyingKeySha256)))
            .ToArray();
        ZkProofVerificationResult[] results = await Task.WhenAll(tasks);

        Assert.All(results, static result => Assert.True(result.Verified));
        Assert.Equal(1, nativeLibrary.MaxInFlight);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_NativeBackendDoesNotLogProofWitnessOrNullifier()
    {
        using var temp = TempNativeZkFixture.Create();
        var verifierLogger = new CapturingLogger<ProductionZkProofVerifier>();
        var nativeLogger = new CapturingLogger<NativeGroth16ZkProofBackend>();
        var backend = CreateFixtureBackend(
            temp,
            new HashingNativeGroth16FixtureLibrary { ThrowOnVerify = true },
            logger: nativeLogger);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            logger: verifierLogger);

        _ = await verifier.VerifyAsync(ValidVerificationRequest("proof-raw-value"u8.ToArray(), temp.VerifyingKeySha256));

        string logs = string.Join('\n', verifierLogger.Messages.Concat(nativeLogger.Messages));
        Assert.DoesNotContain("proof-raw-value", logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(NullifierHash, logs, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("credential-secret", logs, StringComparison.OrdinalIgnoreCase);
    }

    private static NativeGroth16ZkProofBackend CreateFixtureBackend(
        TempNativeZkFixture temp,
        INativeGroth16VerifierLibrary nativeLibrary,
        string? verifyingKeySha256 = null,
        ILogger<NativeGroth16ZkProofBackend>? logger = null)
        => new(
            new NativeGroth16ZkProofBackendOptions(
                temp.NativeLibraryPath,
                temp.VerifyingKeyPath,
                verifyingKeySha256 ?? temp.VerifyingKeySha256,
                "fsus_zk_groth16_verify"),
            nativeLibrary,
            logger ?? new CapturingLogger<NativeGroth16ZkProofBackend>());

    private static ProductionZkProofVerifier CreateProductionVerifier(
        TempNativeZkFixture temp,
        IProductionZkProofBackend backend,
        ILogger<ProductionZkProofVerifier>? logger = null,
        Dictionary<string, string?>? overrides = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:CircuitId"] = CircuitId,
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = temp.VerifyingKeySha256,
            ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = PublicInputLayoutVersion.ToString(),
            ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4096",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkProdOptions.NativeGroth16Backend,
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
            new FixedRootReader(CredentialRoot, CredentialEpoch),
            backend,
            logger ?? new CapturingLogger<ProductionZkProofVerifier>());
    }

    private static IConfiguration BuildNativeConfiguration(TempNativeZkFixture temp, bool missingLibrary)
        => BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:LibraryPath"] = missingLibrary
                ? Path.Combine(temp.DirectoryPath, "missing", "libfsus_zk_groth16.so")
                : temp.NativeLibraryPath,
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeyPath"] = temp.VerifyingKeyPath,
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeySha256"] = temp.VerifyingKeySha256
        });

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static ProductionZkProofBackendRequest ValidBackendRequest(byte[] proof, string verifyingKeyHash)
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            CredentialEpoch: CredentialEpoch,
            NullifierHash: NullifierHash,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            ReputationBucket: "trusted",
            Proof: proof,
            RevocationRoot: RevocationRoot,
            IssuerPublicKeyHash: IssuerPublicKeyHash);

    private static ZkProofVerificationRequest ValidVerificationRequest(byte[] proof, string verifyingKeyHash)
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            CredentialEpoch: CredentialEpoch,
            NullifierHash: NullifierHash,
            CredentialCommitment: CredentialCommitment,
            CredentialRoot: CredentialRoot,
            ReputationBucket: "trusted",
            Proof: proof,
            RevocationRoot: RevocationRoot,
            IssuerPublicKeyHash: IssuerPublicKeyHash);

    private static byte[] ComputeFixtureProof(
        ReadOnlySpan<byte> verifyingKey,
        ProductionZkProofBackendRequest request)
    {
        ReadOnlyMemory<byte> publicInputs = NativeGroth16PublicInputCodec.Encode(request);
        byte[] payload = new byte[verifyingKey.Length + publicInputs.Length];
        verifyingKey.CopyTo(payload);
        publicInputs.Span.CopyTo(payload.AsSpan(verifyingKey.Length));
        return SHA256.HashData(payload);
    }

    private sealed class HashingNativeGroth16FixtureLibrary : INativeGroth16VerifierLibrary
    {
        private int _inFlight;
        private int _maxInFlight;

        public bool IsLoaded { get; init; } = true;

        public bool AcceptAnyProof { get; init; }

        public bool ThrowOnVerify { get; init; }

        public TimeSpan Delay { get; init; }

        public int CallCount { get; private set; }

        public int MaxInFlight => Volatile.Read(ref _maxInFlight);

        public NativeGroth16VerifierCallResult Verify(
            ReadOnlySpan<byte> verifyingKey,
            ReadOnlySpan<byte> publicInputs,
            ReadOnlySpan<byte> proof)
        {
            CallCount++;
            int inFlight = Interlocked.Increment(ref _inFlight);
            TrackMax(inFlight);
            try
            {
                if (ThrowOnVerify)
                {
                    throw new InvalidOperationException(
                        $"native fixture failure proof-raw-value {NullifierHash} credential-secret");
                }

                if (Delay > TimeSpan.Zero)
                {
                    Thread.Sleep(Delay);
                }

                if (AcceptAnyProof)
                {
                    return NativeGroth16VerifierCallResult.Accepted();
                }

                byte[] payload = new byte[verifyingKey.Length + publicInputs.Length];
                verifyingKey.CopyTo(payload);
                publicInputs.CopyTo(payload.AsSpan(verifyingKey.Length));
                byte[] expectedProof = SHA256.HashData(payload);
                return proof.SequenceEqual(expectedProof)
                    ? NativeGroth16VerifierCallResult.Accepted()
                    : NativeGroth16VerifierCallResult.Rejected("invalid_proof");
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
            }
        }

        public void Dispose()
        {
        }

        private void TrackMax(int value)
        {
            while (true)
            {
                int current = Volatile.Read(ref _maxInFlight);
                if (value <= current ||
                    Interlocked.CompareExchange(ref _maxInFlight, value, current) == current)
                {
                    return;
                }
            }
        }
    }

    private sealed class FixedRootReader(string acceptedRoot, long acceptedEpoch) : IAnonymousCredentialRootReader
    {
        public AnonymousCredentialRootRuntimeSnapshot CurrentSnapshot { get; } = new(
            [new AnonymousCredentialAcceptedRoot(acceptedEpoch, acceptedRoot, RevocationRoot, IssuerPublicKeyHash, AnonymousCredentialRootStatuses.Active, DateTimeOffset.UtcNow.AddHours(1))],
            1,
            DateTimeOffset.UtcNow);

        public Task RefreshAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public bool IsRootAccepted(string rootHash, long epoch)
            => epoch == acceptedEpoch && string.Equals(rootHash, acceptedRoot, StringComparison.Ordinal);

        public bool IsRootAccepted(string rootHash, string revocationRootHash, string issuerPublicKeyHash, long epoch)
            => IsRootAccepted(rootHash, epoch) &&
                string.Equals(revocationRootHash, RevocationRoot, StringComparison.Ordinal) &&
                string.Equals(issuerPublicKeyHash, IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase);
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

    private sealed class TempNativeZkFixture : IDisposable
    {
        private TempNativeZkFixture(string directoryPath, byte[] verifyingKeyBytes)
        {
            DirectoryPath = directoryPath;
            VerifyingKeyBytes = verifyingKeyBytes;
            VerifyingKeyPath = Path.Combine(directoryPath, "comment.v1.vk");
            NativeLibraryPath = Path.Combine(directoryPath, "libfsus_zk_groth16.so");
            VerifyingKeySha256 = Convert.ToHexString(SHA256.HashData(verifyingKeyBytes)).ToLowerInvariant();
            Directory.CreateDirectory(directoryPath);
            File.WriteAllBytes(VerifyingKeyPath, verifyingKeyBytes);
        }

        public string DirectoryPath { get; }

        public string VerifyingKeyPath { get; }

        public string NativeLibraryPath { get; }

        public byte[] VerifyingKeyBytes { get; }

        public string VerifyingKeySha256 { get; }

        public static TempNativeZkFixture Create()
            => new(
                Path.Combine(Path.GetTempPath(), "fsus-zk-native-" + Guid.NewGuid().ToString("N")),
                "fixture-verifying-key"u8.ToArray());

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(DirectoryPath))
                {
                    Directory.Delete(DirectoryPath, recursive: true);
                }
            }
            catch
            {
                // Test cleanup best effort only.
            }
        }
    }
}
