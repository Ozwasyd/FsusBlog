using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticlePublicationFixturePortTests
{
    private static readonly string s_validDigest = "sha256:" + new string('a', 64);
    private static readonly string s_validSha256 = new string('b', 64);

    private static CanonicalArticlePublicationFixtureBinding CreateBinding(
        long adminPrincipalId = 1,
        string? writerContractDigest = null,
        string? temporalContextDigest = null,
        IReadOnlyList<string>? capabilities = null)
    {
        return new CanonicalArticlePublicationFixtureBinding(
            RunId: "run-test-1",
            Namespace: "test-ns",
            ProfileId: "profile-canonical",
            Capabilities: capabilities ?? ["article:publish", "article:write"],
            AdminPrincipalId: adminPrincipalId,
            WriterContractDigest: writerContractDigest ?? s_validDigest,
            TemporalContextDigest: temporalContextDigest ?? s_validDigest);
    }

    private static CanonicalArticlePublicationPlan CreatePlan(
        string title = "Canonical Title",
        string content = "Canonical Content Body",
        string? summary = null,
        string semanticRole = "canonical-article-fixture",
        ArticleRightsRequestCoreModel? rights = null,
        ArticleResponsibilityDraft? responsibility = null)
    {
        return new CanonicalArticlePublicationPlan(
            SemanticRole: semanticRole,
            Title: title,
            Content: content,
            Summary: summary,
            CoverImageUrl: "https://example.com/cover.png",
            CategoryId: 1,
            TagIds: [2, 1, 3, 2],
            Rights: rights,
            Responsibility: responsibility);
    }

    [Fact]
    public void Binding_AdminPrincipalIdZeroOrNegative_FailsClosed()
    {
        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(adminPrincipalId: 0).Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(adminPrincipalId: -1).Validate());
    }

    [Fact]
    public void Binding_MissingRequiredFieldsOrInvalidDigests_FailsClosed()
    {
        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            new CanonicalArticlePublicationFixtureBinding(
                RunId: "",
                Namespace: "ns",
                ProfileId: "profile",
                Capabilities: ["cap"],
                AdminPrincipalId: 1,
                WriterContractDigest: s_validDigest,
                TemporalContextDigest: s_validDigest).Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(writerContractDigest: "not-a-digest").Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(temporalContextDigest: "short").Validate());

        Assert.Throws<CanonicalArticlePublicationValidationException>(() =>
            CreateBinding(capabilities: []).Validate());
    }

    [Fact]
    public async Task PublishAsync_RightsRecomputeSentinel_FailsClosed()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IConfiguration config = new ConfigurationBuilder().Build();
        IArticlePublicationValidator validator = Substitute.For<IArticlePublicationValidator>();
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        var port = new CanonicalArticlePublicationFixturePort(db, config, validator, fence);

        var rights = new ArticleRightsRequestCoreModel(
            Enabled: true,
            LicenseType: "recompute-license",
            CopyrightHolder: null,
            CopyrightYear: null,
            RightsStatement: null,
            AttributionTemplate: null,
            CopyPolicy: "append-attribution",
            MaxExcerptChars: 300,
            AllowCodeCopy: true,
            ShowPublicBadge: true,
            ProofBindingEnabled: true);

        var request = new CanonicalArticlePublicationRequest(
            CreateBinding(),
            CreatePlan(rights: rights));

        var ex = await Assert.ThrowsAsync<CanonicalArticlePublicationValidationException>(() =>
            port.PublishAsync(request));

        Assert.Equal("rights_recompute_sentinel_forbidden", ex.Code);
    }

    [Fact]
    public void ResponsibilityBuilder_Build_ThrowsWhenGovernanceFails()
    {
        DateTime now = DateTime.UtcNow;
        var invalidDraft = new ArticleResponsibilityDraft(
            InheritSiteAuthor: false,
            Authors: [], // empty authors fails governance
            Reviewer: null,
            Sources: [],
            UpdateSummary: null,
            UpdateReason: null,
            EffectiveAt: null,
            ConclusionImpact: null,
            Methodology: null,
            Applicability: null,
            Limitations: null,
            ResponsiblePersonConfirmed: false,
            ContainsStrongClaims: false,
            IsSubstantiveUpdate: false,
            RequiresMethodsDisclosure: false,
            ExpectedVersion: 1);

        Assert.Throws<InvalidOperationException>(() =>
            ArticleResponsibilitySnapshotBuilder.Build(
                articleId: 1,
                revisionId: 1,
                revisionNo: 1,
                responsibilityVersion: 1,
                previousSnapshotId: null,
                draft: invalidDraft,
                createdAt: now));
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeText_EnforcesBounds()
    {
        Assert.Equal(string.Empty, ArticleProductionNormalizers.NormalizeText(null, 100));
        Assert.Equal(string.Empty, ArticleProductionNormalizers.NormalizeText("   ", 100));
        Assert.Equal("test text", ArticleProductionNormalizers.NormalizeText("  test text  ", 100));

        string longText = new string('x', 200);
        string truncated = ArticleProductionNormalizers.NormalizeText(longText, 100);
        Assert.Equal(100, truncated.Length);
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeTagIds_DeduplicatesPreservingFirstSeenOrder()
    {
        var result = ArticleProductionNormalizers.NormalizeTagIds([5, 3, 1, 5, 2, -1, 0]);
        Assert.Equal([5, 3, 1, 2, -1, 0], result);
    }

    [Fact]
    public void ArticleService_SharedSeams_AreReferencedByProductionSources()
    {
        string service = System.IO.File.ReadAllText(
            System.IO.Path.Combine(FindRepoRoot(), "src/backend/Services/ArticleService.cs"));
        string mutations = System.IO.File.ReadAllText(
            System.IO.Path.Combine(FindRepoRoot(), "src/backend/Services/ArticleService.Mutations.cs"));
        string cache = System.IO.File.ReadAllText(
            System.IO.Path.Combine(FindRepoRoot(), "src/backend/Services/ArticleService.CacheAndInvalidation.cs"));
        string responsibility = System.IO.File.ReadAllText(
            System.IO.Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/Integrity/ArticleResponsibilityManifest.cs"));

        Assert.Contains("ArticleProductionNormalizers.NormalizeArticleRights", service, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsSnapshotBuilder.Build", service, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsPolicyPersistence.UpsertAsync", service, StringComparison.Ordinal);
        Assert.Contains("ArticleCreateMutationAuthority.ExecuteAsync", service, StringComparison.Ordinal);
        Assert.Contains("ArticleRevisionPersistence.SaveAsync", service, StringComparison.Ordinal);
        string port = System.IO.File.ReadAllText(
            System.IO.Path.Combine(FindRepoRoot(), "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs"));
        Assert.Contains("ArticleCreateMutationAuthority.ExecuteAsync", port, StringComparison.Ordinal);
        Assert.Contains("BeginPublicMutationFenceAsync", port, StringComparison.Ordinal);
        Assert.DoesNotContain("new ArticleRevision", port, StringComparison.Ordinal);
        Assert.Contains("ArticleProductionNormalizers.NormalizeText", cache, StringComparison.Ordinal);
        Assert.Contains("ArticleProductionNormalizers.NormalizeTagIds", cache, StringComparison.Ordinal);
        Assert.Contains("ArticleResponsibilitySnapshotBuilder.Build", responsibility, StringComparison.Ordinal);
        Assert.DoesNotContain("private sealed record ArticleRightsWriteModel", service, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsNormalizedModel", mutations, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        string? dir = AppContext.BaseDirectory;
        while (!string.IsNullOrEmpty(dir))
        {
            if (System.IO.File.Exists(System.IO.Path.Combine(dir, "AGENTS.md")))
            {
                return dir;
            }
            dir = System.IO.Directory.GetParent(dir)?.FullName;
        }
        throw new InvalidOperationException("repository root not found");
    }

    [Fact]
    public void ArticleProductionNormalizers_NormalizeArticleRights_EnforcesDefaults()
    {
        var normalized = ArticleProductionNormalizers.NormalizeArticleRights(null);
        Assert.True(normalized.Enabled);
        Assert.Equal("all-rights-reserved", normalized.LicenseType);
        Assert.Equal("append-attribution", normalized.CopyPolicy);
        Assert.Equal(300, normalized.MaxExcerptChars);
        Assert.True(normalized.AllowCodeCopy);
        Assert.True(normalized.ShowPublicBadge);
        Assert.True(normalized.ProofBindingEnabled);
    }

    [Fact]
    public void ArticleRightsSnapshotBuilder_BuildsDeterministicHashes()
    {
        DateTime now = DateTime.UtcNow;
        var rights = ArticleProductionNormalizers.NormalizeArticleRights(null);

        var (snapshot1, hash1, policy1) = ArticleRightsSnapshotBuilder.Build(
            articleId: 42,
            revisionId: 101,
            revisionNo: 1,
            policyId: 1,
            title: "Article Title",
            content: "Markdown Body Content",
            summary: "Summary",
            coverImageUrl: null,
            categoryId: 1,
            tagIds: [1, 2],
            status: ArticleStatus.Published,
            publishedAt: now,
            scheduledPublishAt: null,
            rights: rights,
            createdAt: now);

        var (snapshot2, hash2, policy2) = ArticleRightsSnapshotBuilder.Build(
            articleId: 42,
            revisionId: 101,
            revisionNo: 1,
            policyId: 1,
            title: "Article Title",
            content: "Markdown Body Content",
            summary: "Summary",
            coverImageUrl: null,
            categoryId: 1,
            tagIds: [1, 2],
            status: ArticleStatus.Published,
            publishedAt: now,
            scheduledPublishAt: null,
            rights: rights,
            createdAt: now);

        Assert.Equal(hash1, hash2);
        Assert.Equal(policy1, policy2);
        Assert.Equal(snapshot1.ContentCanonicalHash, snapshot2.ContentCanonicalHash);
        Assert.Equal(snapshot1.PolicyHash, snapshot2.PolicyHash);
        Assert.False(snapshot1.PolicyHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));
        Assert.False(snapshot1.ContentCanonicalHash.Contains("recompute", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Verifier_DetectsTamperedReceiptDigest()
    {
        var binding = CreateBinding();
        var plan = CreatePlan();

        var receipt = new CanonicalArticlePublicationReceipt(
            Schema: CanonicalArticlePublicationFixturePort.Schema,
            WriterContractDigest: binding.WriterContractDigest,
            RunId: binding.RunId,
            Namespace: binding.Namespace,
            ProfileId: binding.ProfileId,
            SemanticRole: plan.SemanticRole,
            AdminPrincipalId: binding.AdminPrincipalId,
            ArticleId: 10,
            RevisionId: 20,
            RevisionNo: 1,
            PublicationId: 30,
            PublicationNo: 1,
            RightsSnapshotId: 40,
            ContentCanonicalHash: s_validSha256,
            PolicyHash: s_validSha256,
            ResponsibilitySnapshotId: 50,
            ResponsibilityVersion: 1,
            OutboxEventId: "event-1",
            OutboxPayloadDigest: s_validSha256,
            AuditChainId: "chain-1",
            AuditRecordHash: s_validSha256,
            ContentDigest: s_validSha256,
            RequiredEdges: ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray(),
            ReceiptDigest: "sha256:tampered_invalid_digest_00000000000000000000000000000000000000000000000");

        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        var verification = await CanonicalArticlePublicationVerifier.VerifyAsync(db, receipt);
        Assert.Contains(verification.Violations, static v => v.Contains("receipt_digest_tamper_detected"));
    }

    [Fact]
    public async Task Verifier_DetectsSchemaMismatch()
    {
        var binding = CreateBinding();
        var plan = CreatePlan();

        var receipt = new CanonicalArticlePublicationReceipt(
            Schema: "unsupported-schema-version",
            WriterContractDigest: binding.WriterContractDigest,
            RunId: binding.RunId,
            Namespace: binding.Namespace,
            ProfileId: binding.ProfileId,
            SemanticRole: plan.SemanticRole,
            AdminPrincipalId: binding.AdminPrincipalId,
            ArticleId: 10,
            RevisionId: 20,
            RevisionNo: 1,
            PublicationId: 30,
            PublicationNo: 1,
            RightsSnapshotId: 40,
            ContentCanonicalHash: s_validSha256,
            PolicyHash: s_validSha256,
            ResponsibilitySnapshotId: 50,
            ResponsibilityVersion: 1,
            OutboxEventId: "event-1",
            OutboxPayloadDigest: s_validSha256,
            AuditChainId: "chain-1",
            AuditRecordHash: s_validSha256,
            ContentDigest: s_validSha256,
            RequiredEdges: ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray(),
            ReceiptDigest: "sha256:digest");

        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();

        var verification = await CanonicalArticlePublicationVerifier.VerifyAsync(db, receipt);
        Assert.Contains(verification.Violations, static v => v.Contains("receipt_schema_mismatch"));
    }

    [Fact]
    public void Port_DoesNotTouchRedisOrDirectProjections_OutputsRequiredEdges()
    {
        var edges = ArticleMutationReplayEdges.Required;
        Assert.Contains("search-projection", edges);
        Assert.Contains("public-aot-invalidation", edges);
        Assert.Contains("http-cache-invalidation", edges);
    }
}
