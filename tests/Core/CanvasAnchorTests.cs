public sealed class CanvasAnchorTests
{
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
        var result = CanvasAnchor.Find(source, id, false);

        Assert.Equal(CanvasAnchorState.Resolved, result.State);
        Assert.Equal(excerpt, result.Excerpt);
        Assert.Equal(source.IndexOf($"^{id}", StringComparison.Ordinal), result.SourceOffset);
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
    public void NoncanonicalAndOwnerlessMarkersAreNotResolved(string source)
    {
        Assert.Equal(new(CanvasAnchorState.Missing, null, null), CanvasAnchor.Find(source, "id", false));
    }

    [Theory]
    [InlineData("```ts ^id\ninside ^id\n```\n")]
    [InlineData("  ~~~~~\ninside ^id\n~~~~\nstill inside ^id\n~~~~~~\n")]
    [InlineData("```\ninside ^id\n~~~\nstill inside ^id")]
    [InlineData("$$\ninside ^id\n$$\n")]
    [InlineData(":::quote\ninside ^id\n:::\n")]
    [InlineData("::::long\ninside ^id\n:::\n")]
    public void MarkersInLiteralRegionsDoNotParticipateInDuplicateCheck(string literal)
    {
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find(literal, "id", false).State);
        var source = $"{literal}\nPlain note ^id\n";
        var result = CanvasAnchor.Find(source, "id", false);
        if (literal.EndsWith("still inside ^id", StringComparison.Ordinal))
            Assert.Equal(CanvasAnchorState.Missing, result.State);
        else
            Assert.Equal(new(CanvasAnchorState.Resolved, "Plain note", source.LastIndexOf("^id", StringComparison.Ordinal)), result);
    }

    [Theory]
    [InlineData("$$\nMathematics ^id\n")]
    [InlineData(":::quote\nQuote ^id\n")]
    public void MalformedNonFenceOpenerKeepsTheFsusUiLineGrammar(string source)
    {
        Assert.Equal(CanvasAnchorState.Resolved, CanvasAnchor.Find(source, "id", false).State);
    }

    [Fact]
    public void ClosedInnerFormulaIsLiteralEvenAfterAnUnclosedContainer()
    {
        const string source = ":::note\n$$\nformula ^id\n$$\nOrdinary text ^id";
        var expected = source.LastIndexOf("^id", StringComparison.Ordinal);
        Assert.Equal(new(CanvasAnchorState.Resolved, "Ordinary text", expected), CanvasAnchor.Find(source, "id", false));
    }

    [Fact]
    public void SingleSpaceFollowingLinePreservesTheCurrentParserBehavior()
    {
        const string source = " ^id";
        Assert.Equal(new(CanvasAnchorState.Resolved, "", 1), CanvasAnchor.Find(source, "id", false));
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find(source, "id", true).State);
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find("  ^id", "id", false).State);
    }

    [Fact]
    public void AmbiguousAnchorCannotResolveEvenIfOnlyOneClaimOwnsAHeading()
    {
        const string source = "Notes ^dup\n\n# Title ^dup";
        Assert.Equal(new(CanvasAnchorState.Duplicate, null, null), CanvasAnchor.Find(source, "dup", false));
        Assert.Equal(new(CanvasAnchorState.Duplicate, null, null), CanvasAnchor.Find(source, "dup", true));
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
    public void HeadingRequiresTheV1AtxOwnershipRule(string source, bool expected)
    {
        Assert.Equal(expected ? CanvasAnchorState.Resolved : CanvasAnchorState.Missing, CanvasAnchor.Find(source, "id", true).State);
    }

    [Fact]
    public void CaretOffsetsUseTheExactUtf16SourceIncludingCrlfAndAstralCharacters()
    {
        const string source = "\uFEFFFirst 🐈\r\n\r\n# Heading 🧭 ^location\r\nTrailing";
        var expected = source.IndexOf("^location", StringComparison.Ordinal);
        var result = CanvasAnchor.Find(source, "location", true);
        Assert.Equal(new(CanvasAnchorState.Resolved, "Heading 🧭", expected), result);
        Assert.Equal("^location", source.Substring(result.SourceOffset!.Value, "^location".Length));
        Assert.NotEqual(expected, Encoding.UTF8.GetByteCount(source[..expected]));
    }

    [Fact]
    public void EscapeSensitiveExcerptIsPlainBoundedWellFormedText()
    {
        var safe = CanvasAnchor.Find("# <tag>\u202E\u0001visible ^id", "id", true);
        Assert.Equal("‹tag›  visible", safe.Excerpt);

        string extent = new string('界', CanvasAnchor.MaxExcerptCharacters - 1) + "🐈extra ^id";
        var maxSize = CanvasAnchor.Find(extent, "id", false);
        Assert.NotNull(maxSize.Excerpt);
        Assert.Equal(CanvasAnchor.MaxExcerptCharacters - 1, maxSize.Excerpt.Length);
        var strictUtf8 = new UTF8Encoding(false, true);
        Assert.True(strictUtf8.GetByteCount(maxSize.Excerpt) <= 768);
    }

    [Fact]
    public void BoundsAndCancellationDoNotSilentlyReadAPrefix()
    {
        const string suffix = " ^id";
        var exactLimit = new string('x', CanvasAnchor.MaxSourceCharacters - suffix.Length) + suffix;
        Assert.Equal(CanvasAnchorState.Resolved, CanvasAnchor.Find(exactLimit, "id", false).State);
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find(exactLimit + '\n', "id", false).State);
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find("text ^id", "ID", false).State);
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find("text ^id", "#id", false).State);
        Assert.Equal(CanvasAnchorState.Missing, CanvasAnchor.Find("text ^id", "a" + new string('x', 64), false).State);
        var longest = "a" + new string('x', 63);
        Assert.Equal(CanvasAnchorState.Resolved, CanvasAnchor.Find("text ^" + longest, longest, false).State);
        Assert.Throws<OperationCanceledException>(() => CanvasAnchor.Find(exactLimit, "id", false, new(canceled: true)));
    }
}
