using System.Reflection;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRightsProofModelTests
{
    [Fact]
    public void RecordPayload_GoldenFixtureBindsSnapshotContentPublishProofAndStatus()
    {
        ArticleRightsProofInput proof = ReadyProof();

        string payload = ArticleRightsProofCanonicalPayloadV1.BuildRecordPayloadUtf8(proof);
        string digest = ArticleRightsProofCanonicalPayloadV1.ComputeRecordDigestHex(proof);

        Assert.Equal(
            """
            fsusblog.integrity.article-rights-proof-record.v1
            proofVersion:i:1
            signaturePayloadVersion:i:1
            articleId:i:910002
            articleRevisionId:i:810002
            revisionNo:i:3
            articleRightsSnapshotId:i:710002
            publishProofId:i:610002
            rightsPolicyHash:h:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
            contentCanonicalHash:h:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
            issuedAt:t:2026-07-04T10:11:12.0000000Z
            proofStatus:s:ready

            """,
            payload);
        Assert.Equal("3580060020ac27a8aefeb1641cbdfb181e06815108191ac5007a8de2d20d68ed", digest);
    }

    [Fact]
    public void SigningPayload_UsesArticleRightsProofKindAndStableFields()
    {
        ArticleRightsProofInput proof = ReadyProof();

        SiteIntegritySigningPayload signingPayload = ArticleRightsProofCanonicalPayloadV1.BuildSigningPayload(proof);

        Assert.Equal("article-rights-proof", signingPayload.ProofKind);
        Assert.Equal("article:910002:revision:810002:rights:710002", signingPayload.Subject);
        Assert.Equal(ArticleRightsProofCanonicalPayloadV1.ComputeRecordDigestHex(proof), signingPayload.DigestSha256Hex);
        Assert.Equal("910002", signingPayload.Fields["articleId"]);
        Assert.Equal("810002", signingPayload.Fields["articleRevisionId"]);
        Assert.Equal("710002", signingPayload.Fields["articleRightsSnapshotId"]);
        Assert.Equal("610002", signingPayload.Fields["publishProofId"]);
        Assert.Equal("3", signingPayload.Fields["revisionNo"]);
        Assert.Equal("1", signingPayload.Fields["proofVersion"]);
        Assert.Equal("1", signingPayload.Fields["signaturePayloadVersion"]);
    }

    [Fact]
    public void IdempotencyKey_ReplayingSameRightsSnapshotIsStable()
    {
        ArticleRightsProofInput first = ReadyProof();
        ArticleRightsProofInput replay = ReadyProof() with
        {
            IssuedAtUtc = ReadyProof().IssuedAtUtc.AddMinutes(5),
            ContentCanonicalHash = new string('c', 64)
        };

        Assert.Equal(
            "article:910002:revision:810002:rights:1",
            ArticleRightsProofIdempotency.BuildKey(first.ArticleId, first.ArticleRevisionId, first.ProofVersion));
        Assert.Equal(
            ArticleRightsProofIdempotency.BuildKey(first.ArticleId, first.ArticleRevisionId, first.ProofVersion),
            ArticleRightsProofIdempotency.BuildKey(replay.ArticleId, replay.ArticleRevisionId, replay.ProofVersion));
    }

    [Fact]
    public void Readiness_RequiresPublicArticleReadySnapshotContentHashAndPublishProof()
    {
        ArticleRightsProofReadiness ready = ArticleRightsProofReadiness.Evaluate(
            ReadyProof(),
            rightsSnapshotAvailable: true,
            contentHashReady: true,
            publishProofReady: true);
        ArticleRightsProofReadiness missingSnapshot = ArticleRightsProofReadiness.Evaluate(
            ReadyProof(),
            rightsSnapshotAvailable: false,
            contentHashReady: true,
            publishProofReady: true);
        ArticleRightsProofReadiness publishProofPending = ArticleRightsProofReadiness.Evaluate(
            ReadyProof(),
            rightsSnapshotAvailable: true,
            contentHashReady: true,
            publishProofReady: false);
        ArticleRightsProofReadiness archived = ArticleRightsProofReadiness.Evaluate(
            ReadyProof() with
            {
                PublicationState = PublishProofPublicationState.Archived
            },
            rightsSnapshotAvailable: true,
            contentHashReady: true,
            publishProofReady: true);

        Assert.Equal(PublishProofStatus.Ready, ready.Status);
        Assert.Equal(PublishProofStatus.Pending, missingSnapshot.Status);
        Assert.Equal("rights-snapshot-missing", missingSnapshot.Reason);
        Assert.Equal(PublishProofStatus.Pending, publishProofPending.Status);
        Assert.Equal("publish-proof-pending", publishProofPending.Reason);
        Assert.Equal(PublishProofStatus.NotPublic, archived.Status);
        Assert.Equal("article-not-public", archived.Reason);
    }

    [Fact]
    public void EntityAndMigrationPersistRightsProofWithoutPrivateRequestContext()
    {
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-article-rights-v3-schema");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(
            "article_rights_proof",
            typeof(ArticleRightsProof).GetCustomAttribute<SugarTable>()?.TableName);
        Assert.NotNull(typeof(ArticleRightsProof).GetProperty(nameof(ArticleRightsProof.ArticleRightsSnapshotId)));
        Assert.NotNull(typeof(ArticleRightsProof).GetProperty(nameof(ArticleRightsProof.PublishProofId)));
        Assert.NotNull(typeof(ArticleRightsProof).GetProperty(nameof(ArticleRightsProof.TransparencyLogEntryId)));
        Assert.DoesNotContain(
            typeof(ArticleRightsProof).GetProperties(),
            static property => property.Name.Contains("AdminPrincipal", StringComparison.OrdinalIgnoreCase) ||
                               property.Name.Contains("IpAddress", StringComparison.OrdinalIgnoreCase) ||
                               property.Name.Contains("UserAgent", StringComparison.OrdinalIgnoreCase) ||
                               property.Name.Contains("SessionId", StringComparison.OrdinalIgnoreCase) ||
                               property.Name.Contains("DeviceId", StringComparison.OrdinalIgnoreCase));

        Assert.Contains("CREATE TABLE IF NOT EXISTS article_rights_proof", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_rights_snapshot_id bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("publish_proof_id bigint NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("transparency_log_entry_id bigint NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_rights_proof_idempotency", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("admin_principal", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ip_address", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user_agent", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("session_id", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("device_id", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RuntimeProofCanonicalizer_DoesNotUseExternalNetworkChainsOrPointerContracts()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(ArticleRightsProofCanonicalPayloadV1));
        Assert.DoesNotContain("IPFS", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Arweave", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Nethereum", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HttpClient", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain(
            typeof(ArticleRightsProofCanonicalPayloadV1).GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static),
            static method => method.ReturnType.IsPointer || method.GetParameters().Any(parameter => parameter.ParameterType.IsPointer));
    }

    private static ArticleRightsProofInput ReadyProof()
        => new(
            ProofVersion: 1,
            ArticleId: 910002,
            ArticleRevisionId: 810002,
            RevisionNo: 3,
            ArticleRightsSnapshotId: 710002,
            PublishProofId: 610002,
            RightsPolicyHash: new string('a', 64),
            ContentCanonicalHash: new string('b', 64),
            IssuedAtUtc: new DateTimeOffset(2026, 7, 4, 10, 11, 12, TimeSpan.Zero),
            ProofStatus: PublishProofStatus.Ready,
            PublicationState: PublishProofPublicationState.Public);
}
