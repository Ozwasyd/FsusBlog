using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Nethermind.MclBindings;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NativeGroth16ZkProofBackendTests
{
    private const string CircuitId = "fsus.anonymous.comment.v2";
    private const string CredentialRoot = "credential-root-active";
    private const string RevocationRoot = "revocation-root-active";
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private const long CredentialEpoch = 7;
    private const ushort PublicInputLayoutVersion = 3;
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string CredentialCommitment = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly string PolicyHash = new('9', 64);

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
    public async Task MclGroth16VerifierLibrary_VerifiesPairingFixtureAndBindsPublicInputs()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        ProductionZkProofBackendRequest validRequest = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] validProof = MclGroth16PairingFixture.CreateProof(
            verifyingKey,
            NativeGroth16PublicInputCodec.Encode(validRequest).Span);
        var backend = CreateFixtureBackend(temp, MclGroth16VerifierLibrary.Create());

        ProductionZkProofBackendResult accepted = await backend.VerifyAsync(validRequest with { Proof = validProof });
        byte[] tamperedProof = [.. validProof];
        tamperedProof[^1] ^= 0x01;
        ProductionZkProofBackendResult rejectedProof = await backend.VerifyAsync(validRequest with { Proof = tamperedProof });
        ProductionZkProofBackendResult rejectedPublicInputs = await backend.VerifyAsync(
            validRequest with
            {
                Scope = "article:43",
                Proof = validProof
            });

        Assert.True(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.True(accepted.Verified);
        Assert.False(rejectedProof.Verified);
        Assert.False(rejectedPublicInputs.Verified);
    }

    [Fact]
    public async Task NativeGroth16ZkProofBackend_LoadsManagedMclKernelFromConfiguration()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:LibraryPath"] = NativeGroth16ZkProofBackendOptions.ManagedMclLibraryPath,
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeyPath"] = temp.VerifyingKeyPath,
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeySha256"] = temp.VerifyingKeySha256
        });
        using var backend = new NativeGroth16ZkProofBackend(
            configuration,
            new CapturingLogger<NativeGroth16ZkProofBackend>());
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] proof = MclGroth16PairingFixture.CreateProof(
            verifyingKey,
            NativeGroth16PublicInputCodec.Encode(request).Span);

        ProductionZkProofBackendResult result = await backend.VerifyAsync(request with { Proof = proof });

        Assert.True(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.True(result.Verified);
    }

    [Fact]
    public async Task MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] proof = MclGroth16PairingFixture.CreateProof(
            verifyingKey,
            NativeGroth16PublicInputCodec.Encode(request).Span);
        var backend = CreateFixtureBackend(temp, MclGroth16VerifierLibrary.Create());

        _ = await backend.VerifyAsync(request with { Proof = proof });
        double[] elapsedMs = new double[32];
        for (int index = 0; index < elapsedMs.Length; index++)
        {
            long started = Stopwatch.GetTimestamp();
            ProductionZkProofBackendResult result = await backend.VerifyAsync(request with { Proof = proof });
            elapsedMs[index] = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            Assert.True(result.Verified);
        }

        Array.Sort(elapsedMs);
        double p99 = elapsedMs[(int)Math.Ceiling(elapsedMs.Length * 0.99) - 1];
        Assert.True(p99 <= 50, $"MCL verifier p99 {p99:F2}ms exceeds 50ms native verifier budget.");
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
        var logger = new CapturingLogger<ProductionZkProofVerifier>();
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            logger,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "5"
            });

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidVerificationRequest([1, 2, 3], temp.VerifyingKeySha256));

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Contains(logger.Messages, static message => message.Contains("timed out", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ProductionZkProofVerifier_NativeBackendUsesExistingConcurrencyGate()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new ConcurrencyProbeProductionZkProofBackend(TimeSpan.FromMilliseconds(25));
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
        Assert.Equal(1, backend.MaxInFlight);
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
            CredentialLevel: "trusted",
            ReputationBucket: "trusted",
            PolicyHash: PolicyHash,
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
            CredentialLevel: "trusted",
            ReputationBucket: "trusted",
            PolicyHash: PolicyHash,
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

    private sealed class ConcurrencyProbeProductionZkProofBackend(TimeSpan delay) : IProductionZkProofBackend
    {
        private int _inFlight;
        private int _maxInFlight;

        public int MaxInFlight => Volatile.Read(ref _maxInFlight);

        public bool IsAvailable(string backendName)
            => string.Equals(backendName, ZkProdOptions.NativeGroth16Backend, StringComparison.Ordinal);

        public async Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            int inFlight = Interlocked.Increment(ref _inFlight);
            TrackMax(inFlight);
            try
            {
                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, cancellationToken);
                }

                return ProductionZkProofBackendResult.Accepted();
            }
            finally
            {
                Interlocked.Decrement(ref _inFlight);
            }
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
            VerifyingKeyPath = Path.Combine(directoryPath, "comment.v2.vk");
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

        public static TempNativeZkFixture Create(byte[] verifyingKeyBytes)
            => new(
                Path.Combine(Path.GetTempPath(), "fsus-zk-native-" + Guid.NewGuid().ToString("N")),
                verifyingKeyBytes);

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

    private static unsafe class MclGroth16PairingFixture
    {
        private const int MclBnSnark1 = 4;
        private const int MclCompiledTimeVar = 46;
        private static readonly byte[] VerifyingKeyMagic = "FSG16VK1"u8.ToArray();
        private static readonly byte[] ProofMagic = "FSG16PF1"u8.ToArray();
        private static bool _initialized;

        public static byte[] CreateVerifyingKey()
        {
            EnsureInitialized();
            mclBnG1 alpha = HashToG1("fsus:test:alpha");
            mclBnG2 beta = HashToG2("fsus:test:beta");
            mclBnG2 gamma = HashToG2("fsus:test:gamma");
            mclBnG2 delta = gamma;
            var ic0 = new mclBnG1();
            Mcl.mclBnG1_clear(ref ic0);
            mclBnG1 ic1 = HashToG1("fsus:test:ic1");

            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
            writer.Write(VerifyingKeyMagic);
            writer.Write((ushort)1);
            writer.Write((ushort)1);
            writer.Write((ushort)MclBnSnark1);
            writer.Write((ushort)2);
            writer.Write(SerializeG1(ref alpha));
            writer.Write(SerializeG2(ref beta));
            writer.Write(SerializeG2(ref gamma));
            writer.Write(SerializeG2(ref delta));
            writer.Write(SerializeG1(ref ic0));
            writer.Write(SerializeG1(ref ic1));
            writer.Flush();
            return stream.ToArray();
        }

        public static byte[] CreateProof(byte[] verifyingKey, ReadOnlySpan<byte> publicInputs)
        {
            EnsureInitialized();
            ReadOnlySpan<byte> key = verifyingKey;
            int offset = VerifyingKeyMagic.Length + (sizeof(ushort) * 4);
            mclBnG1 alpha = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));
            offset += Mcl.mclBn_getG1ByteSize();
            mclBnG2 beta = DeserializeG2(key.Slice(offset, Mcl.mclBn_getG2ByteSize()));
            offset += Mcl.mclBn_getG2ByteSize() * 3;
            mclBnG1 ic0 = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));
            offset += Mcl.mclBn_getG1ByteSize();
            mclBnG1 ic1 = DeserializeG1(key.Slice(offset, Mcl.mclBn_getG1ByteSize()));

            mclBnFr transcriptScalar = HashPublicInputs(publicInputs);
            var scaled = new mclBnG1();
            Mcl.mclBnG1_mul(ref scaled, in ic1, in transcriptScalar);
            var vkX = new mclBnG1();
            Mcl.mclBnG1_add(ref vkX, in ic0, in scaled);
            var c = new mclBnG1();
            Mcl.mclBnG1_neg(ref c, in vkX);

            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
            writer.Write(ProofMagic);
            writer.Write((ushort)1);
            writer.Write(SerializeG1(ref alpha));
            writer.Write(SerializeG2(ref beta));
            writer.Write(SerializeG1(ref c));
            writer.Flush();
            return stream.ToArray();
        }

        private static void EnsureInitialized()
        {
            if (_initialized)
            {
                return;
            }

            Assert.Equal(0, Mcl.mclBn_init(MclBnSnark1, MclCompiledTimeVar));
            Mcl.mclBn_verifyOrderG1(1);
            Mcl.mclBn_verifyOrderG2(1);
            _initialized = true;
        }

        private static mclBnG1 HashToG1(string seed)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(seed);
            var point = new mclBnG1();
            fixed (byte* ptr = bytes)
            {
                Assert.Equal(0, Mcl.mclBnG1_hashAndMapTo(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length));
            }

            return point;
        }

        private static mclBnG2 HashToG2(string seed)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(seed);
            var point = new mclBnG2();
            fixed (byte* ptr = bytes)
            {
                Assert.Equal(0, Mcl.mclBnG2_hashAndMapTo(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length));
            }

            return point;
        }

        private static mclBnFr HashPublicInputs(ReadOnlySpan<byte> publicInputs)
        {
            byte[] digest = SHA256.HashData(publicInputs);
            var scalar = new mclBnFr();
            fixed (byte* ptr = digest)
            {
                Assert.Equal(0, Mcl.mclBnFr_setBigEndianMod(ref scalar, (IntPtr)ptr, (UIntPtr)digest.Length));
            }

            return scalar;
        }

        private static byte[] SerializeG1(ref mclBnG1 point)
        {
            byte[] output = new byte[Mcl.mclBn_getG1ByteSize()];
            fixed (byte* ptr = output)
            {
                Assert.Equal((UIntPtr)output.Length, Mcl.mclBnG1_serialize((IntPtr)ptr, (UIntPtr)output.Length, in point));
            }

            return output;
        }

        private static byte[] SerializeG2(ref mclBnG2 point)
        {
            byte[] output = new byte[Mcl.mclBn_getG2ByteSize()];
            fixed (byte* ptr = output)
            {
                Assert.Equal((UIntPtr)output.Length, Mcl.mclBnG2_serialize((IntPtr)ptr, (UIntPtr)output.Length, in point));
            }

            return output;
        }

        private static mclBnG1 DeserializeG1(ReadOnlySpan<byte> bytes)
        {
            var point = new mclBnG1();
            fixed (byte* ptr = bytes)
            {
                Assert.Equal((UIntPtr)bytes.Length, Mcl.mclBnG1_deserialize(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length));
            }

            return point;
        }

        private static mclBnG2 DeserializeG2(ReadOnlySpan<byte> bytes)
        {
            var point = new mclBnG2();
            fixed (byte* ptr = bytes)
            {
                Assert.Equal((UIntPtr)bytes.Length, Mcl.mclBnG2_deserialize(ref point, (IntPtr)ptr, (UIntPtr)bytes.Length));
            }

            return point;
        }
    }
}
