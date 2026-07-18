using Microsoft.Extensions.Configuration;

using FsusBlog.Server.Infrastructure.Integrity;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SiteIntegritySigningTests
{
    [Fact]
    public void SignAndVerify_ValidSignatureAcceptsAndPayloadTamperRejects()
    {
        DateTimeOffset issuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord key = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-07",
            version: 1,
            notBeforeUtc: issuedAt.AddDays(-1));
        var service = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([key], currentKeyId: key.KeyId));
        SiteIntegritySigningPayload payload = Payload(issuedAt);

        SiteIntegritySignature signature = service.Sign(payload);

        SiteIntegritySignatureVerificationResult accepted = service.Verify(payload, signature);
        SiteIntegritySignatureVerificationResult tampered = service.Verify(
            payload with
            {
                Fields = new Dictionary<string, string>(payload.Fields) { ["artifactDigest"] = new string('b', 64) }
            },
            signature);

        Assert.True(accepted.Accepted);
        Assert.Equal("accepted", accepted.Code);
        Assert.False(tampered.Accepted);
        Assert.Equal("payload-signature-invalid", tampered.Code);
        Assert.Equal("ECDSA_P256_SHA256", signature.Algorithm);
        Assert.Equal("fsusblog.integrity.publish-proof.v1", SiteIntegritySigningPayloadCanonicalizer.DomainSeparator);
    }

    [Fact]
    public void Verify_RejectsUnknownKeyAndAlgorithmMismatch()
    {
        DateTimeOffset issuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord key = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-07",
            version: 1,
            notBeforeUtc: issuedAt.AddDays(-1));
        var service = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([key], currentKeyId: key.KeyId));
        SiteIntegritySigningPayload payload = Payload(issuedAt);
        SiteIntegritySignature signature = service.Sign(payload);

        SiteIntegritySignatureVerificationResult unknownKey = service.Verify(
            payload,
            signature with
            {
                KeyId = "unknown-key"
            });
        SiteIntegritySignatureVerificationResult algorithmMismatch = service.Verify(
            payload,
            signature with
            {
                Algorithm = "RSA_PSS_SHA256"
            });

        Assert.False(unknownKey.Accepted);
        Assert.Equal("unknown-key", unknownKey.Code);
        Assert.False(algorithmMismatch.Accepted);
        Assert.Equal("algorithm-mismatch", algorithmMismatch.Code);
    }

    [Fact]
    public void Rotation_NewProofUsesCurrentKeyAndOldProofStillVerifies()
    {
        DateTimeOffset oldIssuedAt = new(2026, 7, 1, 8, 0, 0, TimeSpan.Zero);
        DateTimeOffset newIssuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord oldKey = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-06",
            version: 1,
            notBeforeUtc: oldIssuedAt.AddDays(-1),
            notAfterUtc: newIssuedAt.AddDays(30));
        SiteSigningKeyRecord newKey = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-07",
            version: 2,
            notBeforeUtc: newIssuedAt.AddHours(-1));
        SiteIntegritySigningPayload oldPayload = Payload(oldIssuedAt);
        SiteIntegritySigningPayload newPayload = Payload(newIssuedAt);
        var oldService = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([oldKey], currentKeyId: oldKey.KeyId));
        var rotatedService = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([oldKey.WithoutPrivateKey(), newKey], currentKeyId: newKey.KeyId));

        SiteIntegritySignature oldSignature = oldService.Sign(oldPayload);
        SiteIntegritySignature newSignature = rotatedService.Sign(newPayload);

        Assert.Equal(oldKey.KeyId, oldSignature.KeyId);
        Assert.Equal(newKey.KeyId, newSignature.KeyId);
        Assert.True(rotatedService.Verify(oldPayload, oldSignature).Accepted);
        Assert.True(rotatedService.Verify(newPayload, newSignature).Accepted);
        Assert.DoesNotContain(
            rotatedService.Registry.PublicKeys,
            metadata => metadata.PrivateKeyAvailable);
    }

    [Fact]
    public void Verify_RevokedAndCompromisedKeysHaveExplicitSemantics()
    {
        DateTimeOffset issuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord baseKey = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-07",
            version: 1,
            notBeforeUtc: issuedAt.AddDays(-1));
        SiteIntegritySigningPayload payload = Payload(issuedAt);
        var signer = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([baseKey], currentKeyId: baseKey.KeyId));
        SiteIntegritySignature signature = signer.Sign(payload);

        var revokedAfterProof = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([baseKey.WithRevokedAt(issuedAt.AddMinutes(1)).WithoutPrivateKey()], currentKeyId: baseKey.KeyId));
        var revokedBeforeProof = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([baseKey.WithRevokedAt(issuedAt).WithoutPrivateKey()], currentKeyId: baseKey.KeyId));
        var compromised = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([baseKey.WithCompromisedAt(issuedAt.AddMinutes(1)).WithoutPrivateKey()], currentKeyId: baseKey.KeyId));

        Assert.True(revokedAfterProof.Verify(payload, signature).Accepted);
        Assert.Equal("key-revoked", revokedBeforeProof.Verify(payload, signature).Code);
        Assert.Equal("key-compromised", compromised.Verify(payload, signature).Code);
    }

    [Fact]
    public void Sign_MissingPrivateKeyFailsClosedWithoutLeakingSecret()
    {
        DateTimeOffset issuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord key = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-2026-07",
            version: 1,
            notBeforeUtc: issuedAt.AddDays(-1));
        string privateKey = key.PrivateKeyPkcs8Base64Url!;
        var service = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([key.WithoutPrivateKey()], currentKeyId: key.KeyId));

        SiteIntegritySigningUnavailableException ex = Assert.Throws<SiteIntegritySigningUnavailableException>(
            () => service.Sign(Payload(issuedAt)));

        Assert.Contains("private-key-missing", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(privateKey, ex.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("BEGIN PRIVATE KEY", ex.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void StartupPolicy_MissingProductionSigningConfigDegradesToPendingWithoutFakeSignature()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["IntegrityProof:Signing:Enabled"] = "true"
            })
            .Build();

        SiteIntegritySigningStartupState state =
            SiteIntegritySigningStartupPolicy.Evaluate(configuration, enforceProductionRules: true);

        Assert.Equal(SiteIntegritySigningAvailability.Pending, state.Availability);
        Assert.False(state.CanSign);
        Assert.Equal("current-key-missing", state.Reason);
    }

    [Fact]
    public void RuntimeSigningSurface_UsesEcdsaWithoutExternalChainOrWalletDependencies()
    {
        DateTimeOffset issuedAt = new(2026, 7, 4, 8, 0, 0, TimeSpan.Zero);
        SiteSigningKeyRecord key = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-runtime-contract",
            version: 1,
            notBeforeUtc: issuedAt.AddMinutes(-1));
        var service = new SiteIntegritySigningService(
            SiteSigningKeyRegistry.Create([key], currentKeyId: key.KeyId));

        SiteIntegritySignature signature = service.Sign(Payload(issuedAt));

        Assert.Equal("ECDSA_P256_SHA256", signature.Algorithm);
        Assert.True(service.Verify(Payload(issuedAt), signature).Accepted);
        Assert.NotNull(typeof(SiteSigningKeyRecord).GetMethod(nameof(SiteSigningKeyRecord.CreateEcdsaP256)));

        string[] referencedAssemblies = typeof(SiteIntegritySigningService).Assembly
            .GetReferencedAssemblies()
            .Select(static assembly => assembly.Name ?? string.Empty)
            .ToArray();
        string[] forbiddenDependencies = ["Ed25519", "IPFS", "Arweave", "Nethereum", "SIWE"];
        Assert.DoesNotContain(referencedAssemblies, assemblyName => forbiddenDependencies.Any(forbidden =>
            assemblyName.Contains(forbidden, StringComparison.OrdinalIgnoreCase)));
    }

    private static SiteIntegritySigningPayload Payload(DateTimeOffset issuedAt)
        => new(
            ProofKind: "publish-proof",
            Subject: "article:910002",
            DigestSha256Hex: new string('a', 64),
            IssuedAtUtc: issuedAt,
            Fields: new Dictionary<string, string>
            {
                ["artifactDigest"] = new string('c', 64),
                ["canonicalHash"] = new string('d', 64)
            });
}
