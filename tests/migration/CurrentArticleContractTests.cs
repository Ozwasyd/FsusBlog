using System.Text.Json;

using FsusBlog.Contracts.Articles;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class CurrentArticleContractTests
{
    [Fact]
    public void ContentCanonicalHash_PreservesOriginalCompleteGoldenVector()
    {
        // Original canonical-hash-golden-vectors.json, not a migration-specific hash.
        var input = new ArticleCanonicalInput(
            42, 9001, 3, "article:42", "发布说明 Café 中文 😀", null, "/assets/cover.png",
            7, [9, 2, 5], 2, new DateTime(2026, 6, 1, 8, 30, 0, DateTimeKind.Utc), null,
            "# 标题\r\n\r\nCafe\u0301 中文 😀\r\n");

        Assert.Equal(
            "129cb6dac691dccdf53e797da943167ef1e5f3f3972327c221f94e13bcbfab66",
            ArticleCanonicalHashV1.ComputeHashHex(input));
    }

    [Fact]
    public void RightsCanonicalHash_PreservesOriginalCompleteGoldenVector()
    {
        var input = new ArticleRightsCanonicalInput(
            42, 9001, 3, "CC-BY-4.0", "Fe\u0301sus Cafe\u0301", 2026,
            "Line one\r\nLine two Cafe\u0301", "{title} — {holder} ({year}) {license} {url} {proof}",
            "append-attribution", 300, true, true, "https://example.test/articles/cafe",
            "SHA256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789");

        Assert.Equal(
            "sha256:fb79f2fe498ac6e39de1d1a65161a773c83324cd776b2ed7346e7a1c68b8c1ef",
            ArticleRightsCanonicalHashV1.ComputeHashHex(input));
    }

    [Fact]
    public void ContentCanonicalHash_DoesNotCollapseFinalNewline()
    {
        var source = new ArticleCanonicalInput(1, 1, 1, "article:1", "Title", null, null,
            1, [], 2, new DateTime(2026, 5, 17, 10, 0, 0, DateTimeKind.Utc), null, "body");

        Assert.NotEqual(
            ArticleCanonicalHashV1.ComputeHashHex(source),
            ArticleCanonicalHashV1.ComputeHashHex(source with
            {
                MarkdownContent = "body\n"
            }));
    }

    [Fact]
    public void WriterAndWireNormalization_PreserveTheirDifferentNegativeExcerptContracts()
    {
        ArticleRightsRequestCoreModel source = ArticleProductionNormalizers.NormalizeWireArticleRights(null)
            with
        {
            MaxExcerptChars = -1
        };

        Assert.Throws<ArgumentOutOfRangeException>(
            () => ArticleProductionNormalizers.NormalizeArticleRights(source));
        Assert.Equal(0, ArticleProductionNormalizers.NormalizeWireArticleRights(source).MaxExcerptChars);
    }

    [Fact]
    public void WriterAndWireNormalization_PreserveTheirDifferentWhitespaceContracts()
    {
        ArticleRightsRequestCoreModel source = ArticleProductionNormalizers.NormalizeWireArticleRights(null)
            with
        {
            LicenseType = "  CC-BY-4.0  ",
            CopyrightHolder = "  Owner  "
        };

        ArticleRightsNormalizedModel writer = ArticleProductionNormalizers.NormalizeArticleRights(source);
        ArticleRightsRequestCoreModel wire = ArticleProductionNormalizers.NormalizeWireArticleRights(source);
        Assert.Equal("CC-BY-4.0", writer.LicenseType);
        Assert.Equal("Owner", writer.CopyrightHolder);
        Assert.Equal(source.LicenseType, wire.LicenseType);
        Assert.Equal(source.CopyrightHolder, wire.CopyrightHolder);
    }

    [Fact]
    public void OmittedRights_ResolveEveryFieldToTheSameExistingDefaults()
    {
        ArticleRightsNormalizedModel writer = ArticleProductionNormalizers.NormalizeArticleRights(null);
        ArticleRightsRequestCoreModel wire = ArticleProductionNormalizers.NormalizeWireArticleRights(null);

        Assert.Equal(JsonSerializer.Serialize(wire), JsonSerializer.Serialize(writer));
        Assert.Equal("all-rights-reserved", writer.LicenseType);
        Assert.Equal("append-attribution", writer.CopyPolicy);
        Assert.Equal(300, writer.MaxExcerptChars);
        Assert.True(writer.Enabled && writer.AllowCodeCopy && writer.ShowPublicBadge && writer.ProofBindingEnabled);
        Assert.Null(writer.CopyrightHolder);
    }

    [Fact]
    public void RightsCanonicalBinding_UsesTheOriginalCompleteContentAndPolicyAssociation()
    {
        var article = new ArticleCanonicalInput(1, 101, 1, "article:1", "Title", null, null,
            1, [], ArticleStatusValues.Published, new DateTime(2026, 5, 17, 10, 0, 0, DateTimeKind.Utc), null, "body\n");
        ArticleRightsNormalizedModel rights = ArticleProductionNormalizers.NormalizeArticleRights(null);
        ArticleRightsCanonicalBinding binding = ArticleRightsCanonicalBinding.Build(article, rights);

        Assert.Equal("sha256:" + ArticleCanonicalHashV1.ComputeHashHex(article), binding.ContentCanonicalHash);
        Assert.Equal(binding.ContentCanonicalHash, binding.Rights.ContentCanonicalHash);
        Assert.Equal(ArticleRightsCanonicalHashV1.ComputeHashHex(binding.Rights), binding.PolicyHash);
        Assert.Equal(article.ArticleRevisionId, binding.Rights.ArticleRevisionId);
        Assert.Equal(article.RevisionNo, binding.Rights.RevisionNo);
        Assert.Null(binding.Rights.CanonicalUrl);
    }

    [Theory]
    [InlineData(null, 1)]
    [InlineData(101L, null)]
    [InlineData(0L, 1)]
    [InlineData(101L, 0)]
    public void RightsCanonicalBinding_RejectsMissingOrNonpositiveRevisionCoordinates(long? revisionId, int? revisionNo)
    {
        var article = new ArticleCanonicalInput(1, revisionId, revisionNo, "article:1", "Title", null, null,
            1, [], ArticleStatusValues.Draft, null, null, "body");
        Assert.True(revisionId is null or <= 0 || revisionNo is null or <= 0);
        Assert.ThrowsAny<ArgumentException>(() => ArticleRightsCanonicalBinding.Build(article,
            ArticleProductionNormalizers.NormalizeArticleRights(null)));
    }

    [Theory]
    [InlineData(null, "Fsu")]
    [InlineData("   ", "Fsu")]
    [InlineData("  configured  ", "configured")]
    [InlineData("中文中文中文中文", "中文中文中文")]
    [InlineData("😀😀😀😀😀😀", "😀😀😀😀😀")]
    public void CurrentSiteAuthor_PreservesTheOriginalFallbackTrimAndRuneSafeTwentyByteBound(string? raw, string expected)
    {
        Assert.Equal(expected, FsusBlog.Shared.Contracts.Outputs.PublicSiteAuthorPolicy.Resolve(raw));
    }

    [Fact]
    public void CurrentStoredResponsibilityDefaults_DoNotAssertHumanApprovalOrAnAdministratorIdentity()
    {
        ArticleResponsibilityDraft draft = ArticleCurrentPolicyDefaults.ResponsibilityDraft();
        Assert.Equal(0, ArticleCurrentPolicyDefaults.UnattributedCreatorId);
        Assert.Equal(ArticleStatusValues.Published, ArticleCurrentPolicyDefaults.Status);
        Assert.Equal(1, draft.ExpectedVersion);
        Assert.True(draft.InheritSiteAuthor);
        Assert.Empty(draft.Authors);
        Assert.Empty(draft.Sources);
        Assert.False(draft.ResponsiblePersonConfirmed);
        Assert.Contains(ArticleResponsibilityGovernance.Evaluate(draft), static issue => issue.Severity == "error");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("body")]
    [InlineData("body\n")]
    [InlineData("Cafe\u0301 中文 😀\r\n")]
    public void CurrentContentBlockAddress_PreservesOriginalRawUtf8LengthAndUppercaseHash(string? markdown)
    {
        ArticleRevisionContentAddress address = ArticleRevisionContentAddress.Compute(markdown);
        byte[] original = System.Text.Encoding.UTF8.GetBytes(markdown ?? string.Empty);
        Assert.Equal(markdown ?? string.Empty, address.MarkdownContent);
        Assert.Equal(original.Length, address.ByteLength);
        Assert.Equal(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(original)), address.ContentHash);
        Assert.Equal(address.ContentHash.ToUpperInvariant(), address.ContentHash);
    }

    [Fact]
    public void CurrentRevisionTagEncoding_PreservesOriginalSortingAndDoesNotAddFilteringOrDeduplication()
    {
        int[] tags = [3, -1, 3, 1];
        Assert.Equal("-1,1,3,3", ArticleRevisionStorageEncoding.EncodeTagIds(tags));
        Assert.Equal(string.Empty, ArticleRevisionStorageEncoding.EncodeTagIds([]));
        Assert.Equal(string.Join(',', tags.OrderBy(static id => id)), ArticleRevisionStorageEncoding.EncodeTagIds(tags));
    }

    [Fact]
    public void CurrentResponsibilityJson_PreservesAllThreeOriginalWebEncodedFieldsWithoutApprovingTheDraft()
    {
        ArticleResponsibilityDraft draft = ArticleCurrentPolicyDefaults.ResponsibilityDraft() with
        {
            Authors = [new("中文作者", "https://author.example/profile")],
            Reviewer = new("reviewer", null),
            Sources = [new("source", "https://source.example/reference", "primary", new(2026, 5, 17), "v1", "citation", false)]
        };
        var originalOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        ArticleResponsibilityStorageEncoding encoded = ArticleResponsibilityStorageEncoding.Encode(draft);
        Assert.Equal(JsonSerializer.Serialize(draft.Authors, originalOptions), encoded.AuthorsJson);
        Assert.Equal(JsonSerializer.Serialize(draft.Reviewer, originalOptions), encoded.ReviewerJson);
        Assert.Equal(JsonSerializer.Serialize(draft.Sources, originalOptions), encoded.SourcesJson);
        Assert.False(draft.ResponsiblePersonConfirmed);
        Assert.Contains(ArticleResponsibilityGovernance.Evaluate(draft), static issue => issue.Severity == "error");
        Assert.Null(ArticleResponsibilityStorageEncoding.Encode(draft with
        {
            Reviewer = null
        }).ReviewerJson);
    }
}
