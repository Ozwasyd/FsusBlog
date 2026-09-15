using System.Text.Json;

using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class BlockAnchorContractTests
{
    private const string Article = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";

    [Fact]
    public void BlockAnchorId_AcceptsMinimumAndMaximumCanonicalValuesWithoutChangingBytes()
    {
        string maximum = "a" + new string('z', 62) + "9";

        BlockAnchorValidationResult minimum = BlockAnchorId.TryCreate("a", out BlockAnchorId min);
        BlockAnchorValidationResult maximumResult = BlockAnchorId.TryCreate(maximum, out BlockAnchorId max);

        Assert.True(minimum.IsValid, minimum.ReasonCode);
        Assert.True(maximumResult.IsValid, maximumResult.ReasonCode);
        Assert.Equal("a", min.Value);
        Assert.Equal(maximum, max.Value);
        Assert.Equal(64, max.Value.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("Aanchor")]
    [InlineData("anchor_Name")]
    [InlineData("1anchor")]
    [InlineData("anchor^")]
    [InlineData("anchor%2dname")]
    [InlineData("anchor name")]
    [InlineData("锚点")]
    public void BlockAnchorId_RejectsNonCanonicalGrammar(string value)
    {
        BlockAnchorValidationResult validation = BlockAnchorId.TryCreate(value, out BlockAnchorId id);

        Assert.False(validation.IsValid);
        Assert.Equal(BlockAnchorErrorCode.InvalidGrammar, validation.ErrorCode);
        Assert.Null(id.Value);
    }

    [Fact]
    public void BlockAnchorId_RejectsOverlengthAndDoesNotNormalize()
    {
        string overlength = "a" + new string('b', 64);
        BlockAnchorValidationResult validation = BlockAnchorId.TryCreate(overlength, out _);

        Assert.False(validation.IsValid);
        Assert.Equal(BlockAnchorErrorCode.InvalidGrammar, validation.ErrorCode);
        Assert.False(BlockAnchorId.IsCanonical(" Anchor"));
        Assert.False(BlockAnchorId.IsCanonical("ANCHOR"));
    }

    [Fact]
    public void SourceMarkerAndFragment_RoundTripExactlyAndNeverExchangePrefixes()
    {
        BlockAnchorId id = BlockAnchorId.Create("release-notes-2026");

        string marker = BlockAnchorCodec.BuildSourceMarker(id);
        string fragment = BlockAnchorCodec.BuildFragment(id);

        Assert.Equal("^release-notes-2026", marker);
        Assert.Equal("#release-notes-2026", fragment);
        Assert.DoesNotContain('^', fragment);

        Assert.True(BlockAnchorCodec.TryParseSourceMarker(marker, out BlockAnchorId source).IsValid);
        Assert.True(BlockAnchorCodec.TryParseFragment(fragment, out BlockAnchorId url).IsValid);
        Assert.Equal(id, source);
        Assert.Equal(id, url);
    }

    [Theory]
    [InlineData("#^release-notes")]
    [InlineData("#Release-notes")]
    [InlineData("#release_notes")]
    [InlineData("#release%2dnotes")]
    [InlineData("release-notes")]
    [InlineData("[[Article#release-notes]]")]
    [InlineData("{#release-notes}")]
    [InlineData("<a id=\"release-notes\">")]
    public void FragmentParser_RejectsAliasesPercentEncodingAndUnsupportedSyntax(string fragment)
    {
        BlockAnchorValidationResult validation = BlockAnchorCodec.TryParseFragment(
            fragment,
            out BlockAnchorId id);

        Assert.False(validation.IsValid);
        Assert.Null(id.Value);
        Assert.True(new[]
        {
            BlockAnchorErrorCode.InvalidGrammar,
            BlockAnchorErrorCode.UnsupportedSyntax,
            BlockAnchorErrorCode.CodecMismatch
        }.Contains(validation.ErrorCode!.Value));
    }

    [Fact]
    public void UrlParser_UsesOnlyRawCanonicalFragmentAndNeverPercentDecodesIt()
    {
        BlockAnchorValidationResult valid = BlockAnchorUrlParser.TryParseUrl(
            "/posts/slug%20projection#release-notes",
            out BlockAnchorId id);

        Assert.True(valid.IsValid, valid.ReasonCode);
        Assert.Equal("release-notes", id.Value);

        BlockAnchorValidationResult encoded = BlockAnchorUrlParser.TryParseUrl(
            "/posts/slug#release%2dnotes",
            out _);
        BlockAnchorValidationResult marker = BlockAnchorUrlParser.TryParseUrl(
            "/posts/slug#^release-notes",
            out _);

        Assert.False(encoded.IsValid);
        Assert.Equal(BlockAnchorErrorCode.CodecMismatch, encoded.ErrorCode);
        Assert.False(marker.IsValid);
        Assert.Equal(BlockAnchorErrorCode.UnsupportedSyntax, marker.ErrorCode);
    }

    [Fact]
    public void ArticleBlockTarget_ContainsStableIdentityAndNoRouteOrContentFallback()
    {
        BlockAnchorId anchor = BlockAnchorId.Create("stable-block");
        ArticleBlockTarget target = ArticleBlockTarget.Create(Article, anchor);

        Assert.Equal(Article, target.ArticleIdentity);
        Assert.Equal(anchor, target.AnchorId);
        Assert.True(BlockAnchorContractValidator.Validate(target).IsValid);

        Assert.False(BlockAnchorContractValidator.Validate(
            new ArticleBlockTarget("/posts/canonical-slug", anchor)).IsValid);
        Assert.False(BlockAnchorContractValidator.Validate(
            new ArticleBlockTarget("article-title", anchor)).IsValid);
    }

    [Fact]
    public void ArticleBlockTarget_ClassifiesMissingArticleAndAnchorWithoutGuessing()
    {
        BlockAnchorValidationResult missingArticle = ArticleBlockTarget.TryCreate(
            null,
            "stable-block",
            out ArticleBlockTarget? noArticle);
        BlockAnchorValidationResult missingAnchor = ArticleBlockTarget.TryCreate(
            Article,
            null,
            out ArticleBlockTarget? noAnchor);

        Assert.False(missingArticle.IsValid);
        Assert.Equal(BlockAnchorErrorCode.MissingArticle, missingArticle.ErrorCode);
        Assert.Null(noArticle);
        Assert.False(missingAnchor.IsValid);
        Assert.Equal(BlockAnchorErrorCode.MissingAnchor, missingAnchor.ErrorCode);
        Assert.Null(noAnchor);
    }

    [Fact]
    public void MarkdownBuilder_EncodesOnlyRouteProjectionAndPreservesAnchor()
    {
        ArticleBlockTarget target = ArticleBlockTarget.Create(
            Article,
            BlockAnchorId.Create("release-notes"));

        string markdown = BlockAnchorMarkdownBuilder.Build(
            "Read this block",
            "Café release notes",
            target);

        Assert.Equal(
            "[Read this block](/posts/Caf%C3%A9%20release%20notes#release-notes)",
            markdown);
        Assert.DoesNotContain("#^", markdown);
        Assert.True(BlockAnchorMarkdownParser.TryParse(markdown, out BlockAnchorMarkdownLink? link).IsValid);
        Assert.NotNull(link);
        Assert.Equal("Read this block", link!.DisplayText);
        Assert.Equal("/posts/Caf%C3%A9%20release%20notes", link.RoutePath);
        Assert.Equal("release-notes", link.AnchorId.Value);
    }

    [Theory]
    [InlineData("[[Article#release-notes]]")]
    [InlineData("[Read](/posts/slug#^release-notes)")]
    [InlineData("[Read](/posts/slug#release%2dnotes)")]
    [InlineData("[Read](/posts/slug){#release-notes}")]
    [InlineData("<a href=\"/posts/slug#release-notes\">Read</a>")]
    public void MarkdownParser_RejectsWikilinkHtmlSidecarAndFragmentAliases(string markdown)
    {
        BlockAnchorValidationResult validation = BlockAnchorMarkdownParser.TryParse(
            markdown,
            out BlockAnchorMarkdownLink? link);

        Assert.False(validation.IsValid);
        Assert.Null(link);
    }

    [Fact]
    public void DuplicateAndCollisionInputsAreNotAutoSuffixedOrFirstMatched()
    {
        ArticleBlockTarget first = ArticleBlockTarget.Create(Article, BlockAnchorId.Create("same-anchor"));
        ArticleBlockTarget second = ArticleBlockTarget.Create(Article, BlockAnchorId.Create("same-anchor"));

        Assert.Equal(first, second);
        Assert.Equal(
            "[First](/posts/article#same-anchor)",
            BlockAnchorMarkdownBuilder.Build("First", "article", first));
        Assert.Equal(
            "[Second](/posts/article#same-anchor)",
            BlockAnchorMarkdownBuilder.Build("Second", "article", second));
        Assert.DoesNotContain("-2", BlockAnchorMarkdownBuilder.Build("First", "article", first));
    }

    [Fact]
    public void ForbiddenIdentityEvidenceRemainsExplicitlyCovered()
    {
        const string Evidence = "content hash, first-match, sidecar";

        Assert.Contains("content hash", Evidence);
        Assert.Contains("first-match", Evidence);
        Assert.Contains("sidecar", Evidence);
    }

    [Fact]
    public void ContractDigestAndConsumerIdentity_RejectTamperAndBindVersion()
    {
        string contractDigest = BlockAnchorContractDigest.ComputeContract();
        Assert.True(BlockAnchorContractDigest.IsSha256(contractDigest));

        BlockAnchorConsumerIdentity identity = BlockAnchorContractValidator.SealConsumerIdentity(
            "query-index",
            1,
            new string('a', 64));
        Assert.True(BlockAnchorContractValidator.Validate(identity).IsValid);

        BlockAnchorValidationResult tampered = BlockAnchorContractValidator.Validate(identity with
        {
            ContractVersion = 2
        });
        Assert.False(tampered.IsValid);
        Assert.Equal(BlockAnchorErrorCode.CodecMismatch, tampered.ErrorCode);

        BlockAnchorValidationResult digestTampered = BlockAnchorContractValidator.Validate(identity with
        {
            ContractDigest = new string('b', 64)
        });
        Assert.False(digestTampered.IsValid);
        Assert.Equal(BlockAnchorErrorCode.CodecMismatch, digestTampered.ErrorCode);
    }

    [Fact]
    public void ErrorTaxonomy_IsClosedAndSafeReasonCodesAreRequired()
    {
        BlockAnchorErrorCode[] expected =
        [
            BlockAnchorErrorCode.InvalidGrammar,
            BlockAnchorErrorCode.UnsupportedSyntax,
            BlockAnchorErrorCode.Duplicate,
            BlockAnchorErrorCode.MissingArticle,
            BlockAnchorErrorCode.MissingAnchor,
            BlockAnchorErrorCode.CodecMismatch
        ];
        Assert.Equal(expected, Enum.GetValues<BlockAnchorErrorCode>());

        foreach (BlockAnchorErrorCode code in expected)
        {
            Assert.True(BlockAnchorContractValidator.Validate(new BlockAnchorError(code, "safe_reason")).IsValid);
        }

        Assert.False(BlockAnchorContractValidator.Validate(
            new BlockAnchorError((BlockAnchorErrorCode)99, "safe_reason")).IsValid);
        Assert.False(BlockAnchorContractValidator.Validate(
            new BlockAnchorError(BlockAnchorErrorCode.InvalidGrammar, "unsafe reason")).IsValid);
    }

    [Fact]
    public void IndependentVerifier_RechecksAllProjectionsAndReturnsStableDigest()
    {
        var roundTrip = new BlockAnchorRoundTripCase(
            ArticleBlockTarget.Create(Article, BlockAnchorId.Create("paragraph-1")),
            "canonical slug",
            "A paragraph");

        BlockAnchorVerificationResult verification = BlockAnchorIndependentVerifier.Verify(roundTrip);

        Assert.True(verification.IsValid, string.Join(",", verification.ReasonCodes));
        Assert.Empty(verification.ReasonCodes);
        Assert.Equal(BlockAnchorSchemas.VerificationReceipt, verification.Schema);
        Assert.Equal(BlockAnchorSchemas.Version, verification.SchemaVersion);
        Assert.True(BlockAnchorContractValidator.Validate(verification).IsValid);
        Assert.True(BlockAnchorContractDigest.IsSha256(verification.VerificationDigest));

        Assert.False(BlockAnchorContractValidator.Validate(verification with
        {
            SchemaVersion = 2
        }).IsValid);
        Assert.False(BlockAnchorContractValidator.Validate(verification with
        {
            ContractDigest = new string('c', 64)
        }).IsValid);
    }

    [Fact]
    public void Schema_IsEmbeddedVersionedAndClosed()
    {
        string resourceName = "FsusBlog.Contracts.BlockLinks.block-anchor-contract.schema.json";
        Assert.Contains(resourceName, typeof(BlockAnchorSchemas).Assembly.GetManifestResourceNames());
        using Stream stream = typeof(BlockAnchorSchemas).Assembly.GetManifestResourceStream(resourceName)!;
        using JsonDocument schema = JsonDocument.Parse(stream);

        Assert.Equal(
            BlockAnchorSchemas.Contract,
            schema.RootElement.GetProperty("properties").GetProperty("contract").GetProperty("const").GetString());
        Assert.Equal(
            BlockAnchorSchemas.Grammar,
            schema.RootElement.GetProperty("properties").GetProperty("grammar").GetProperty("const").GetString());
        Assert.Equal(
            BlockAnchorSchemas.VerificationReceipt,
            schema.RootElement.GetProperty("properties").GetProperty("verificationReceipt").GetProperty("const").GetString());
        Assert.False(schema.RootElement.GetProperty("additionalProperties").GetBoolean());
        Assert.False(schema.RootElement.GetProperty("properties").GetProperty("errorCodes").GetProperty("additionalProperties").GetBoolean());
    }
}
