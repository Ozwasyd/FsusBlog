using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using Nethermind.MclBindings;
namespace FsusBlog.Server.Tests.Unit;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class MclGroth16TestCollection
{
    public const string Name = "MCL Groth16";
}

[Collection(MclGroth16TestCollection.Name)]
public sealed class NativeGroth16ZkProofBackendTests
{
    private const string CircuitId = "fsus.anonymous.comment.v5";
    private static readonly string s_credentialRoot = new('e', 64);
    private static readonly string s_revocationRoot = new('8', 64);
    private static readonly string s_issuerPublicKeyHash = new('f', 64);
    private const long CredentialEpoch = 7;
    private const ushort PublicInputLayoutVersion = 6;
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const int NativeP99SampleCount = 32;
    private const double NativeP99BudgetMilliseconds = 50;
    private static readonly string s_policyHash = new('9', 64);

    [Fact]
    public async Task NativeGroth16ZkProofBackend_MissingNativeLibraryIsUnavailableAndRejects()
    {
        using var temp = TempNativeZkFixture.Create();
        IConfiguration configuration = BuildNativeConfiguration(temp, missingLibrary: true);
        var backend = new NativeGroth16ZkProofBackend(
            configuration,
            new CapturingLogger<NativeGroth16ZkProofBackend>());

        ProductionZkProofBackendResult result = await backend.VerifyAsync(ValidBackendRequest([1, 2, 3], temp.VerifyingKeySha256));

        Assert.False(backend.IsAvailable(ZkVerifierOptions.NativeGroth16Backend));
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

        Assert.False(backend.IsAvailable(ZkVerifierOptions.NativeGroth16Backend));
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

        ProductionZkProofBackendResult accepted = await backend.VerifyAsync(validRequest with
        {
            Proof = validProof
        });
        byte[] tamperedProof = [.. validProof];
        tamperedProof[0] ^= 0xff;
        ProductionZkProofBackendResult rejected = await backend.VerifyAsync(validRequest with
        {
            Proof = tamperedProof
        });

        Assert.True(backend.IsAvailable(ZkVerifierOptions.NativeGroth16Backend));
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

        ProductionZkProofBackendResult accepted = await backend.VerifyAsync(validRequest with
        {
            Proof = validProof
        });
        byte[] tamperedProof = [.. validProof];
        tamperedProof[^1] ^= 0x01;
        ProductionZkProofBackendResult rejectedProof = await backend.VerifyAsync(validRequest with
        {
            Proof = tamperedProof
        });
        ProductionZkProofBackendResult rejectedPublicInputs = await backend.VerifyAsync(
            validRequest with
            {
                Scope = "article:43",
                Proof = validProof
            });

        Assert.True(backend.IsAvailable(ZkVerifierOptions.NativeGroth16Backend));
        Assert.True(accepted.Verified);
        Assert.False(rejectedProof.Verified);
        Assert.False(rejectedPublicInputs.Verified);
    }

    [Fact]
    public void MclGroth16VerifierLibrary_RejectsMalformedAndNonCanonicalProofCorpus()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        ReadOnlyMemory<byte> publicInputs = NativeGroth16PublicInputCodec.Encode(request);
        byte[] validProof = MclGroth16PairingFixture.CreateProof(verifyingKey, publicInputs.Span);
        using MclGroth16VerifierLibrary library = MclGroth16VerifierLibrary.Create();
        Assert.True(library.IsLoaded);

        const int ProofHeaderBytes = 10;
        byte[] nonCanonicalPoints = [.. validProof];
        Array.Fill(nonCanonicalPoints, byte.MaxValue, ProofHeaderBytes, nonCanonicalPoints.Length - ProofHeaderBytes);
        byte[] forbiddenZeroPoint = [.. validProof];
        Array.Clear(forbiddenZeroPoint, ProofHeaderBytes, forbiddenZeroPoint.Length - ProofHeaderBytes);
        List<byte[]> rejectedCorpus =
        [
            [],
            [.. validProof.AsSpan(0, validProof.Length - 1)],
            [.. validProof, 0x00],
            [0x46, 0x53, 0x47, 0x31],
            nonCanonicalPoints,
            forbiddenZeroPoint
        ];

        var random = new Random(0x1107);
        for (int index = 0; index < 64; index++)
        {
            int length = random.Next(1, validProof.Length + 16);
            byte[] candidate = new byte[length];
            random.NextBytes(candidate);
            candidate[0] = 0; // Every generated case is deterministically outside the canonical proof framing.
            rejectedCorpus.Add(candidate);
        }

        foreach (byte[] candidate in rejectedCorpus)
        {
            NativeGroth16VerifierCallResult result = library.Verify(verifyingKey, publicInputs.Span, candidate);
            Assert.False(result.Verified);
        }
    }

    [Fact]
    public void MclGroth16VerifierLibrary_SerializesConcurrentPairingCallsAcrossInstances()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        ReadOnlyMemory<byte> publicInputs = NativeGroth16PublicInputCodec.Encode(request);
        byte[] proof = MclGroth16PairingFixture.CreateProof(verifyingKey, publicInputs.Span);
        using MclGroth16VerifierLibrary first = MclGroth16VerifierLibrary.Create();
        using MclGroth16VerifierLibrary second = MclGroth16VerifierLibrary.Create();
        var verified = new bool[24];

        Parallel.For(
            0,
            verified.Length,
            new ParallelOptions { MaxDegreeOfParallelism = 4 },
            index =>
            {
                MclGroth16VerifierLibrary library = index % 2 == 0 ? first : second;
                verified[index] = library.Verify(verifyingKey, publicInputs.Span, proof).Verified;
            });

        Assert.All(verified, Assert.True);
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
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = temp.VerifyingKeySha256
        });
        using var backend = new NativeGroth16ZkProofBackend(
            configuration,
            new CapturingLogger<NativeGroth16ZkProofBackend>());
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] proof = MclGroth16PairingFixture.CreateProof(
            verifyingKey,
            NativeGroth16PublicInputCodec.Encode(request).Span);

        ProductionZkProofBackendResult result = await backend.VerifyAsync(request with
        {
            Proof = proof
        });

        Assert.True(backend.IsAvailable(ZkVerifierOptions.NativeGroth16Backend));
        Assert.True(result.Verified);
    }

    [Fact]
    public void NativeGroth16PublicInputCodec_ReturnsSingleOwnedBufferWithinAllocationBudget()
    {
        ProductionZkProofBackendRequest request = ValidBackendRequest([], new string('f', 64));
        for (int index = 0; index < 32; index++)
        {
            _ = NativeGroth16PublicInputCodec.Encode(request);
        }

        const int Iterations = 512;
        int encodedBytes = 0;
        long before = GC.GetAllocatedBytesForCurrentThread();
        ReadOnlyMemory<byte> encoded = default;
        for (int index = 0; index < Iterations; index++)
        {
            encoded = NativeGroth16PublicInputCodec.Encode(request);
            encodedBytes += encoded.Length;
        }
        long allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.True(MemoryMarshal.TryGetArray(encoded, out ArraySegment<byte> segment));
        Assert.NotNull(segment.Array);
        Assert.True(segment.Count > 0);
        Assert.Equal(segment.Count * Iterations, encodedBytes);
        Assert.InRange(allocated / Iterations, 1, 1024);
    }

    [Fact]
    [Trait("Category", "Performance")]
    public async Task MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget()
    {
        byte[] verifyingKey = MclGroth16PairingFixture.CreateVerifyingKey();
        using var temp = TempNativeZkFixture.Create(verifyingKey);
        ProductionZkProofBackendRequest request = ValidBackendRequest([], temp.VerifyingKeySha256);
        byte[] proof = MclGroth16PairingFixture.CreateProof(
            verifyingKey,
            NativeGroth16PublicInputCodec.Encode(request).Span);
        var backend = CreateFixtureBackend(temp, MclGroth16VerifierLibrary.Create());

        _ = await backend.VerifyAsync(request with
        {
            Proof = proof
        });
        double[] elapsedMs = new double[NativeP99SampleCount];
        bool[] verified = new bool[NativeP99SampleCount];
        for (int index = 0; index < elapsedMs.Length; index++)
        {
            long started = Stopwatch.GetTimestamp();
            ProductionZkProofBackendResult result = await backend.VerifyAsync(request with
            {
                Proof = proof
            });
            elapsedMs[index] = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            verified[index] = result.Verified;
        }

        double[] sortedElapsedMs = [.. elapsedMs];
        Array.Sort(sortedElapsedMs);
        double p99 = sortedElapsedMs[(int)Math.Ceiling(sortedElapsedMs.Length * 0.99) - 1];
        WriteNativeP99Evidence(elapsedMs, verified, p99);
        Assert.All(verified, Assert.True);
        Assert.True(
            p99 <= NativeP99BudgetMilliseconds,
            $"MCL verifier p99 {p99:F2}ms exceeds {NativeP99BudgetMilliseconds:F0}ms native verifier budget.");
    }

    private static void WriteNativeP99Evidence(double[] elapsedMs, bool[] verified, double p99)
    {
        string? evidencePath = Environment.GetEnvironmentVariable("FSUSBLOG_NATIVE_P99_EVIDENCE_PATH");
        if (string.IsNullOrWhiteSpace(evidencePath))
        {
            throw new InvalidOperationException("Native P99 producer evidence path is required when this test is selected.");
        }

        string assemblyPath = Assembly.GetExecutingAssembly().Location;
        var evidence = new
        {
            schema = "fsusblog.native-groth16-p99-measurement.v1",
            status = verified.All(static value => value)
                && p99 <= NativeP99BudgetMilliseconds
                    ? "passed"
                    : "failed",
            testId = "FsusBlog.Server.Tests.Unit.NativeGroth16ZkProofBackendTests.MclGroth16VerifierLibrary_VerifyP99StaysInsideNativeBudget",
            warmupCount = 1,
            sampleCount = elapsedMs.Length,
            thresholdMs = NativeP99BudgetMilliseconds,
            p99Ms = p99,
            samples = elapsedMs.Select((elapsed, index) => new
            {
                index,
                elapsedMs = elapsed,
                verified = verified[index]
            }),
            testAssembly = new
            {
                path = assemblyPath,
                sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assemblyPath))).ToLowerInvariant()
            }
        };
        string absolutePath = Path.GetFullPath(evidencePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
        string temporaryPath = $"{absolutePath}.next-{Environment.ProcessId}";
        File.WriteAllText(temporaryPath, $"{JsonSerializer.Serialize(evidence, new JsonSerializerOptions { WriteIndented = true })}\n");
        File.Move(temporaryPath, absolutePath, overwrite: true);
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
            ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkVerifierOptions.NativeGroth16Backend
        }));

        ServiceDescriptor nativeBackend = Assert.Single(
            nativeServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(NativeGroth16ZkProofBackend), nativeBackend.ImplementationType);

        var unavailableServices = new ServiceCollection();
        unavailableServices.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "false",
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkVerifierOptions.NativeGroth16Backend
        }));

        ServiceDescriptor unavailableBackend = Assert.Single(
            unavailableServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(NativeGroth16ZkProofBackend), unavailableBackend.ImplementationType);
    }

    [Fact]
    public void RuntimeServices_RegisterLocalDevZkFixtureBackendOnlyForDevelopmentOptIn()
    {
        var developmentServices = new ServiceCollection();
        developmentServices.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Development",
            ["AnonymousIdentity:ZkVerifier:LocalDevFixture:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = "local_dev_fixture"
        }));

        ServiceDescriptor developmentBackend = Assert.Single(
            developmentServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(LocalDevZkProofBackend), developmentBackend.ImplementationType);

        var productionServices = new ServiceCollection();
        productionServices.AddFsusRuntimeSecurityAndLifecycleServices(BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
            ["AnonymousIdentity:ZkVerifier:LocalDevFixture:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:Backend"] = "local_dev_fixture"
        }));

        ServiceDescriptor productionBackend = Assert.Single(
            productionServices,
            static item => item.ServiceType == typeof(IProductionZkProofBackend));
        Assert.Equal(typeof(UnavailableProductionZkProofBackend), productionBackend.ImplementationType);
    }

    [Fact]
    public async Task ProductionZkProofVerifier_NativeBackendTimeoutFailsClosed()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new CancellationRequiredProductionZkProofBackend(TimeSpan.FromSeconds(5));
        var logger = new CapturingLogger<ProductionZkProofVerifier>();
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            logger,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "20"
            });

        ZkProofVerificationResult result = await verifier.VerifyAsync(ValidVerificationRequest([1, 2, 3], temp.VerifyingKeySha256));

        Assert.False(result.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, result.Status);
        Assert.Contains(logger.Messages, static message => message.Contains("timed out", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData(1, 8)]
    [InlineData(4, 12)]
    [InlineData(16, 24)]
    [Trait("Category", "Concurrency")]
    public async Task ProductionZkProofVerifier_NativeBackendUsesExistingConcurrencyGate(
        int maxConcurrent,
        int attempts)
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new ControlledProductionZkProofBackend(maxConcurrent);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: ConcurrencyOverrides(maxConcurrent.ToString()));
        ZkProofVerificationRequest[] requests = Enumerable.Range(1, attempts)
            .Select(index => ValidVerificationRequest([(byte)index], temp.VerifyingKeySha256))
            .ToArray();

        Task<ZkProofVerificationResult>[] tasks = StartTogether(verifier, requests);

        Assert.Equal(maxConcurrent, backend.CallCount);
        Assert.Equal(maxConcurrent, backend.InFlight);
        Assert.Equal(maxConcurrent, backend.MaxInFlight);
        backend.CompleteHeldCalls(ProductionZkProofBackendResult.Accepted());

        ZkProofVerificationResult[] results = await AwaitResultsAsync(tasks);
        Assert.All(results, static result => Assert.True(result.Verified));
        Assert.Equal(attempts, backend.CallCount);
        Assert.Equal(0, backend.InFlight);
        Assert.All(backend.Requests, AssertBackendRequestPreservesPublicInputs);
        Assert.Equal(attempts, backend.Requests.Select(static request => request.Proof.ToArray()[0]).Distinct().Count());
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ProductionZkProofVerifier_CallerCancellationReleasesSlotForQueuedRequest()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new ControlledProductionZkProofBackend(heldCallCount: 1);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: ConcurrencyOverrides("1"));
        using var cancellation = new CancellationTokenSource();

        Task<ZkProofVerificationResult> canceled = verifier.VerifyAsync(
            ValidVerificationRequest([1], temp.VerifyingKeySha256),
            cancellation.Token);
        Task<ZkProofVerificationResult> queued = verifier.VerifyAsync(
            ValidVerificationRequest([2], temp.VerifyingKeySha256));

        Assert.Equal(1, backend.CallCount);
        cancellation.Cancel();

        ZkProofVerificationResult[] results = await AwaitResultsAsync(canceled, queued);
        Assert.False(results[0].Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, results[0].Status);
        Assert.True(results[1].Verified);
        Assert.Equal(2, backend.CallCount);
        Assert.Equal(1, backend.MaxInFlight);
        Assert.Equal(0, backend.InFlight);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ProductionZkProofVerifier_BackendTimeoutReleasesSlotAndFailsClosed()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new ControlledProductionZkProofBackend(heldCallCount: 1);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: new Dictionary<string, string?>
            {
                ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = "1",
                ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "20"
            });

        ZkProofVerificationResult timedOut = await verifier.VerifyAsync(
            ValidVerificationRequest([1], temp.VerifyingKeySha256));
        ZkProofVerificationResult recovered = await verifier.VerifyAsync(
            ValidVerificationRequest([2], temp.VerifyingKeySha256));

        Assert.False(timedOut.Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, timedOut.Status);
        Assert.True(recovered.Verified);
        Assert.Equal(2, backend.CallCount);
        Assert.Equal(1, backend.MaxInFlight);
        Assert.Equal(0, backend.InFlight);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ProductionZkProofVerifier_BackendExceptionReleasesSlotForQueuedRequest()
    {
        using var temp = TempNativeZkFixture.Create();
        var backend = new ControlledProductionZkProofBackend(heldCallCount: 1);
        using ProductionZkProofVerifier verifier = CreateProductionVerifier(
            temp,
            backend,
            overrides: ConcurrencyOverrides("1"));

        Task<ZkProofVerificationResult> failed = verifier.VerifyAsync(
            ValidVerificationRequest([1], temp.VerifyingKeySha256));
        Task<ZkProofVerificationResult> queued = verifier.VerifyAsync(
            ValidVerificationRequest([2], temp.VerifyingKeySha256));

        Assert.Equal(1, backend.CallCount);
        backend.FailHeldCalls(new InvalidOperationException("controlled backend failure"));

        ZkProofVerificationResult[] results = await AwaitResultsAsync(failed, queued);
        Assert.False(results[0].Verified);
        Assert.Equal(ZkProofVerificationStatuses.InvalidProof, results[0].Status);
        Assert.True(results[1].Verified);
        Assert.Equal(2, backend.CallCount);
        Assert.Equal(1, backend.MaxInFlight);
        Assert.Equal(0, backend.InFlight);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task ProductionZkProofVerifier_InvalidConcurrencyConfigurationUsesClampAndDefault()
    {
        using var temp = TempNativeZkFixture.Create();
        (string? Configured, int Effective)[] cases =
        [
            ("0", 1),
            ("-4", 1),
            ("65", 64),
            (null, Math.Clamp(Math.Max(1, Environment.ProcessorCount / 2), 1, 64))
        ];

        foreach ((string? configured, int effective) in cases)
        {
            var backend = new ControlledProductionZkProofBackend(effective);
            using ProductionZkProofVerifier verifier = CreateProductionVerifier(
                temp,
                backend,
                overrides: ConcurrencyOverrides(configured));
            ZkProofVerificationRequest[] requests = Enumerable.Range(1, effective + 1)
                .Select(index => ValidVerificationRequest([(byte)index], temp.VerifyingKeySha256))
                .ToArray();

            Task<ZkProofVerificationResult>[] tasks = StartTogether(verifier, requests);

            Assert.Equal(effective, backend.CallCount);
            Assert.Equal(effective, backend.MaxInFlight);
            backend.CompleteHeldCalls(ProductionZkProofBackendResult.Accepted());
            ZkProofVerificationResult[] results = await AwaitResultsAsync(tasks);
            Assert.All(results, static result => Assert.True(result.Verified));
            Assert.Equal(effective + 1, backend.CallCount);
            Assert.Equal(0, backend.InFlight);
        }
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task RuntimeServices_SingletonVerifierSharesConcurrencyGateAcrossScopes()
    {
        using var temp = TempNativeZkFixture.Create();
        IConfiguration configuration = BuildVerifierConfiguration(
            temp,
            ConcurrencyOverrides("1"));
        var backend = new ControlledProductionZkProofBackend(heldCallCount: 1);
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(configuration);
        services.AddFsusRuntimeSecurityAndLifecycleServices(configuration);
        services.AddSingleton<IAnonymousCredentialRootReader>(new FixedRootReader(s_credentialRoot, CredentialEpoch));
        services.AddSingleton<IProductionZkProofBackend>(backend);
        await using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope firstScope = provider.CreateScope();
        using IServiceScope secondScope = provider.CreateScope();
        IZkProofVerifier first = firstScope.ServiceProvider.GetRequiredService<IZkProofVerifier>();
        IZkProofVerifier second = secondScope.ServiceProvider.GetRequiredService<IZkProofVerifier>();

        Assert.Same(first, second);
        Task<ZkProofVerificationResult> held = first.VerifyAsync(
            ValidVerificationRequest([1], temp.VerifyingKeySha256));
        Task<ZkProofVerificationResult> queued = second.VerifyAsync(
            ValidVerificationRequest([2], temp.VerifyingKeySha256));

        Assert.Equal(1, backend.CallCount);
        backend.CompleteHeldCalls(ProductionZkProofBackendResult.Accepted());
        ZkProofVerificationResult[] results = await AwaitResultsAsync(held, queued);
        Assert.All(results, static result => Assert.True(result.Verified));
        Assert.Equal(2, backend.CallCount);
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

    private static Task<ZkProofVerificationResult>[] StartTogether(
        ProductionZkProofVerifier verifier,
        IReadOnlyList<ZkProofVerificationRequest> requests)
    {
        using var barrier = new Barrier(requests.Count);
        using var invoked = new CountdownEvent(requests.Count);
        Task<ZkProofVerificationResult>[] tasks = requests
            .Select(request => Task.Factory.StartNew(
                async () =>
                {
                    Assert.True(
                        barrier.SignalAndWait(TimeSpan.FromSeconds(30)),
                        "Timed out waiting for verifier concurrency barrier.");
                    Task<ZkProofVerificationResult> verification = verifier.VerifyAsync(request);
                    invoked.Signal();
                    return await verification;
                },
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default).Unwrap())
            .ToArray();

        Assert.True(
            invoked.Wait(TimeSpan.FromSeconds(30)),
            "Timed out waiting for all verifier calls to enter the production concurrency boundary.");
        return tasks;
    }

    private static async Task<T[]> AwaitResultsAsync<T>(params Task<T>[] pending)
        => await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(30));

    private static void AssertBackendRequestPreservesPublicInputs(ProductionZkProofBackendRequest request)
    {
        Assert.Equal("comment.create", request.ActionContext);
        Assert.Equal("article:42", request.Scope);
        Assert.Equal(CircuitId, request.CircuitId);
        Assert.Equal(
            Convert.ToHexString(SHA256.HashData("fixture-verifying-key"u8)).ToLowerInvariant(),
            request.VerifyingKeyHash);
        Assert.Equal(PublicInputLayoutVersion, request.PublicInputLayoutVersion);
        Assert.Equal(NullifierHash, request.NullifierHash);
        Assert.Equal(s_credentialRoot, request.CredentialRoot);
        Assert.Equal(s_revocationRoot, request.RevocationRoot);
        Assert.Equal(s_issuerPublicKeyHash, request.IssuerPublicKeyHash);
        Assert.Equal(s_policyHash, request.PolicyHash);
        Assert.True(request.IsEligible);
        Assert.True(request.MayComment);
        Assert.Equal(AnonymousPrivacyContract.CommonRateClass, request.RateClass);
        Assert.False(request.RequiresModeration);
        Assert.Single(request.Proof.ToArray());
    }

    private static Dictionary<string, string?> ConcurrencyOverrides(string? maxConcurrent)
        => new()
        {
            ["AnonymousIdentity:ZkVerifier:BackendTimeoutMs"] = "30000",
            ["AnonymousIdentity:ZkVerifier:MaxConcurrentVerifications"] = maxConcurrent
        };

    private static ProductionZkProofVerifier CreateProductionVerifier(
        TempNativeZkFixture temp,
        IProductionZkProofBackend backend,
        ILogger<ProductionZkProofVerifier>? logger = null,
        Dictionary<string, string?>? overrides = null)
        => new(
            BuildVerifierConfiguration(temp, overrides),
            new FixedRootReader(s_credentialRoot, CredentialEpoch),
            backend,
            logger ?? new CapturingLogger<ProductionZkProofVerifier>());

    private static IConfiguration BuildVerifierConfiguration(
        TempNativeZkFixture temp,
        Dictionary<string, string?>? overrides = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:Enabled"] = "true",
            ["AnonymousIdentity:ZkVerifier:CircuitId"] = CircuitId,
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = temp.VerifyingKeySha256,
            ["AnonymousIdentity:ZkVerifier:PublicInputLayoutVersion"] = PublicInputLayoutVersion.ToString(),
            ["AnonymousIdentity:ZkVerifier:MaxProofBytes"] = "4096",
            ["AnonymousIdentity:ZkVerifier:Backend"] = ZkVerifierOptions.NativeGroth16Backend,
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

        return BuildConfiguration(values);
    }

    private static IConfiguration BuildNativeConfiguration(TempNativeZkFixture temp, bool missingLibrary)
        => BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:LibraryPath"] = missingLibrary
                ? Path.Combine(temp.DirectoryPath, "missing", "libfsus_zk_groth16.so")
                : temp.NativeLibraryPath,
            ["AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeyPath"] = temp.VerifyingKeyPath,
            ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = temp.VerifyingKeySha256
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
            NullifierHash: NullifierHash,
            CredentialRoot: s_credentialRoot,
            PolicyHash: s_policyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: proof,
            RevocationRoot: s_revocationRoot,
            IssuerPublicKeyHash: s_issuerPublicKeyHash);

    private static ZkProofVerificationRequest ValidVerificationRequest(byte[] proof, string verifyingKeyHash)
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            NullifierHash: NullifierHash,
            CredentialRoot: s_credentialRoot,
            PolicyHash: s_policyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: proof,
            RevocationRoot: s_revocationRoot,
            IssuerPublicKeyHash: s_issuerPublicKeyHash);

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

        public bool AcceptAnyProof
        {
            get; init;
        }

        public bool ThrowOnVerify
        {
            get; init;
        }

        public TimeSpan Delay
        {
            get; init;
        }

        public int CallCount
        {
            get; private set;
        }

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

    private sealed class ControlledProductionZkProofBackend(int heldCallCount) : IProductionZkProofBackend
    {
        private readonly ConcurrentDictionary<int, TaskCompletionSource<ProductionZkProofBackendResult>> _heldCalls = new();
        private readonly ConcurrentDictionary<int, ProductionZkProofBackendRequest> _requests = new();
        private int _callCount;
        private int _inFlight;
        private int _maxInFlight;

        public int CallCount => Volatile.Read(ref _callCount);

        public int InFlight => Volatile.Read(ref _inFlight);

        public int MaxInFlight => Volatile.Read(ref _maxInFlight);

        public IReadOnlyCollection<ProductionZkProofBackendRequest> Requests => _requests
            .OrderBy(static pair => pair.Key)
            .Select(static pair => pair.Value)
            .ToArray();

        public bool IsAvailable(string backendName)
            => string.Equals(backendName, ZkVerifierOptions.NativeGroth16Backend, StringComparison.Ordinal);

        public async Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            int callId = Interlocked.Increment(ref _callCount);
            _requests[callId] = request;
            int inFlight = Interlocked.Increment(ref _inFlight);
            TrackMax(inFlight);
            try
            {
                if (callId > heldCallCount)
                {
                    return ProductionZkProofBackendResult.Accepted();
                }

                var completion = new TaskCompletionSource<ProductionZkProofBackendResult>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                Assert.True(_heldCalls.TryAdd(callId, completion));
                return await completion.Task.WaitAsync(cancellationToken);
            }
            finally
            {
                _heldCalls.TryRemove(callId, out _);
                Interlocked.Decrement(ref _inFlight);
            }
        }

        public void CompleteHeldCalls(ProductionZkProofBackendResult result)
        {
            foreach (TaskCompletionSource<ProductionZkProofBackendResult> completion in _heldCalls.Values)
            {
                completion.TrySetResult(result);
            }
        }

        public void FailHeldCalls(Exception exception)
        {
            foreach (TaskCompletionSource<ProductionZkProofBackendResult> completion in _heldCalls.Values)
            {
                completion.TrySetException(exception);
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

    private sealed class CancellationRequiredProductionZkProofBackend(TimeSpan fallbackDelay) : IProductionZkProofBackend
    {
        public bool IsAvailable(string backendName)
            => string.Equals(backendName, ZkVerifierOptions.NativeGroth16Backend, StringComparison.Ordinal);

        public async Task<ProductionZkProofBackendResult> VerifyAsync(
            ProductionZkProofBackendRequest request,
            CancellationToken cancellationToken = default)
        {
            var canceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            await using (cancellationToken.Register(static state =>
                ((TaskCompletionSource)state!).TrySetResult(), canceled).ConfigureAwait(false))
            {
                Task completed = await Task.WhenAny(canceled.Task, Task.Delay(fallbackDelay)).ConfigureAwait(false);
                if (ReferenceEquals(completed, canceled.Task))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                }
            }

            return ProductionZkProofBackendResult.Accepted();
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
            => IsRootAccepted(rootHash, epoch) &&
                string.Equals(revocationRootHash, s_revocationRoot, StringComparison.Ordinal) &&
                string.Equals(issuerPublicKeyHash, s_issuerPublicKeyHash, StringComparison.OrdinalIgnoreCase);
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
            VerifyingKeyPath = Path.Combine(directoryPath, "comment.v5.vk");
            NativeLibraryPath = Path.Combine(directoryPath, "libfsus_zk_groth16.so");
            VerifyingKeySha256 = Convert.ToHexString(SHA256.HashData(verifyingKeyBytes)).ToLowerInvariant();
            Directory.CreateDirectory(directoryPath);
            File.WriteAllBytes(VerifyingKeyPath, verifyingKeyBytes);
        }

        public string DirectoryPath
        {
            get;
        }

        public string VerifyingKeyPath
        {
            get;
        }

        public string NativeLibraryPath
        {
            get;
        }

        public byte[] VerifyingKeyBytes
        {
            get;
        }

        public string VerifyingKeySha256
        {
            get;
        }

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
        private static readonly byte[] s_verifyingKeyMagic = "FSG16VK1"u8.ToArray();
        private static readonly byte[] s_proofMagic = "FSG16PF1"u8.ToArray();
        private static readonly object s_initializationLock = new();
        private static bool s_initialized;

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
            writer.Write(s_verifyingKeyMagic);
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
            int offset = s_verifyingKeyMagic.Length + (sizeof(ushort) * 4);
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
            writer.Write(s_proofMagic);
            writer.Write((ushort)1);
            writer.Write(SerializeG1(ref alpha));
            writer.Write(SerializeG2(ref beta));
            writer.Write(SerializeG1(ref c));
            writer.Flush();
            return stream.ToArray();
        }

        private static void EnsureInitialized()
        {
            if (s_initialized)
            {
                return;
            }

            lock (s_initializationLock)
            {
                if (s_initialized)
                {
                    return;
                }

                using MclGroth16VerifierLibrary library = MclGroth16VerifierLibrary.Create();
                Assert.True(library.IsLoaded);
                s_initialized = true;
            }
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
