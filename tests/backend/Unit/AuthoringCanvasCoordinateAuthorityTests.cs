using FsusBlog.Server.Services.Authoring;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasCoordinateAuthorityTests
{
    private const string CanvasDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly AuthoringCanvasOwner s_owner = new(61, "primary-site");

    [Fact]
    public void Scan_ResolvesLineEndHeadingAndBlockAnchorsWithBoundedContext()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "# Overview ^doc-head\n\nIntro paragraph ^intro-block\n");

        AuthoringCanvasAnchorObservation heading = Assert.Single(anchors.Values, static value => value.OwnsHeading);
        Assert.Equal("doc-head", anchors.Single(pair => pair.Value == heading).Key);
        Assert.Equal(1, heading.ClaimCount);
        Assert.Equal("Overview", heading.ContextText);

        AuthoringCanvasAnchorObservation block = anchors["intro-block"];
        Assert.Equal(1, block.ClaimCount);
        Assert.False(block.OwnsHeading);
        Assert.Equal("Intro paragraph", block.ContextText);
    }

    [Fact]
    public void Scan_ResolvesExclusiveLineAnchorsOnlyAfterAtomicOwners()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "| a | b |\n^tbl-anchor\n\nparagraph\n^para-orphan\n\n```csharp\nvar x = 1;\n```\n^code-anchor\n");

        Assert.True(anchors["tbl-anchor"].ClaimCount == 1);
        Assert.Equal("| a | b |", anchors["tbl-anchor"].ContextText);
        Assert.True(anchors["code-anchor"].ClaimCount == 1);
        Assert.Equal("var x = 1;", anchors["code-anchor"].ContextText);
        Assert.False(anchors.ContainsKey("para-orphan"));
    }

    [Fact]
    public void Scan_IgnoresMarkersInsideFencedOrphanAndMalformedPositions()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "^orphan-first\n\n```\n^inside-fence\n```\n\n## Heading\n^after-heading\n\ntext\n\n^after-gap\n");

        Assert.Empty(anchors);
    }

    [Fact]
    public void Scan_CountsRepeatedClaimsInsteadOfFirstMatching()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "First ^dup-anchor\n\nSecond ^dup-anchor\n");

        Assert.Equal(2, anchors["dup-anchor"].ClaimCount);
    }

    [Fact]
    public void Scan_TreatsInvalidGrammarAndMidTextMarkersAsNonAnchors()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "x ^Upper-Case\n\ny^not-marker\n\nz ^x\n");

        Assert.False(anchors.ContainsKey("Upper-Case"));
        Assert.False(anchors.ContainsKey("not-marker"));
        Assert.True(anchors["x"].ClaimCount == 1);
    }

    [Fact]
    public void Scan_AcceptsSingleSpaceExclusiveMarkerAndHeadingOwner()
    {
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                "## Named ^space-anchor\n\npara\r\n## Next\r\n ^crlf-anchor\r\n");

        Assert.True(anchors["space-anchor"].ClaimCount == 1);
        Assert.True(anchors["crlf-anchor"].OwnsHeading);
        Assert.Equal("Next", anchors["crlf-anchor"].ContextText);
    }

    [Fact]
    public void Scan_BoundsContextSnippetAndDropsMarkupPayload()
    {
        string longText = new('x', AuthoringCanvasReferenceContract.MaxContextSnippetLength + 40);
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> anchors =
            AuthoringCanvasAnchorSourceProjection.Scan(
                $"{longText} ^long-anchor\n\nvalue <script> ^html-anchor\n");

        Assert.Equal(
            AuthoringCanvasReferenceContract.MaxContextSnippetLength,
            anchors["long-anchor"].ContextText!.Length);
        Assert.True(anchors["html-anchor"].ClaimCount == 1);
        Assert.Null(anchors["html-anchor"].ContextText);
    }

    [Fact]
    public async Task Authority_RejectsInvalidQueryShapesBeforeAnyRead()
    {
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(Substitute.For<ISqlSugarClient>());

        await Assert.ThrowsAsync<ArgumentNullException>(() => authority.ReadBatchAsync(null!));

        AuthoringCanvasReferenceTarget[] oversized = Enumerable
            .Range(0, AuthoringCanvasReferenceContract.MaxBatchSize + 1)
            .Select(index => Target(AuthoringCanvasNodeType.BlockReference, block: $"b-{index}"))
            .ToArray();
        await Assert.ThrowsAsync<AuthoringCanvasBudgetExceededException>(
            () => authority.ReadBatchAsync(Query(oversized)));

        AuthoringCanvasValidationException articleNode = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query([Target(AuthoringCanvasNodeType.ArticleReference)])));
        Assert.Equal("canvas_reference_coordinate_query_invalid", articleNode.Code);

        var wrongShape = new AuthoringCanvasReferenceTarget(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.HeadingReference,
            101,
            null,
            "b-1",
            null,
            null);
        AuthoringCanvasValidationException wrongIdentity = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query([wrongShape])));
        Assert.Equal("canvas_reference_coordinate_query_invalid", wrongIdentity.Code);

        Guid duplicateId = Guid.CreateVersion7();
        AuthoringCanvasReferenceTarget[] duplicated =
        [
            Target(AuthoringCanvasNodeType.BlockReference, duplicateId, "b-1"),
            Target(AuthoringCanvasNodeType.BlockReference, duplicateId, "b-2")
        ];
        AuthoringCanvasValidationException duplicate = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => authority.ReadBatchAsync(Query(duplicated)));
        Assert.Equal("canvas_reference_coordinate_query_invalid", duplicate.Code);
    }

    [Fact]
    public async Task Authority_ReturnsEmptyForEmptyTargetsWithoutIssuingReads()
    {
        var authority = new PostgresAuthoringCanvasCoordinateAuthority(Substitute.For<ISqlSugarClient>());

        IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact> facts =
            await authority.ReadBatchAsync(Query([]));

        Assert.Empty(facts);
    }

    private static AuthoringCanvasReferenceTarget Target(
        AuthoringCanvasNodeType nodeType,
        string? heading = null,
        string? block = null)
        => Target(nodeType, Guid.CreateVersion7(), heading ?? block);

    private static AuthoringCanvasReferenceTarget Target(
        AuthoringCanvasNodeType nodeType,
        Guid nodeId,
        string? identity)
        => new(
            nodeId,
            nodeType,
            101,
            nodeType == AuthoringCanvasNodeType.HeadingReference ? identity : null,
            nodeType == AuthoringCanvasNodeType.BlockReference ? identity : null,
            null,
            null);

    private static AuthoringCanvasCoordinateFactQuery Query(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets)
        => new(
            Guid.CreateVersion7(),
            7,
            CanvasDigest,
            s_owner,
            targets);
}
