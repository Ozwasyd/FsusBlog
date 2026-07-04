using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityVerificationManifestTests
{
    [Fact]
    public void ReadyProofManifest_GoldenSchemaExposesOnlyPublicVerificationFields()
    {
        IntegrityProofManifestResponse manifest = IntegrityProofManifestResponse.FromProof(ReadyProof());

        string json = JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options);

        Assert.Equal(
            """
            {"manifestVersion":1,"kind":"article-publish-proof","status":"ready","proofVersion":1,"hashAlgorithm":"sha256","articleId":910002,"articleRevisionId":810002,"revisionNo":3,"canonicalHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","artifactDigests":{"aot":"sha256:2222222222222222222222222222222222222222222222222222222222222222","articleDetailAeds":"sha256:3333333333333333333333333333333333333333333333333333333333333333","publicHotRead":"sha256:4444444444444444444444444444444444444444444444444444444444444444","assetManifest":"sha256:5555555555555555555555555555555555555555555555555555555555555555","feed":"sha256:6666666666666666666666666666666666666666666666666666666666666666"},"signature":{"payloadVersion":1,"keyId":"site-key-1","keyVersion":2,"algorithm":"ecdsa-p256-sha256","value":"sig-ready"},"transparencyLog":{"entryId":27,"entryHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
            """,
            json);
        AssertPublicJsonDoesNotLeakPrivateFields(json);
    }

    [Fact]
    public void NonReadyProofManifest_OnlyExposesLowSensitivityStatus()
    {
        ArticlePublishProof failed = ReadyProof();
        failed.ProofStatus = "failed";
        failed.FailureCode = "signer_error";
        failed.FailureDetail = "System.InvalidOperationException: private_key leaked stack trace token=secret";

        IntegrityProofManifestResponse manifest = IntegrityProofManifestResponse.FromProof(failed);

        string json = JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options);

        Assert.Equal("failed", manifest.Status);
        Assert.Null(manifest.CanonicalHash);
        Assert.Null(manifest.ArtifactDigests);
        Assert.Null(manifest.Signature);
        Assert.Null(manifest.TransparencyLog);
        Assert.Contains("\"status\":\"failed\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("signer_error", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("InvalidOperationException", json, StringComparison.OrdinalIgnoreCase);
        AssertPublicJsonDoesNotLeakPrivateFields(json);
    }

    [Fact]
    public void KeysManifest_PublishesOnlyPublicKeyMaterial()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["IntegrityProof:Signing:Enabled"] = "true",
                ["IntegrityProof:Signing:CurrentKeyId"] = "site-key-1",
                ["IntegrityProof:Signing:Keys:site-key-1:Algorithm"] = "ecdsa-p256-sha256",
                ["IntegrityProof:Signing:Keys:site-key-1:Version"] = "2",
                ["IntegrityProof:Signing:Keys:site-key-1:PublicKey"] = "PUBLIC-SPKI-BASE64URL",
                ["IntegrityProof:Signing:Keys:site-key-1:PrivateKey"] = "PRIVATE-PKCS8-BASE64URL"
            })
            .Build();

        IntegrityKeysManifestResponse manifest = IntegrityKeysManifestResponse.FromConfiguration(configuration);

        string json = JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options);

        Assert.Equal("site-key-1", manifest.CurrentKeyId);
        Assert.Contains("PUBLIC-SPKI-BASE64URL", json, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE-PKCS8-BASE64URL", json, StringComparison.Ordinal);
        AssertPublicJsonDoesNotLeakPrivateFields(json);
    }

    [Fact]
    public void CheckpointAndLogHeadManifest_ExposeStableVerificationPointers()
    {
        IntegrityCheckpointManifestResponse checkpoint = IntegrityCheckpointManifestResponse.FromEntity(Checkpoint());
        IntegrityLogHeadManifestResponse head = IntegrityLogHeadManifestResponse.FromEntity(LogHead());

        Assert.Equal("daily", checkpoint.CheckpointKind);
        Assert.Equal("2026-07-04", checkpoint.ScopeKey);
        Assert.Equal(1, checkpoint.FromSeq);
        Assert.Equal(3, checkpoint.ToSeq);
        Assert.Equal("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", checkpoint.RootHash);
        Assert.Equal(3, head.Seq);
        Assert.Equal("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", head.EntryHash);
        AssertPublicJsonDoesNotLeakPrivateFields(JsonSerializer.Serialize(checkpoint, IntegrityVerificationJson.Options));
        AssertPublicJsonDoesNotLeakPrivateFields(JsonSerializer.Serialize(head, IntegrityVerificationJson.Options));
    }

    [Fact]
    public void PublicEndpointContract_IsAnonymousJsonSidecarOutsideAedsBinaryPath()
    {
        string endpoints = ReadRepoFile("src/backend/Modules/Endpoints/IntegrityVerificationEndpoints.cs");
        string manifests = ReadRepoFile("src/backend/Infrastructure/Integrity/IntegrityVerificationManifest.cs");
        string composition = ReadRepoFile("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs");
        string services = ReadRepoFile("src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs");

        foreach (string route in new[]
        {
            "/integrity/keys.json",
            "/integrity/article/{articleId:int}",
            "/integrity/article/{articleId:int}/revisions/{revisionNo:int}",
            "/integrity/article/{articleId:int}/rights",
            "/integrity/article/{articleId:int}/revisions/{revisionNo:int}/rights",
            "/integrity/revisions/{articleRevisionId:long}",
            "/integrity/checkpoints/latest",
            "/integrity/checkpoints/{date}",
            "/integrity/log/head"
        })
        {
            Assert.Contains($"MapGet(\"{route}\"", endpoints, StringComparison.Ordinal);
        }

        Assert.Contains(".AllowAnonymous()", endpoints, StringComparison.Ordinal);
        Assert.Contains("application/json; charset=utf-8", endpoints, StringComparison.Ordinal);
        Assert.Contains("IntegrityVerificationCacheHeaders.ImmutableProof", manifests, StringComparison.Ordinal);
        Assert.Contains("IntegrityVerificationCacheHeaders.NoStore", endpoints + manifests, StringComparison.Ordinal);
        Assert.Contains("IntegrityVerificationCacheHeaders.PublicManifest", manifests, StringComparison.Ordinal);
        Assert.DoesNotContain("/api/binary", endpoints, StringComparison.Ordinal);
        Assert.Contains("app.MapIntegrityVerificationEndpoints();", composition, StringComparison.Ordinal);
        Assert.Contains("AddScoped<IIntegrityVerificationManifestService, IntegrityVerificationManifestService>", services, StringComparison.Ordinal);
    }

    [Fact]
    public void Documentation_RegistersPublicVerificationApiAndManualSignatureCheck()
    {
        string publicVerification = ReadRepoFile("docs/integrity/public-verification-api.md");
        string contracts = ReadRepoFile("docs/api/contracts.md");
        string quickReference = ReadRepoFile("docs/api/quick-reference.md");

        Assert.Contains("/integrity/keys.json", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}/revisions/{revisionNo}", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}/rights", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}/revisions/{revisionNo}/rights", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/revisions/{articleRevisionId}", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/checkpoints/latest", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/log/head", publicVerification, StringComparison.Ordinal);
        Assert.Contains("articleRevisionId", publicVerification, StringComparison.Ordinal);
        Assert.Contains("revisionNo", publicVerification, StringComparison.Ordinal);
        Assert.Contains("AEDS", publicVerification, StringComparison.Ordinal);
        Assert.Contains("openssl dgst -sha256 -verify", publicVerification, StringComparison.Ordinal);
        Assert.DoesNotContain("revisionId", publicVerification, StringComparison.Ordinal);
        Assert.Contains("/integrity/keys.json", contracts, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}/rights", contracts, StringComparison.Ordinal);
        Assert.Contains("/integrity/article/{articleId}/revisions/{revisionNo}/rights", contracts, StringComparison.Ordinal);
        Assert.Contains("/integrity/checkpoints/latest", quickReference, StringComparison.Ordinal);
    }

    private static ArticlePublishProof ReadyProof()
        => new()
        {
            ProofVersion = 1,
            SignaturePayloadVersion = 1,
            ArticleId = 910002,
            ArticleRevisionId = 810002,
            RevisionNo = 3,
            CanonicalHash = new string('1', 64),
            AotHash = new string('2', 64),
            ArticleDetailAedsHash = new string('3', 64),
            PublicHotReadHash = new string('4', 64),
            AssetManifestHash = new string('5', 64),
            FeedHash = new string('6', 64),
            PublishedAt = new DateTime(2026, 7, 4, 10, 11, 12, DateTimeKind.Utc),
            ProofStatus = "ready",
            SigningKeyId = "site-key-1",
            SigningKeyVersion = 2,
            SigningAlgorithm = "ecdsa-p256-sha256",
            SignatureBase64Url = "sig-ready",
            TransparencyLogEntryId = 27,
            TransparencyLogEntryHash = new string('a', 64)
        };

    private static IntegrityMerkleCheckpoint Checkpoint()
        => new()
        {
            CheckpointKind = "daily",
            ScopeKey = "2026-07-04",
            FromSeq = 1,
            ToSeq = 3,
            EntryCount = 3,
            RootHash = new string('d', 64),
            LogHeadSeq = 3,
            LogHeadHash = new string('c', 64),
            ManifestHash = new string('e', 64),
            ManifestJson = "{}",
            SigningKeyId = "site-key-1",
            SigningAlgorithm = "ecdsa-p256-sha256",
            SignatureBase64Url = "sig-checkpoint",
            CreatedAt = new DateTime(2026, 7, 4, 12, 0, 0, DateTimeKind.Utc)
        };

    private static IntegrityTransparencyLogEntry LogHead()
        => new()
        {
            Seq = 3,
            EntryType = "publish-proof",
            ProofId = 27,
            ArticleId = 910002,
            ArticleRevisionId = 810002,
            RevisionNo = 3,
            EntryPayloadHash = new string('b', 64),
            PrevEntryHash = new string('a', 64),
            EntryHash = new string('c', 64),
            CreatedAt = new DateTime(2026, 7, 4, 12, 0, 0, DateTimeKind.Utc),
            SigningKeyId = "site-key-1",
            SignatureBase64Url = "sig-log-head"
        };

    private static void AssertPublicJsonDoesNotLeakPrivateFields(string json)
    {
        foreach (string forbidden in new[]
        {
            "privateKey",
            "PrivateKey",
            "CreatedByAdminPrincipalId",
            "adminPrincipal",
            "failureDetail",
            "stack",
            "session",
            "token",
            "ipAddress",
            "deviceFingerprint"
        })
        {
            Assert.DoesNotContain(forbidden, json, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static string ReadRepoFile(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);
}
