using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class IntegrityVerificationManifestServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task GetCurrentArticleProofAsync_PublicReadyProofReturnsImmutableVerificationPayload()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910002, ArticleStatus.Published);
        await SeedProofAsync(db, ReadyProof(articleId: 910002, revisionId: 810002, revisionNo: 3, status: "ready"));
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetCurrentArticleProofAsync(910002, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, result.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.ImmutableProof, result.CacheControl);
        IntegrityProofManifestResponse manifest = Assert.IsType<IntegrityProofManifestResponse>(result.Body);
        Assert.Equal("ready", manifest.Status);
        Assert.Equal("sha256:1111111111111111111111111111111111111111111111111111111111111111", manifest.CanonicalHash);
        Assert.NotNull(manifest.Signature);
        Assert.NotNull(manifest.TransparencyLog);
        AssertPublicPayloadDoesNotLeak(JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options));
    }

    [Fact]
    public async Task GetCurrentArticleRightsProofAsync_PublicReadyProofReturnsSafeRightsManifest()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910012, ArticleStatus.Published);
        await SeedRightsSnapshotAsync(db, RightsSnapshot(articleId: 910012, revisionId: 810012, revisionNo: 2, snapshotId: 710012));
        await SeedRightsProofAsync(db, ReadyRightsProof(articleId: 910012, revisionId: 810012, revisionNo: 2, snapshotId: 710012, status: "ready"));
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetCurrentArticleRightsProofAsync(910012, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, result.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.ImmutableProof, result.CacheControl);
        ArticleRightsProofManifestResponse manifest = Assert.IsType<ArticleRightsProofManifestResponse>(result.Body);
        Assert.Equal("article-rights-proof", manifest.Kind);
        Assert.Equal("ready", manifest.Status);
        Assert.Equal(910012, manifest.ArticleId);
        Assert.Equal(810012, manifest.ArticleRevisionId);
        Assert.Equal(2, manifest.RevisionNo);
        Assert.Equal(710012, manifest.ArticleRightsSnapshotId);
        Assert.Equal(610012, manifest.PublishProofId);
        Assert.Equal("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", manifest.RightsPolicyHash);
        Assert.Equal("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", manifest.ContentCanonicalHash);
        Assert.NotNull(manifest.Signature);
        Assert.NotNull(manifest.TransparencyLog);
        AssertPublicPayloadDoesNotLeak(JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options));
    }

    [Fact]
    public async Task GetArticleRevisionRightsProofAsync_SupersededRevisionRemainsVerifiable()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910013, ArticleStatus.Published);
        await SeedRightsSnapshotAsync(db, RightsSnapshot(articleId: 910013, revisionId: 810013, revisionNo: 1, snapshotId: 710013));
        await SeedRightsSnapshotAsync(db, RightsSnapshot(articleId: 910013, revisionId: 810014, revisionNo: 2, snapshotId: 710014));
        await SeedRightsProofAsync(db, ReadyRightsProof(articleId: 910013, revisionId: 810013, revisionNo: 1, snapshotId: 710013, status: "superseded"));
        await SeedRightsProofAsync(db, ReadyRightsProof(articleId: 910013, revisionId: 810014, revisionNo: 2, snapshotId: 710014, status: "ready"));
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetArticleRevisionRightsProofAsync(910013, revisionNo: 1, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, result.StatusCode);
        ArticleRightsProofManifestResponse manifest = Assert.IsType<ArticleRightsProofManifestResponse>(result.Body);
        Assert.Equal("superseded", manifest.Status);
        Assert.Equal(1, manifest.RevisionNo);
        Assert.Equal(810013, manifest.ArticleRevisionId);
    }

    [Fact]
    public async Task GetCurrentArticleRightsProofAsync_DraftArticleReturnsStableNotPublicError()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910014, ArticleStatus.Draft);
        await SeedRightsSnapshotAsync(db, RightsSnapshot(articleId: 910014, revisionId: 810015, revisionNo: 1, snapshotId: 710015));
        await SeedRightsProofAsync(db, ReadyRightsProof(articleId: 910014, revisionId: 810015, revisionNo: 1, snapshotId: 710015, status: "ready"));
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetCurrentArticleRightsProofAsync(910014, CancellationToken.None);

        Assert.Equal(StatusCodes.Status404NotFound, result.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.NoStore, result.CacheControl);
        IntegrityPublicErrorResponse error = Assert.IsType<IntegrityPublicErrorResponse>(result.Body);
        Assert.Equal("integrity_manifest_not_public", error.Code);
        string json = JsonSerializer.Serialize(error, IntegrityVerificationJson.Options);
        Assert.DoesNotContain("rightsPolicyHash", json, StringComparison.OrdinalIgnoreCase);
        AssertPublicPayloadDoesNotLeak(json);
    }

    [Fact]
    public async Task GetCurrentArticleProofAsync_PublicFailedProofReturnsOnlyLowSensitivityStatus()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910003, ArticleStatus.Published);
        ArticlePublishProof proof = ReadyProof(articleId: 910003, revisionId: 810003, revisionNo: 1, status: "failed");
        proof.FailureCode = "signer_private_key_error";
        proof.FailureDetail = "System.Exception: stack trace token=secret";
        await SeedProofAsync(db, proof);
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetCurrentArticleProofAsync(910003, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, result.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.NoStore, result.CacheControl);
        IntegrityProofManifestResponse manifest = Assert.IsType<IntegrityProofManifestResponse>(result.Body);
        Assert.Equal("failed", manifest.Status);
        Assert.Null(manifest.CanonicalHash);
        Assert.Null(manifest.ArtifactDigests);
        Assert.Null(manifest.Signature);
        Assert.Null(manifest.TransparencyLog);
        AssertPublicPayloadDoesNotLeak(JsonSerializer.Serialize(manifest, IntegrityVerificationJson.Options));
    }

    [Fact]
    public async Task GetCurrentArticleProofAsync_DraftArticleReturnsStableNotPublicErrorWithoutProofPayload()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 910004, ArticleStatus.Draft);
        await SeedProofAsync(db, ReadyProof(articleId: 910004, revisionId: 810004, revisionNo: 1, status: "ready"));
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult result = await service.GetCurrentArticleProofAsync(910004, CancellationToken.None);

        Assert.Equal(StatusCodes.Status404NotFound, result.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.NoStore, result.CacheControl);
        IntegrityPublicErrorResponse error = Assert.IsType<IntegrityPublicErrorResponse>(result.Body);
        Assert.Equal("integrity_manifest_not_public", error.Code);
        string json = JsonSerializer.Serialize(error, IntegrityVerificationJson.Options);
        Assert.DoesNotContain("canonicalHash", json, StringComparison.OrdinalIgnoreCase);
        AssertPublicPayloadDoesNotLeak(json);
    }

    [Fact]
    public async Task PublicManifestLookups_ReturnStableNoStoreMissingErrors()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        IIntegrityVerificationManifestService service = CreateService(db);

        IntegrityManifestResult revision = await service.GetRevisionProofAsync(404, CancellationToken.None);
        IntegrityManifestResult checkpoint = await service.GetLatestCheckpointAsync(CancellationToken.None);

        Assert.Equal(StatusCodes.Status404NotFound, revision.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.NoStore, revision.CacheControl);
        Assert.Equal("integrity_manifest_not_found", Assert.IsType<IntegrityPublicErrorResponse>(revision.Body).Code);
        Assert.Equal(StatusCodes.Status404NotFound, checkpoint.StatusCode);
        Assert.Equal(IntegrityVerificationCacheHeaders.NoStore, checkpoint.CacheControl);
        Assert.Equal("integrity_manifest_not_found", Assert.IsType<IntegrityPublicErrorResponse>(checkpoint.Body).Code);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        return PostgresSqlSugarTestClient.Create(connectionString);
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(Article),
            typeof(ArticleRightsPolicy),
            typeof(ArticleRightsSnapshot),
            typeof(ArticleRightsProof),
            typeof(ArticlePublishProof),
            typeof(IntegrityMerkleCheckpoint),
            typeof(IntegrityTransparencyLogEntry));

    private static void SeedArticle(SqlSugarClient db, int articleId, ArticleStatus status)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, @Title, 1, 0, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Title", $"Article {articleId}"),
            new SugarParameter("@Status", (int)status),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-5)));

    private static Task<int> SeedProofAsync(SqlSugarClient db, ArticlePublishProof proof)
        => db.Insertable(proof).ExecuteCommandAsync();

    private static Task<int> SeedRightsSnapshotAsync(SqlSugarClient db, ArticleRightsSnapshot snapshot)
        => db.Insertable(snapshot).ExecuteCommandAsync();

    private static Task<int> SeedRightsProofAsync(SqlSugarClient db, ArticleRightsProof proof)
        => db.Insertable(proof).ExecuteCommandAsync();

    private static ArticlePublishProof ReadyProof(int articleId, long revisionId, int revisionNo, string status)
        => new()
        {
            ProofVersion = 1,
            SignaturePayloadVersion = 1,
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            IdempotencyKey = $"article:{articleId}:rev:{revisionNo}",
            CanonicalHash = new string('1', 64),
            AotHash = new string('2', 64),
            ArticleDetailAedsHash = new string('3', 64),
            PublicHotReadHash = new string('4', 64),
            AssetManifestHash = new string('5', 64),
            FeedHash = new string('6', 64),
            PublishedAt = DateTime.UtcNow.AddMinutes(-4),
            ProofStatus = status,
            SigningKeyId = "site-key-1",
            SigningKeyVersion = 2,
            SigningAlgorithm = "ecdsa-p256-sha256",
            SignatureBase64Url = "sig-ready",
            TransparencyLogEntryId = 27,
            TransparencyLogEntryHash = new string('a', 64),
            CreatedAt = DateTime.UtcNow.AddMinutes(-4),
            UpdatedAt = DateTime.UtcNow.AddMinutes(-4)
        };

    private static ArticleRightsSnapshot RightsSnapshot(int articleId, long revisionId, int revisionNo, long snapshotId)
        => new()
        {
            Id = snapshotId,
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            ArticleRightsPolicyId = snapshotId - 100,
            Enabled = true,
            LicenseType = "all-rights-reserved",
            CopyPolicy = "append-attribution",
            MaxExcerptChars = 300,
            AllowCodeCopy = true,
            ShowPublicBadge = true,
            ProofBindingEnabled = true,
            CanonicalUrl = $"https://example.test/articles/{articleId}",
            PolicyHash = new string('a', 64),
            ContentCanonicalHash = new string('b', 64),
            CreatedAt = DateTime.UtcNow.AddMinutes(-4)
        };

    private static ArticleRightsProof ReadyRightsProof(int articleId, long revisionId, int revisionNo, long snapshotId, string status)
        => new()
        {
            ProofVersion = 1,
            SignaturePayloadVersion = 1,
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            ArticleRightsSnapshotId = snapshotId,
            PublishProofId = articleId - 300000,
            IdempotencyKey = $"article:{articleId}:revision:{revisionId}:rights:1",
            RightsPolicyHash = new string('a', 64),
            ContentCanonicalHash = new string('b', 64),
            ProofStatus = status,
            SigningKeyId = "site-key-1",
            SigningKeyVersion = 2,
            SigningAlgorithm = "ecdsa-p256-sha256",
            SignatureBase64Url = "sig-rights-ready",
            TransparencyLogEntryId = articleId - 900000,
            TransparencyLogEntryHash = new string('c', 64),
            CreatedAt = DateTime.UtcNow.AddMinutes(-4),
            UpdatedAt = DateTime.UtcNow.AddMinutes(-4)
        };

    private static IIntegrityVerificationManifestService CreateService(SqlSugarClient db)
        => new IntegrityVerificationManifestService(db, CreateConfiguration());

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["IntegrityProof:Signing:CurrentKeyId"] = "site-key-1",
                ["IntegrityProof:Signing:Keys:site-key-1:Algorithm"] = "ecdsa-p256-sha256",
                ["IntegrityProof:Signing:Keys:site-key-1:Version"] = "2",
                ["IntegrityProof:Signing:Keys:site-key-1:PublicKey"] = "PUBLIC-SPKI-BASE64URL",
                ["IntegrityProof:Signing:Keys:site-key-1:PrivateKey"] = "PRIVATE-PKCS8-BASE64URL"
            })
            .Build();

    private static void AssertPublicPayloadDoesNotLeak(string json)
    {
        foreach (string forbidden in new[]
        {
            "privateKey",
            "PRIVATE-PKCS8",
            "failureDetail",
            "signer_private_key_error",
            "stack trace",
            "token=secret",
            "CreatedByAdminPrincipalId",
            "adminPrincipal",
            "session",
            "ipAddress",
            "deviceFingerprint"
        })
        {
            Assert.DoesNotContain(forbidden, json, StringComparison.OrdinalIgnoreCase);
        }
    }
}
