using System.Text.Json;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.WebUtilities;
namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofVerificationTests
{
    private const string TestPrivateKeyPkcs8 =
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg80tREKRs0sJln1dxSdhMWykpuLD_p2laR4GMSQgtFSuhRANCAAT_yNz_vuWYAoaT3W_Ij_0AXgiYhyazWWBBTxAwEyge0LAs6s8b8rcnkEu2ZRbUBiYN1HMBT-21tC3D43Cbq2nI";

    private const string TestPublicKeySpki =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE_8jc_77lmAKGk91vyI_9AF4ImIcms1lgQU8QMBMoHtCwLOrPG_K3J5BLtmUW1AYmDdRzAU_ttbQtw-Nwm6tpyA";

    [Fact]
    public void Verify_GoldenFixtureAcceptsEveryLayerWithoutLeakingPrivateKey()
    {
        IntegrityProofVerificationBundle bundle = GoldenBundle();

        IntegrityProofVerificationReport report = IntegrityProofVerifier.Verify(bundle);

        Assert.True(report.Accepted, JsonSerializer.Serialize(report.Checks));
        Assert.Contains(report.Checks, static check => check.Name == "canonical-hash" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "artifact-digest" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "publish-proof-signature" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "transparency-log-chain" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "merkle-checkpoint-root" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "inclusion-proof" && check.Accepted);
        Assert.Contains(report.Checks, static check => check.Name == "public-key-registry" && check.Accepted);

        string serialized = JsonSerializer.Serialize(report);
        Assert.DoesNotContain(TestPrivateKeyPkcs8, serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE KEY", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", serialized, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("payload-tamper", "canonical-hash", "canonical-hash-mismatch")]
    [InlineData("signature-tamper", "publish-proof-signature", "payload-signature-invalid")]
    [InlineData("keyId-tamper", "publish-proof-signature", "unknown-key")]
    [InlineData("algorithm-mismatch", "publish-proof-signature", "algorithm-mismatch")]
    [InlineData("log-deletion", "transparency-log-chain", "seq-gap")]
    [InlineData("log-reorder", "transparency-log-chain", "seq-order")]
    [InlineData("checkpoint-tamper", "merkle-checkpoint-root", "checkpoint-root-mismatch")]
    public void Verify_TamperMatrixRejectsEveryMutation(string tamperCase, string expectedCheck, string expectedCode)
    {
        IntegrityProofVerificationBundle tampered = Tamper(GoldenBundle(), tamperCase);

        IntegrityProofVerificationReport report = IntegrityProofVerifier.Verify(tampered);

        Assert.False(report.Accepted);
        Assert.Contains(
            report.Checks,
            check => check.Name == expectedCheck && !check.Accepted && check.Code == expectedCode);
    }

    [Fact]
    public void SchemaMigrations_CoverIntegrityProofLogAndCheckpointTables()
    {
        var registry = new SchemaMigrationRegistry();
        string fingerprints = string.Join(
            '\n',
            registry.GetDescriptors()
                .Where(static descriptor => descriptor.MigrationId.Contains("integrity", StringComparison.Ordinal)
                    || descriptor.MigrationId.Contains("article-publish-proof", StringComparison.Ordinal))
                .SelectMany(static descriptor => descriptor.Steps)
                .Select(static step => step.Fingerprint));

        Assert.Contains("CREATE TABLE IF NOT EXISTS article_publish_proof", fingerprints, StringComparison.Ordinal);
        Assert.Contains("ux_article_publish_proof_idempotency", fingerprints, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS integrity_transparency_log", fingerprints, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_transparency_log_seq", fingerprints, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_transparency_log_entry_hash", fingerprints, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS integrity_merkle_checkpoint", fingerprints, StringComparison.Ordinal);
        Assert.Contains("ux_integrity_merkle_checkpoint_kind_scope", fingerprints, StringComparison.Ordinal);
        Assert.Contains("idx_integrity_merkle_checkpoint_log_head", fingerprints, StringComparison.Ordinal);
    }

    private static IntegrityProofVerificationBundle GoldenBundle()
    {
        DateTimeOffset issuedAt = DateTimeOffset.Parse("2026-07-04T08:00:00Z");
        ArticleCanonicalInput article = Article();
        ArtifactDigestEntry aot = ArtifactDigestV1.ComputeUtf8(
            ArtifactDigestKind.PublicAotShell,
            "public-aot:Article:article:910002",
            "<article>AEDS And Public AOT Notes</article>");
        ArtifactDigestEntry detail = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.ArticleDetailAeds,
            "article-detail-aeds:910002",
            [0x41, 0x45, 0x44, 0x53, 0x02, 0x10, 0x01]);
        ArtifactDigestEntry hotRead = ArtifactDigestV1.ComputeBytes(
            ArtifactDigestKind.PublicHotRead,
            "public-hot-read:article:910002",
            [0x50, 0x48, 0x52, 0x01, 0x00, 0x00, 0x00, 0x2A]);
        ArtifactDigestEntry assets = ArtifactDigestV1.ComputePublicAssetManifest(
            "article:910002",
            [
                ArtifactDigestV1.ComputeBytes(ArtifactDigestKind.PublicAsset, "asset:/uploads/cover.png", [1, 2, 3])
            ]);
        ArtifactDigestEntry feed = ArtifactDigestV1.ComputeUtf8(
            ArtifactDigestKind.RssFeed,
            "/feed/rss.xml",
            "<rss><channel><title>Fsu</title></channel></rss>");

        var proof = new PublishProofInput(
            ProofVersion: PublishProofCanonicalPayloadV1.ProofVersion,
            ArticleId: 910002,
            ArticleRevisionId: 930002,
            RevisionNo: 4,
            CanonicalHash: ArticleCanonicalHashV1.ComputeHashHex(article),
            AotHash: aot.Sha256Hex!,
            ArticleDetailAedsHash: detail.Sha256Hex!,
            PublicHotReadHash: hotRead.Sha256Hex!,
            AssetManifestHash: assets.Sha256Hex!,
            FeedHash: feed.Sha256Hex!,
            PublishedAtUtc: issuedAt,
            ProofStatus: PublishProofStatus.Ready,
            PublicationState: PublishProofPublicationState.Public);

        SiteSigningKeyRecord privateKey = TestKey();
        var signer = new SiteIntegritySigningService(SiteSigningKeyRegistry.Create([privateKey], privateKey.KeyId));
        SiteIntegritySignature signature = signer.Sign(PublishProofCanonicalPayloadV1.BuildSigningPayload(proof));
        TransparencyLogEntryRecord first = LogEntry(
            seq: 1,
            proofId: 7001,
            previousHash: null,
            payload: PublishProofCanonicalPayloadV1.BuildRecordPayloadUtf8(proof),
            signature);
        TransparencyLogEntryRecord second = LogEntry(
            seq: 2,
            proofId: 7002,
            previousHash: first.EntryHash,
            payload: "second deterministic publish proof payload",
            signature);
        MerkleCheckpointBuildResult checkpoint = MerkleCheckpointBuilder.Build(ToLeaves([first, second]));
        MerkleCheckpointManifest manifest = MerkleCheckpointManifest.Create(
            MerkleCheckpointKinds.Release,
            "release-2026.07.04-integrity",
            checkpoint,
            logHeadSeq: second.Seq,
            logHeadHash: second.EntryHash,
            issuedAt);

        return new IntegrityProofVerificationBundle(
            Article: article,
            Proof: proof,
            Artifacts: [aot, detail, hotRead, assets, feed],
            PublishProofSignature: signature,
            PublicKeyRegistry: SiteSigningKeyRegistry.Create([privateKey.WithoutPrivateKey()], privateKey.KeyId),
            TransparencyLog: [first, second],
            Checkpoint: manifest,
            CheckpointLeaves: ToLeaves([first, second]),
            InclusionProofs:
            [
                MerkleCheckpointBuilder.BuildInclusionProof(checkpoint, first.Seq),
                MerkleCheckpointBuilder.BuildInclusionProof(checkpoint, second.Seq)
            ]);
    }

    private static IntegrityProofVerificationBundle Tamper(IntegrityProofVerificationBundle bundle, string tamperCase)
        => tamperCase switch
        {
            "payload-tamper" => bundle with { Article = bundle.Article with { Title = "tampered title" } },
            "signature-tamper" => bundle with
            {
                PublishProofSignature = bundle.PublishProofSignature with
                {
                    SignatureBase64Url = Base64UrlTextEncoder.Encode(new byte[64])
                }
            },
            "keyId-tamper" => bundle with
            {
                PublishProofSignature = bundle.PublishProofSignature with
                {
                    KeyId = "missing-key"
                }
            },
            "algorithm-mismatch" => bundle with
            {
                PublishProofSignature = bundle.PublishProofSignature with
                {
                    Algorithm = "RSA_PSS_SHA256"
                }
            },
            "log-deletion" => bundle with { TransparencyLog = bundle.TransparencyLog.Skip(1).ToArray() },
            "log-reorder" => bundle with { TransparencyLog = bundle.TransparencyLog.Reverse().ToArray() },
            "checkpoint-tamper" => bundle with { Checkpoint = bundle.Checkpoint with { RootHash = Hash("tampered-root") } },
            _ => throw new ArgumentOutOfRangeException(nameof(tamperCase), tamperCase, null)
        };

    private static SiteSigningKeyRecord TestKey()
        => new(
            KeyId: "fixture-key-v1",
            Version: 1,
            Algorithm: SiteSigningKeyRecord.EcdsaP256Sha256,
            NotBeforeUtc: DateTimeOffset.Parse("2026-07-01T00:00:00Z"),
            NotAfterUtc: DateTimeOffset.Parse("2026-08-01T00:00:00Z"),
            RevokedAtUtc: null,
            CompromisedAtUtc: null,
            PublicKeySubjectPublicKeyInfoBase64Url: TestPublicKeySpki,
            PrivateKeyPkcs8Base64Url: TestPrivateKeyPkcs8);

    private static ArticleCanonicalInput Article()
        => new(
            ArticleId: 910002,
            ArticleRevisionId: 930002,
            RevisionNo: 4,
            PublicRouteKey: "article:910002",
            Title: "AEDS And Public AOT Notes",
            Summary: "A deterministic integrity proof fixture.",
            CoverImageUrl: "/uploads/aeds-public-aot.png",
            CategoryId: 6,
            TagIds: [3, 8],
            Status: 2,
            PublishedAt: new DateTime(2026, 7, 4, 8, 0, 0, DateTimeKind.Utc),
            ScheduledPublishAt: null,
            MarkdownContent: "# AEDS And Public AOT Notes\n\nFixture body.\n");

    private static TransparencyLogEntryRecord LogEntry(
        long seq,
        long proofId,
        string? previousHash,
        string payload,
        SiteIntegritySignature signature)
    {
        var input = new TransparencyLogEntryInput(
            Seq: seq,
            EntryType: TransparencyLogEntryTypes.PublishProof,
            ProofId: proofId,
            ArticleId: 910002,
            ArticleRevisionId: 930002,
            RevisionNo: 4,
            EntryPayloadHash: TransparencyLogPayloadHasher.ComputeUtf8HashHex(TransparencyLogEntryTypes.PublishProof, payload),
            PrevEntryHash: previousHash ?? TransparencyLogEntryCanonicalizer.GenesisPreviousHash,
            CreatedAtUtc: DateTimeOffset.Parse("2026-07-04T08:00:00Z").AddMinutes(seq),
            SigningKeyId: signature.KeyId,
            SignatureBase64Url: signature.SignatureBase64Url);
        return input.ToRecord(TransparencyLogEntryCanonicalizer.ComputeEntryHashHex(input));
    }

    private static IReadOnlyList<MerkleLeafInput> ToLeaves(IEnumerable<TransparencyLogEntryRecord> entries)
        => entries.Select(static entry => new MerkleLeafInput(
            entry.Seq,
            entry.EntryHash,
            entry.ProofId,
            entry.ArticleId,
            entry.ArticleRevisionId,
            entry.RevisionNo)).ToArray();

    private static string Hash(string value)
        => TransparencyLogPayloadHasher.ComputeUtf8HashHex("test", value);
}
