using System.Text.Json;

using Microsoft.Extensions.Configuration;
using SqlSugar;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class IntegrityAdminConsoleServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task GetConsoleAsync_SanitizesFailedProofAndReportsOperationalStatuses()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        SiteSigningKeyRecord activeKey = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-key-active",
            1,
            DateTimeOffset.UtcNow.AddHours(-1));
        SiteSigningKeyRecord revokedKey = SiteSigningKeyRecord.CreateEcdsaP256(
            "site-key-revoked",
            2,
            DateTimeOffset.UtcNow.AddHours(-2),
            revokedAtUtc: DateTimeOffset.UtcNow.AddMinutes(-30));
        ArticlePublishProof failedProof = Proof(articleId: 910002, revisionId: 810002, revisionNo: 1, status: "failed");
        failedProof.FailureCode = "signer_private_key_error";
        failedProof.FailureDetail = "System.Exception: stack token=secret PRIVATE-PKCS8";
        failedProof.SignatureBase64Url = null;
        await SeedProofAsync(db, failedProof);
        ArticlePublishProof invalidSignatureProof = Proof(articleId: 910002, revisionId: 810002, revisionNo: 2, status: "ready");
        invalidSignatureProof.SigningKeyId = activeKey.KeyId;
        invalidSignatureProof.SignatureBase64Url = "not-valid-base64";
        await SeedProofAsync(db, invalidSignatureProof);
        await SeedLogAsync(db, Log(seq: 1, hash: new string('a', 64), prev: new string('0', 64)));
        await SeedLogAsync(db, Log(seq: 2, hash: new string('b', 64), prev: new string('c', 64)));
        IIntegrityAdminConsoleService service = CreateService(db, activeKey, revokedKey);

        IntegrityAdminConsoleResponse console = await service.GetConsoleAsync(
            new IntegrityAdminConsoleQuery(ArticleId: 910002, ArticleRevisionId: null, RevisionNo: null),
            CancellationToken.None);

        Assert.Equal("chain-broken", console.TransparencyLog.Status);
        Assert.Equal("missing", console.Checkpoint.Status);
        Assert.Contains(console.KeyRegistry.Keys, key => key.KeyId == activeKey.KeyId && key.Status == "active");
        Assert.Contains(console.KeyRegistry.Keys, key => key.KeyId == revokedKey.KeyId && key.Status == "revoked");
        Assert.Contains(console.RecentProofs, proof => proof.ProofStatus == "failed" && proof.RetryAvailable);
        Assert.Contains(console.RecentProofs, proof => proof.SignatureStatus == "signature-invalid");

        string json = JsonSerializer.Serialize(console, IntegrityVerificationJson.Options);
        Assert.DoesNotContain("FailureDetail", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("stack", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token=secret", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PRIVATE-PKCS8", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PrivateKey", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RetryProofAsync_ChangesFailedProofToRetryingAndClearsFailureSummary()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        CreateTables(db);
        ArticlePublishProof failedProof = Proof(articleId: 910003, revisionId: 810003, revisionNo: 1, status: "failed");
        failedProof.FailureCode = "artifact-hash-mismatch";
        failedProof.FailureDetail = "internal stack trace";
        long proofId = await SeedProofAsync(db, failedProof);
        IIntegrityAdminConsoleService service = CreateService(db);

        IntegrityAdminRetryResponse response = await service.RetryProofAsync(proofId, CancellationToken.None);

        Assert.Equal(proofId, response.ProofId);
        Assert.Equal("retrying", response.ProofStatus);
        ArticlePublishProof stored = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.Id == proofId)
            .FirstAsync();
        Assert.Equal("retrying", stored.ProofStatus);
        Assert.Null(stored.FailureCode);
        Assert.Null(stored.FailureDetail);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        return PostgresSqlSugarTestClient.Create(connectionString);
    }

    private static void CreateTables(SqlSugarClient db)
        => PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticlePublishProof),
            typeof(IntegrityMerkleCheckpoint),
            typeof(IntegrityTransparencyLogEntry));

    private static async Task<long> SeedProofAsync(SqlSugarClient db, ArticlePublishProof proof)
    {
        await db.Insertable(proof).ExecuteCommandAsync();
        return await db.Queryable<ArticlePublishProof>()
            .Where(item => item.IdempotencyKey == proof.IdempotencyKey)
            .Select(item => item.Id)
            .FirstAsync();
    }

    private static Task<int> SeedLogAsync(SqlSugarClient db, IntegrityTransparencyLogEntry entry)
        => db.Insertable(entry).ExecuteCommandAsync();

    private static ArticlePublishProof Proof(int articleId, long revisionId, int revisionNo, string status)
        => new()
        {
            ProofVersion = 1,
            SignaturePayloadVersion = 1,
            ArticleId = articleId,
            ArticleRevisionId = revisionId,
            RevisionNo = revisionNo,
            IdempotencyKey = $"article:{articleId}:rev:{revisionNo}:{status}",
            CanonicalHash = new string('1', 64),
            AotHash = new string('2', 64),
            ArticleDetailAedsHash = new string('3', 64),
            PublicHotReadHash = new string('4', 64),
            AssetManifestHash = new string('5', 64),
            FeedHash = new string('6', 64),
            PublishedAt = DateTime.UtcNow.AddMinutes(-revisionNo),
            ProofStatus = status,
            SigningKeyId = "site-key-active",
            SigningKeyVersion = 1,
            SigningAlgorithm = SiteSigningKeyRecord.EcdsaP256Sha256,
            SignatureBase64Url = "signature",
            CreatedAt = DateTime.UtcNow.AddMinutes(-revisionNo),
            UpdatedAt = DateTime.UtcNow.AddMinutes(-revisionNo)
        };

    private static IntegrityTransparencyLogEntry Log(long seq, string hash, string prev)
        => new()
        {
            Seq = seq,
            EntryType = "publish-proof",
            ProofId = seq,
            ArticleId = 910002,
            ArticleRevisionId = 810002,
            RevisionNo = (int)seq,
            EntryPayloadHash = new string('d', 64),
            PrevEntryHash = prev,
            EntryHash = hash,
            CreatedAt = DateTime.UtcNow.AddMinutes(-(int)seq),
            SigningKeyId = "site-key-active",
            SignatureBase64Url = "signature"
        };

    private static IIntegrityAdminConsoleService CreateService(
        SqlSugarClient db,
        params SiteSigningKeyRecord[] keys)
    {
        SiteSigningKeyRecord[] configuredKeys = keys.Length > 0
            ? keys
            : [SiteSigningKeyRecord.CreateEcdsaP256("site-key-active", 1, DateTimeOffset.UtcNow.AddHours(-1))];
        return new IntegrityAdminConsoleService(db, CreateConfiguration(configuredKeys));
    }

    private static IConfiguration CreateConfiguration(IReadOnlyList<SiteSigningKeyRecord> keys)
    {
        var values = new Dictionary<string, string?>
        {
            ["IntegrityProof:Signing:Enabled"] = "true",
            ["IntegrityProof:Signing:CurrentKeyId"] = keys[0].KeyId
        };

        foreach (SiteSigningKeyRecord key in keys)
        {
            string prefix = $"IntegrityProof:Signing:Keys:{key.KeyId}";
            values[$"{prefix}:Algorithm"] = key.Algorithm;
            values[$"{prefix}:Version"] = key.Version.ToString(System.Globalization.CultureInfo.InvariantCulture);
            values[$"{prefix}:PublicKey"] = key.PublicKeySubjectPublicKeyInfoBase64Url;
            values[$"{prefix}:RevokedAtUtc"] = key.RevokedAtUtc?.ToString("O", System.Globalization.CultureInfo.InvariantCulture);
            values[$"{prefix}:CompromisedAtUtc"] = key.CompromisedAtUtc?.ToString("O", System.Globalization.CultureInfo.InvariantCulture);
        }

        return new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
    }
}
