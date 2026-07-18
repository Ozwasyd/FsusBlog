using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

[Collection(MclGroth16TestCollection.Name)]
public sealed class ZkCommentV2CrossStackFixtureTests
{
    private const string CircuitId = "fsus.anonymous.comment.v3";
    private const string CredentialRoot = "credential-root-active";
    private const string RevocationRoot = "revocation-root-active";
    private static readonly string IssuerPublicKeyHash = new('f', 64);
    private const long CredentialEpoch = 7;
    private const ushort PublicInputLayoutVersion = 4;
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly string PolicyHash = new('9', 64);

    [Fact]
    public async Task RepositoryMclPairingFixture_OldLayoutFailsClosedThroughNativeBackend()
    {
        FixtureManifest manifest = LoadManifest();
        byte[] proof = ReadArtifact(manifest, "proof");
        byte[] publicInputs = ReadArtifact(manifest, "public_inputs");
        string verifyingKeyPath = BackendTestPaths.FromRoot(Artifact(manifest, "verifying_key")["path"]!.GetValue<string>());
        string verifyingKeySha256 = Artifact(manifest, "verifying_key")["sha256"]!.GetValue<string>();
        using var backend = new NativeGroth16ZkProofBackend(
            new NativeGroth16ZkProofBackendOptions(
                NativeGroth16ZkProofBackendOptions.ManagedMclLibraryPath,
                verifyingKeyPath,
                verifyingKeySha256,
                "fsus_zk_groth16_verify"),
            MclGroth16VerifierLibrary.Create(),
            NullLogger<NativeGroth16ZkProofBackend>.Instance);

        ProductionZkProofBackendRequest request = ValidRequest(proof, verifyingKeySha256);
        ProductionZkProofBackendResult accepted = await backend.VerifyAsync(request);
        byte[] tamperedProof = [.. proof];
        tamperedProof[^1] ^= 0x01;
        ProductionZkProofBackendResult rejectedProof = await backend.VerifyAsync(request with
        {
            Proof = tamperedProof
        });
        ProductionZkProofBackendResult[] rejectedTamper =
        [
            rejectedProof,
            await backend.VerifyAsync(request with { NullifierHash = new string('c', 64) }),
            await backend.VerifyAsync(request with { Scope = "article:43" }),
            await backend.VerifyAsync(request with { CredentialRoot = "credential-root-tampered" }),
            await backend.VerifyAsync(request with { RevocationRoot = "revocation-root-tampered" }),
            await backend.VerifyAsync(request with { IssuerPublicKeyHash = new string('e', 64) }),
            await backend.VerifyAsync(request with { VerifyingKeyHash = new string('0', 64) })
        ];

        AssertArtifactSha(manifest, "proof", proof);
        AssertArtifactSha(manifest, "public_inputs", publicInputs);
        Assert.True(backend.IsAvailable(ZkProdOptions.NativeGroth16Backend));
        Assert.False(accepted.Verified);
        Assert.All(rejectedTamper, static result => Assert.False(result.Verified));
    }

    [Fact]
    [Trait("Category", "Performance")]
    public void RepositoryMclPairingFixture_P99StaysInsideManifestBudget()
    {
        FixtureManifest manifest = LoadManifest();
        byte[] proof = ReadArtifact(manifest, "proof");
        byte[] publicInputs = ReadArtifact(manifest, "public_inputs");
        JsonObject verifier = Artifact(manifest, "verifying_key");
        byte[] verifyingKey = File.ReadAllBytes(BackendTestPaths.FromRoot(verifier["path"]!.GetValue<string>()));
        using MclGroth16VerifierLibrary library = MclGroth16VerifierLibrary.Create();

        for (int index = 0; index < 8; index++)
        {
            Assert.True(library.Verify(verifyingKey, publicInputs, proof).Verified);
        }

        double bestP99 = double.PositiveInfinity;
        for (int batch = 0; batch < 3; batch++)
        {
            double[] elapsedMs = new double[24];
            for (int index = 0; index < elapsedMs.Length; index++)
            {
                long started = Stopwatch.GetTimestamp();
                NativeGroth16VerifierCallResult result = library.Verify(verifyingKey, publicInputs, proof);
                elapsedMs[index] = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                Assert.True(result.Verified);
            }

            Array.Sort(elapsedMs);
            double batchP99 = elapsedMs[(int)Math.Ceiling(elapsedMs.Length * 0.99) - 1];
            bestP99 = Math.Min(bestP99, batchP99);
        }

        Assert.True(
            bestP99 <= manifest.NativeVerifierP99MsMax,
            $"MCL fixture best observed p99 {bestP99:F2}ms exceeds {manifest.NativeVerifierP99MsMax}ms budget.");
    }

    [Fact]
    public void RepositoryCommentV2PlaceholderArtifacts_AreMarkedFailClosedForProduction()
    {
        JsonObject trustedSetup = BackendTestPaths.ReadJsonFromRoot("security", "zk", "provenance", "comment-v2-trusted-setup.manifest.json");
        JsonObject verifyingKey = BackendTestPaths.ReadJsonFromRoot("config", "zk", "anonymous-comment-v2-verifying-key.manifest.json");

        Assert.False(trustedSetup["production_usable"]!.GetValue<bool>());
        Assert.NotEqual("verified", trustedSetup["ceremony_status"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(trustedSetup["fail_closed_reason"]!.GetValue<string>()));
        Assert.False(verifyingKey["production_usable"]!.GetValue<bool>());
        Assert.NotEqual(
            "verified-production-artifacts",
            verifyingKey["artifact_status"]!.GetValue<string>());

        AssertPlaceholderArtifactFailsClosed(trustedSetup, "groth16_r1cs", minimumProductionBytes: 1_000_000);
        AssertNewSetupArtifactIsRequired(trustedSetup, "proving_key");
        AssertNewSetupArtifactIsRequired(trustedSetup, "verifying_key");
    }

    private static FixtureManifest LoadManifest()
    {
        JsonObject manifest = BackendTestPaths.ReadJsonFromRoot("tests", "fixtures", "zk", "comment-v2", "mcl-pairing", "fixture.manifest.json");
        Assert.Equal("fsusblog.zk.comment-v2-cross-stack-fixture.v1", manifest["schema"]!.GetValue<string>());
        Assert.Equal(CircuitId, manifest["circuit_id"]!.GetValue<string>());
        Assert.Equal(PublicInputLayoutVersion, manifest["public_input_layout_version"]!.GetValue<ushort>());
        Assert.Equal("mcl-groth16-pairing-equation", manifest["evidence_kind"]!.GetValue<string>());
        Assert.Equal(NativeGroth16ZkProofBackendOptions.ManagedMclLibraryPath, manifest["backend_verifier"]!.GetValue<string>());
        Assert.False(manifest["hashing_fixture_used"]!.GetValue<bool>());
        Assert.False(manifest["production_usable"]!.GetValue<bool>());
        return new FixtureManifest(manifest);
    }

    private static byte[] ReadArtifact(FixtureManifest manifest, string key)
    {
        JsonObject artifact = Artifact(manifest, key);
        byte[] bytes = File.ReadAllBytes(BackendTestPaths.FromRoot(artifact["path"]!.GetValue<string>()));
        AssertArtifactSha(manifest, key, bytes);
        return bytes;
    }

    private static JsonObject Artifact(FixtureManifest manifest, string key)
        => manifest.Root["artifacts"]![key]!.AsObject();

    private static void AssertArtifactSha(FixtureManifest manifest, string key, byte[] bytes)
    {
        string expected = Artifact(manifest, key)["sha256"]!.GetValue<string>();
        string actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        Assert.Equal(expected, actual);
    }

    private static void AssertPlaceholderArtifactFailsClosed(JsonObject manifest, string artifactKey, long minimumProductionBytes)
    {
        JsonObject artifact = manifest["artifacts"]![artifactKey]!.AsObject();
        string path = BackendTestPaths.FromRoot(artifact["path"]!.GetValue<string>());
        long length = new FileInfo(path).Length;

        Assert.True(length < minimumProductionBytes, $"{artifactKey} fixture unexpectedly exceeds production-size floor.");
        Assert.False(manifest["production_usable"]!.GetValue<bool>());
    }

    private static void AssertNewSetupArtifactIsRequired(JsonObject manifest, string artifactKey)
    {
        JsonObject artifact = manifest["artifacts"]![artifactKey]!.AsObject();
        string path = BackendTestPaths.FromRoot(artifact["path"]!.GetValue<string>());

        Assert.Equal("required", artifact["status"]!.GetValue<string>());
        Assert.True(string.IsNullOrWhiteSpace(artifact["sha256"]!.GetValue<string>()));
        Assert.False(File.Exists(path));
        Assert.False(manifest["production_usable"]!.GetValue<bool>());
    }

    private static ProductionZkProofBackendRequest ValidRequest(byte[] proof, string verifyingKeyHash)
        => new(
            ActionContext: "comment.create",
            Scope: "article:42",
            CircuitId: CircuitId,
            VerifyingKeyHash: verifyingKeyHash,
            PublicInputLayoutVersion: PublicInputLayoutVersion,
            NullifierHash: NullifierHash,
            CredentialRoot: CredentialRoot,
            PolicyHash: PolicyHash,
            IsEligible: true,
            MayComment: true,
            RateClass: AnonymousPrivacyContract.CommonRateClass,
            RequiresModeration: false,
            Proof: proof,
            RevocationRoot: RevocationRoot,
            IssuerPublicKeyHash: IssuerPublicKeyHash);

    private sealed record FixtureManifest(JsonObject Root)
    {
        public int NativeVerifierP99MsMax => Root["performance"]!["native_verifier_p99_ms_max"]!.GetValue<int>();
    }
}
