using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
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
