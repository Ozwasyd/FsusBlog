using static FsusBlog.V2.Core.Authoring.CanvasAnchorState;

public sealed class CanvasAnchorTests
{
    private static CanvasAnchorResolution Find(string source, string id = "id", bool heading = false) => CanvasAnchor.Find(source, id, heading);
    private static CanvasAnchorState State(string source, string id = "id", bool heading = false) => Find(source, id, heading).State;

    [Theory]
    [InlineData("A paragraph ^p\n", "p", "A paragraph")]
    [InlineData("## Heading text ^h\n", "h", "Heading text")]
    [InlineData("- first item ^item\n- second item", "item", "- first item")]
    [InlineData("> quoted line ^q\n", "q", "› quoted line")]
    [InlineData("| alpha | beta | ^row\n", "row", "| alpha | beta |")]
    [InlineData("| alpha | beta |\n| --- | --- |\n| 1 | 2 |\n^table\n", "table", "| 1 | 2 |")]
    [InlineData("```ts\nconst value = 1\n```\n^code\n", "code", "const value = 1")]
    [InlineData("```mermaid\nflowchart LR\n```\n^diagram\n", "diagram", "flowchart LR")]
    [InlineData("$$\nx^{2}\n$$\n^formula\n", "formula", "x^{2}")]
    [InlineData("::embed[target=\"safe-doc\" mode=\"block\"]\n^embedded\n", "embedded", "::embed[target=\"safe-doc\" mode=\"block\"]")]
    [InlineData("::caption[figure one]\n^captioned\n", "captioned", "::caption[figure one]")]
    [InlineData(":::note\nbody\n:::\n^noted\n", "noted", "body")]
    public void SupportsTheFsusUiOwningBlockMatrix(string source, string id, string excerpt)
    {
        Assert.Equal(new(Resolved, excerpt, source.IndexOf($"^{id}", StringComparison.Ordinal)), Find(source, id));
    }

    [Theory]
    [InlineData("^id")]
    [InlineData("\n\n^id")]
    [InlineData("Paragraph\n^id")]
    [InlineData("^unattached ^id")]
    [InlineData("```\ncode\n```\n\n^id")]
    [InlineData("paragraph\t^id")]
    [InlineData("paragraph ^id ")]
    [InlineData("paragraph ^id\u2028next")]
    [InlineData("paragraph ^id-")]
    [InlineData("paragraph ^ID")]
    [InlineData("paragraph ^id/tampered")]
    [InlineData("paragraph \\^id")]
    [InlineData("paragraph #^id")]
    [InlineData("paragraph {#id}")]
    [InlineData("<b id=\"id\">text</b>")]
    [InlineData("paragraph ^id ^last")]
    public void NoncanonicalAndOwnerlessMarkersAreNotResolved(string source) =>
        Assert.Equal(new(Missing, null, null), Find(source));

    [Theory]
    [InlineData("```ts ^id\ninside ^id\n```\n")]
    [InlineData("  ~~~~~\ninside ^id\n~~~~\nstill inside ^id\n~~~~~~\n")]
    [InlineData("```\ninside ^id\n~~~\nstill inside ^id")]
    [InlineData("$$\ninside ^id\n$$\n")]
    [InlineData(":::quote\ninside ^id\n:::\n")]
    [InlineData("::::long\ninside ^id\n:::\n")]
    public void MarkersInLiteralRegionsDoNotParticipateInDuplicateCheck(string literal)
    {
        Assert.Equal(Missing, State(literal));
        var source = $"{literal}\nPlain note ^id\n";
        var result = Find(source);
        if (literal.EndsWith("still inside ^id", StringComparison.Ordinal)) Assert.Equal(Missing, result.State);
        else Assert.Equal(new(Resolved, "Plain note", source.LastIndexOf("^id", StringComparison.Ordinal)), result);
    }

    [Theory]
    [InlineData("$$\nMathematics ^id\n")]
    [InlineData(":::quote\nQuote ^id\n")]
    public void MalformedNonFenceOpenerKeepsTheFsusUiLineGrammar(string source) => Assert.Equal(Resolved, State(source));

    [Fact]
    public void ClosedInnerFormulaIsLiteralEvenAfterAnUnclosedContainer()
    {
        const string source = ":::note\n$$\nformula ^id\n$$\nOrdinary text ^id";
        Assert.Equal(new(Resolved, "Ordinary text", source.LastIndexOf("^id", StringComparison.Ordinal)), Find(source));
    }

    [Fact]
    public void SingleSpaceFollowingLinePreservesTheCurrentParserBehavior()
    {
        Assert.Equal(new(Resolved, "", 1), Find(" ^id"));
        Assert.Equal(Missing, State(" ^id", heading: true));
        Assert.Equal(Missing, State("  ^id"));
    }

    [Fact]
    public void AmbiguousAnchorCannotResolveEvenIfOnlyOneClaimOwnsAHeading()
    {
        const string source = "Notes ^dup\n\n# Title ^dup";
        Assert.Equal(new(Duplicate, null, null), Find(source, "dup"));
        Assert.Equal(new(Duplicate, null, null), Find(source, "dup", true));
    }

    [Theory]
    [InlineData("# Heading ^id", true)]
    [InlineData("###### Heading ^id", true)]
    [InlineData("#\tHeading ^id", true)]
    [InlineData("####### Heading ^id", false)]
    [InlineData("  # Nested ^id", false)]
    [InlineData("Heading ^id\n======", false)]
    [InlineData("Paragraph ^id", false)]
    [InlineData("# ^id", false)]
    [InlineData("## Heading\n ^id", true)]
    public void HeadingRequiresTheV1AtxOwnershipRule(string source, bool expected) =>
        Assert.Equal(expected ? Resolved : Missing, State(source, heading: true));

    [Fact]
    public void CaretOffsetsUseTheExactUtf16SourceIncludingCrlfAndAstralCharacters()
    {
        const string source = "\uFEFFFirst 🐈\r\n\r\n# Heading 🧭 ^location\r\nTrailing";
        var expected = source.IndexOf("^location", StringComparison.Ordinal);
        var result = Find(source, "location", true);
        Assert.Equal(new(Resolved, "Heading 🧭", expected), result);
        Assert.Equal("^location", source.Substring(result.SourceOffset!.Value, "^location".Length));
        Assert.NotEqual(expected, Encoding.UTF8.GetByteCount(source[..expected]));
    }

    [Fact]
    public void EscapeSensitiveExcerptIsPlainBoundedWellFormedText()
    {
        Assert.Equal("‹tag›  visible", Find("# <tag>\u202E\u0001visible ^id", heading: true).Excerpt);
        var extent = new string('界', CanvasAnchor.MaxExcerptCharacters - 1) + "🐈extra ^id";
        var excerpt = Assert.IsType<string>(Find(extent).Excerpt);
        Assert.Equal(CanvasAnchor.MaxExcerptCharacters - 1, excerpt.Length);
        Assert.True(new UTF8Encoding(false, true).GetByteCount(excerpt) <= 768);
    }

    [Fact]
    public void BoundsAndCancellationDoNotSilentlyReadAPrefix()
    {
        const string suffix = " ^id";
        var exactLimit = new string('x', CanvasAnchor.MaxSourceCharacters - suffix.Length) + suffix;
        Assert.Equal(Resolved, State(exactLimit));
        Assert.Equal(Missing, State(exactLimit + '\n'));
        foreach (var badId in new[] { "ID", "#id", "a" + new string('x', 64) }) Assert.Equal(Missing, State("text ^id", badId));
        var longest = "a" + new string('x', 63);
        Assert.Equal(Resolved, State("text ^" + longest, longest));
        Assert.Throws<OperationCanceledException>(() => CanvasAnchor.Find(exactLimit, "id", false, new(canceled: true)));
    }
}
