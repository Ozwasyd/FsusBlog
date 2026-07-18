using System.Reflection;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.SchemaMigration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublishProofModelTests
{
    [Fact]
    public void RecordPayload_GoldenFixtureBindsArticleRevisionAndArtifacts()
    {
        PublishProofInput proof = ReadyProof();

        string payload = PublishProofCanonicalPayloadV1.BuildRecordPayloadUtf8(proof);
        string digest = PublishProofCanonicalPayloadV1.ComputeRecordDigestHex(proof);

        Assert.Equal(
            """
            fsusblog.integrity.publish-proof-record.v1
            proofVersion:i:1
            signaturePayloadVersion:i:1
            articleId:i:910002
            articleRevisionId:i:810002
            revisionNo:i:3
            canonicalHash:h:1111111111111111111111111111111111111111111111111111111111111111
            aotHash:h:2222222222222222222222222222222222222222222222222222222222222222
            articleDetailAedsHash:h:3333333333333333333333333333333333333333333333333333333333333333
            publicHotReadHash:h:4444444444444444444444444444444444444444444444444444444444444444
            assetManifestHash:h:5555555555555555555555555555555555555555555555555555555555555555
            feedHash:h:6666666666666666666666666666666666666666666666666666666666666666
            publishedAt:t:2026-07-04T10:11:12.0000000Z
            proofStatus:s:ready

            """,
            payload);
        Assert.Equal("5c4723480507daa76bb667a040d3bf92d05af316c10b82d351cd02907ff9d31a", digest);
    }

    [Fact]
    public void SigningPayload_UsesPublishProofDomainAndStableFields()
    {
        PublishProofInput proof = ReadyProof();

        SiteIntegritySigningPayload signingPayload = PublishProofCanonicalPayloadV1.BuildSigningPayload(proof);
        string canonicalSigningPayload = SiteIntegritySigningPayloadCanonicalizer.BuildPayloadUtf8(signingPayload);

        Assert.Equal("publish-proof", signingPayload.ProofKind);
        Assert.Equal("article:910002:revision:810002", signingPayload.Subject);
        Assert.Equal(PublishProofCanonicalPayloadV1.ComputeRecordDigestHex(proof), signingPayload.DigestSha256Hex);
        Assert.Equal(
            """
            fsusblog.integrity.publish-proof.v1
            payloadVersion:i:1
            proofKind:s:cHVibGlzaC1wcm9vZg==
            subject:s:YXJ0aWNsZTo5MTAwMDI6cmV2aXNpb246ODEwMDAy
            digestSha256:h:5c4723480507daa76bb667a040d3bf92d05af316c10b82d351cd02907ff9d31a
            issuedAt:t:2026-07-04T10:11:12.0000000Z
            fieldCount:i:5
            fieldKey:s:YXJ0aWNsZUlk
            fieldValue:s:OTEwMDAy
            fieldKey:s:YXJ0aWNsZVJldmlzaW9uSWQ=
            fieldValue:s:ODEwMDAy
            fieldKey:s:cHJvb2ZWZXJzaW9u
            fieldValue:s:MQ==
            fieldKey:s:cmV2aXNpb25Obw==
            fieldValue:s:Mw==
            fieldKey:s:c2lnbmF0dXJlUGF5bG9hZFZlcnNpb24=
            fieldValue:s:MQ==

            """,
            canonicalSigningPayload);
    }

    [Fact]
    public void Readiness_MissingOrStaleArtifactDoesNotBecomeFakeReady()
    {
        PublishProofReadiness missing = PublishProofReadiness.Evaluate(
            ReadyProof(),
            [
                ArtifactDigestV1.Missing(ArtifactDigestKind.ArticleDetailAeds, "article-detail-aeds:910002", "file-missing")
            ]);
        PublishProofReadiness stale = PublishProofReadiness.Evaluate(
            ReadyProof(),
            [
                ArtifactDigestV1.Stale(ArtifactDigestKind.PublicHotRead, "public-hot-read:home", "outbox-not-replayed")
            ]);

        Assert.Equal(PublishProofStatus.Pending, missing.Status);
        Assert.Equal("artifact-missing", missing.Reason);
        Assert.Equal(PublishProofStatus.Failed, stale.Status);
        Assert.Equal("artifact-stale", stale.Reason);
    }

    [Fact]
    public void IdempotencyKey_ReplayingSameRevisionIsStable()
    {
        PublishProofInput first = ReadyProof();
        PublishProofInput replay = ReadyProof() with
        {
            PublishedAtUtc = ReadyProof().PublishedAtUtc.AddMinutes(5),
            PublicHotReadHash = new string('9', 64)
        };

        Assert.Equal(
            "article:910002:revision:810002:proof:1",
            PublishProofIdempotency.BuildKey(first.ArticleId, first.ArticleRevisionId, first.ProofVersion));
        Assert.Equal(
            PublishProofIdempotency.BuildKey(first.ArticleId, first.ArticleRevisionId, first.ProofVersion),
            PublishProofIdempotency.BuildKey(replay.ArticleId, replay.ArticleRevisionId, replay.ProofVersion));
    }

    [Fact]
    public void StateMachine_RejectsInvalidTransitionsAndKeepsSupersededTerminal()
    {
        Assert.True(PublishProofStateMachine.CanTransition(PublishProofStatus.Pending, PublishProofStatus.Ready));
        Assert.True(PublishProofStateMachine.CanTransition(PublishProofStatus.Ready, PublishProofStatus.Superseded));
        Assert.True(PublishProofStateMachine.CanTransition(PublishProofStatus.Failed, PublishProofStatus.Retrying));
        Assert.False(PublishProofStateMachine.CanTransition(PublishProofStatus.Ready, PublishProofStatus.Failed));
        Assert.False(PublishProofStateMachine.CanTransition(PublishProofStatus.Superseded, PublishProofStatus.Ready));
    }

    [Fact]
    public void NotPublicArticleCannotGenerateReadyPublicProof()
    {
        PublishProofInput archived = ReadyProof() with
        {
            PublicationState = PublishProofPublicationState.Archived
        };
        PublishProofInput deleted = ReadyProof() with
        {
            PublicationState = PublishProofPublicationState.Deleted
        };

        Assert.Equal(PublishProofStatus.NotPublic, PublishProofReadiness.Evaluate(archived, []).Status);
        Assert.Equal(PublishProofStatus.NotPublic, PublishProofReadiness.Evaluate(deleted, []).Status);
    }

    [Fact]
    public void EntityAndMigrationPersistPublishProofWithoutAdminPrincipalLeak()
    {
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260704-post-article-publish-proof");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(
            "article_publish_proof",
            typeof(ArticlePublishProof).GetCustomAttribute<SugarTable>()?.TableName);
        Assert.NotNull(typeof(ArticlePublishProof).GetProperty(nameof(ArticlePublishProof.ArticleRevisionId)));
        Assert.Contains(typeof(ArticlePublishProof).GetCustomAttributes<SugarIndexAttribute>(), static index =>
            index.IndexName == "ux_article_publish_proof_idempotency");
        Assert.Null(typeof(ArticlePublishProof).GetProperty("CreatedByAdminPrincipalId"));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS article_publish_proof", fingerprint, StringComparison.Ordinal);
        Assert.Contains("article_revision_id bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("revision_no integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("signature_payload_version integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("ux_article_publish_proof_idempotency", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("created_by_admin_principal_id", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void PublishProofRuntime_DoesNotCallExternalNetworkChainsOrUsePointerTypes()
    {
        Type[] runtimeTypes =
        [
            typeof(PublishProofReadiness),
            typeof(PublishProofIdempotency),
            typeof(PublishProofStateMachine),
            typeof(PublishProofCanonicalPayloadV1)
        ];
        MethodInfo[] methods = runtimeTypes.SelectMany(static type => type.GetMethods(
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly)).ToArray();
        MethodBase[] calls = methods.SelectMany(ReadCalledMethods).ToArray();
        string[] literals = methods.SelectMany(ReadStringLiterals).ToArray();

        Assert.DoesNotContain(calls, static call =>
            call.DeclaringType == typeof(HttpClient)
            || ContainsForbiddenDependency(call.DeclaringType?.FullName));
        Assert.DoesNotContain(literals, static literal => ContainsForbiddenDependency(literal));
        Assert.DoesNotContain(methods, static method =>
            method.ReturnType.IsPointer
            || method.GetParameters().Any(static parameter => parameter.ParameterType.IsPointer)
            || (method.GetMethodBody()?.LocalVariables.Any(static local => local.LocalType.IsPointer) ?? false));
    }

    private static PublishProofInput ReadyProof()
        => new(
            ProofVersion: 1,
            ArticleId: 910002,
            ArticleRevisionId: 810002,
            RevisionNo: 3,
            CanonicalHash: new string('1', 64),
            AotHash: new string('2', 64),
            ArticleDetailAedsHash: new string('3', 64),
            PublicHotReadHash: new string('4', 64),
            AssetManifestHash: new string('5', 64),
            FeedHash: new string('6', 64),
            PublishedAtUtc: new DateTimeOffset(2026, 7, 4, 10, 11, 12, TimeSpan.Zero),
            ProofStatus: PublishProofStatus.Ready,
            PublicationState: PublishProofPublicationState.Public);

    private static bool ContainsForbiddenDependency(string? value)
        => value?.Contains("IPFS", StringComparison.OrdinalIgnoreCase) == true
            || value?.Contains("Arweave", StringComparison.OrdinalIgnoreCase) == true
            || value?.Contains("Nethereum", StringComparison.OrdinalIgnoreCase) == true;

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
            {
                continue;
            }

            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
            {
                yield return called;
            }
        }
    }

    private static IEnumerable<string> ReadStringLiterals(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] != 0x72)
            {
                continue;
            }

            string? literal = null;
            try
            {
                literal = method.Module.ResolveString(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (literal is not null)
            {
                yield return literal;
            }
        }
    }
}
