public sealed class AuthorTextProfileTests
{
    [Fact]
    public void FoldedTermsKeepTheRawUtf16AndUtf8GraphemeBounds()
    {
        const string source = "\ufeffCafe\u0301\r\n中文-𠀀 선가 👩🏽‍💻 🇺🇸 *️⃣";
        var terms = AuthorTextProfile.Tokenize(source, CancellationToken.None).ToArray();

        Assert.Equal(new[] { "café", "中", "文", "𠀀", "선", "가", "👩🏽‍💻", "🇺🇸", "*️⃣" }, terms.Select(term => term.Value));
        Assert.Equal(new AuthorTextTerm("café", 0, 1, 6, 3, 9), terms[0]);
        Assert.Equal(new AuthorTextTerm("中", 1, 8, 9, 11, 14), terms[1]);
        var raw = new[] { "Cafe\u0301", "中", "文", "𠀀", "선", "가", "👩🏽‍💻", "🇺🇸", "*️⃣" };
        var boundaries = System.Globalization.StringInfo.ParseCombiningCharacters(source).Append(source.Length).ToHashSet();
        var bytes = Encoding.UTF8.GetBytes(source);
        for (var i = 0; i < terms.Length; i++)
        {
            var term = terms[i];
            Assert.Equal(i, term.Ordinal);
            Assert.Contains(term.Start, boundaries);
            Assert.Contains(term.End, boundaries);
            Assert.Equal(raw[i], source[term.Start..term.End]);
            Assert.Equal(raw[i], Encoding.UTF8.GetString(bytes[term.ByteStart..term.ByteEnd]));
            Assert.Equal(Encoding.UTF8.GetByteCount(source.AsSpan(0, term.Start)), term.ByteStart);
        }
    }

    [Fact]
    public void WordsFoldByUnicode17AndPunctuationSeparatesNonCjkRuns()
    {
        var source = "Café CAFÉ ＡLPHA A Слово سَلَام １２-three's";
        var terms = AuthorTextProfile.Tokenize(source, CancellationToken.None).Select(term => term.Value);
        Assert.Equal(new[] { "café", "café", "ａlpha", "a", "слово", "سَلَام", "１２", "three", "s" }, terms);
        Assert.Equal("café", Assert.Single(AuthorTextProfile.Parse("Cafe\u0301 CAFÉ Café").Terms));
    }

    [Fact]
    public void CaseFoldDataMatchesTheOfficialUnicode17Source()
    {
        using var resource = typeof(AuthorTextProfile).Assembly.GetManifestResourceStream(AuthorTextProfile.CaseFoldingResource);
        Assert.NotNull(resource);
        Assert.Equal("ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183",
            Convert.ToHexStringLower(SHA256.HashData(resource)));
    }

    [Theory]
    [InlineData("Σςσ", "σσσ")]
    [InlineData("ΟΣ", "οσ")]
    [InlineData("ßẞSS", "ßßss")]
    [InlineData("İIıi", "İiıi")]
    [InlineData("I\u0307", "İ")]
    [InlineData("ＡA", "ａa")]
    [InlineData("Cafe\u0301", "café")]
    [InlineData("H\u0331", "\u1e96")]
    [InlineData("\U00016ea0", "\U00016ebb")]
    public void NormalizationUsesOnlyDefaultSimpleMappings(string raw, string normalized)
    {
        Assert.Equal(normalized, AuthorTextProfile.NormalizeTerm(raw));
    }

    [Fact]
    public void BareTermsAreAnIntersectionAndQuotedTermsKeepTheirSequence()
    {
        var bare = AuthorTextProfile.Parse("  代码, release-notes 代码  ");
        Assert.False(bare.Phrase);
        Assert.Equal(new[] { "代", "码", "release", "notes" }, bare.Terms);

        var phrase = AuthorTextProfile.Parse(" \"code, code 中文 👩‍💻\" ");
        Assert.True(phrase.Phrase);
        Assert.Equal(new[] { "code", "code", "中", "文", "👩‍💻" }, phrase.Terms);
        Assert.Equal(new[] { "*️⃣", "1️⃣" }, AuthorTextProfile.Parse("*️⃣ 1️⃣").Terms);
        Assert.Equal(new[] { "title", "or", "value" }, AuthorTextProfile.Parse("\"title: OR/value\"").Terms);
        Assert.Equal(new[] { "bread", "and", "butter" }, AuthorTextProfile.Parse("bread and butter").Terms);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\rvalue")]
    [InlineData("\"\"")]
    [InlineData("\"left\" right")]
    [InlineData("\"left\" \"right\"")]
    [InlineData("\"unclosed")]
    [InlineData("\"escaped\\\" quote\"")]
    [InlineData("title:foo")]
    [InlineData("title:\u0301foo")]
    [InlineData("/(?:foo)/u")]
    [InlineData("foo AND bar")]
    [InlineData("foo OR, bar")]
    [InlineData("NOT foo")]
    [InlineData("foo NEAR bar")]
    [InlineData("foo | bar")]
    [InlineData("foo - bar")]
    [InlineData("foo -bar")]
    [InlineData("foo !bar")]
    [InlineData("foo +bar")]
    [InlineData("foo.*")]
    [InlineData("one two three four five six seven eight nine")]
    [InlineData("x x x x x x x x x")]
    public void UnsupportedAndUnboundedQueriesFailClosed(string query)
    {
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Parse(query));
    }

    [Fact]
    public void NormalizedQueryOperandBudgetDoesNotChangeSourceOrdinals()
    {
        // Devanagari QA has canonical decomposition to KA followed by NUKTA.
        var within = new string('\u0958', 85);
        var oversized = new string('\u0958', 86);
        Assert.Equal(510, Encoding.UTF8.GetByteCount(Assert.Single(AuthorTextProfile.Parse(within).Terms)));
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Parse(oversized));
        var terms = AuthorTextProfile.Tokenize("before " + oversized + " after", CancellationToken.None).ToArray();
        Assert.Equal(516, Encoding.UTF8.GetByteCount(terms[1].Value));
        Assert.Equal(new[] { 0, 1, 2 }, terms.Select(term => term.Ordinal));
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Parse(new string('x', 129)));
    }

    [Fact]
    public void SourceBudgetUnicodeAndCancellationAreChecked()
    {
        var source = new string('中', AuthorTextProfile.MaxSourceChars);
        var terms = AuthorTextProfile.Tokenize(source, CancellationToken.None);
        Assert.Equal(AuthorTextProfile.MaxTerms, terms.Count());
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Tokenize(source + "文", CancellationToken.None).ToArray());

        var invalid = new string('\ud800', 1);
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Parse(invalid));
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Tokenize("a " + invalid, CancellationToken.None).First());

        using var stopped = new CancellationTokenSource();
        using var enumerator = AuthorTextProfile.Tokenize("a b c", stopped.Token).GetEnumerator();
        Assert.True(enumerator.MoveNext());
        stopped.Cancel();
        Assert.Throws<OperationCanceledException>(() => enumerator.MoveNext());
    }

    [Fact]
    public void RankedFieldPrefixesAndPhrasesComposeWithoutLosingLexicalGroups()
    {
        var query = AuthorTextProfile.ParseRanked("""
            release field.title:RELEASE-notes-Release "code, code" field.markdown-body:"中 \\ \"Quoted\""
            """);
        Assert.Collection(query.Clauses,
            clause => AssertClause(clause, AuthorTextField.Any, false, "release"),
            clause => AssertClause(clause, AuthorTextField.Title, false, "release", "notes"),
            clause => AssertClause(clause, AuthorTextField.Any, true, "code", "code"),
            clause => AssertClause(clause, AuthorTextField.MarkdownBody, true, "中", "quoted"));
    }

    [Fact]
    public void RankedQueriesDeduplicateIdenticalClausesAndKeepDistinctScopes()
    {
        var query = AuthorTextProfile.ParseRanked(" blue-green , BLUE-green \"left\" \"left\" field.title:left field.markdown-body:left ");
        Assert.Collection(query.Clauses,
            clause => AssertClause(clause, AuthorTextField.Any, false, "blue", "green"),
            clause => AssertClause(clause, AuthorTextField.Any, true, "left"),
            clause => AssertClause(clause, AuthorTextField.Title, false, "left"),
            clause => AssertClause(clause, AuthorTextField.MarkdownBody, false, "left"));

        var punctuation = AuthorTextProfile.ParseRanked("*️⃣ bread and butter \"title: OR/value\"");
        AssertClause(punctuation.Clauses[0], AuthorTextField.Any, false, "*️⃣");
        AssertClause(punctuation.Clauses[2], AuthorTextField.Any, false, "and");
        AssertClause(punctuation.Clauses[^1], AuthorTextField.Any, true, "title", "or", "value");
    }

    [Theory]
    [InlineData("")]
    [InlineData(" , . ")]
    [InlineData("\rvalue")]
    [InlineData("\"\"")]
    [InlineData("\"left\"right")]
    [InlineData("left\"right\"")]
    [InlineData("\"left\"\"right\"")]
    [InlineData("\"unclosed")]
    [InlineData("\"invalid \\n escape\"")]
    [InlineData("left\\right")]
    [InlineData("foo \".\" bar")]
    [InlineData("title:foo")]
    [InlineData("Field.title:foo")]
    [InlineData("field.body:foo")]
    [InlineData("field.summary:foo")]
    [InlineData("field.title: foo")]
    [InlineData("field.title:")]
    [InlineData("field.title:.")]
    [InlineData("field.title:\"left\"right")]
    [InlineData("field.title:foo field.title:\"bar baz\"")]
    [InlineData("field.markdown-body:foo field.markdown-body:bar")]
    [InlineData("field.markdown-body:AND")]
    [InlineData("status:published")]
    [InlineData("updated-at.before:2026-01-01")]
    [InlineData("property:priority")]
    [InlineData("/(?:foo)/u")]
    [InlineData("foo OR, bar")]
    [InlineData("foo NEAR bar")]
    [InlineData("foo -bar")]
    [InlineData("foo.*")]
    [InlineData("x x x x x x x x x")]
    [InlineData("foo$")]
    [InlineData("field.title:x-x-x-x field.markdown-body:\"x x\" \"x x x\"")]
    public void UnsupportedAndUnboundedRankedQueriesFailClosed(string query)
    {
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseRanked(query));
    }

    [Fact]
    public void RankedLimitsCountTheRawPrefixAndTheNormalizedOperandBytes()
    {
        const string prefix = "field.title:";
        var value = new string('x', WireLimits.AuthorTextSearchQueryChars - prefix.Length);
        AssertClause(Assert.Single(AuthorTextProfile.ParseRanked(prefix + value).Clauses), AuthorTextField.Title, false, value);
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseRanked(prefix + value + 'x'));
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseRanked(prefix + new string('\u0958', 86)));
    }

    [Fact]
    public void FacetsPreserveTheFieldScopedTextAndRemainOutsideItsTokenBudget()
    {
        var query = AuthorTextProfile.ParseFaceted("category:0042 field.title:Release status:published field.markdown-body:\"source map\" tag:2147483647");
        Assert.Equal(AuthorArticleState.Published, query.Status);
        Assert.Equal(42, query.CategoryId);
        Assert.Equal(int.MaxValue, query.TagId);
        Assert.Collection(query.Text.Clauses,
            clause => AssertClause(clause, AuthorTextField.Title, false, "release"),
            clause => AssertClause(clause, AuthorTextField.MarkdownBody, true, "source", "map"));

        var atTokenLimit = AuthorTextProfile.ParseFaceted("x x x x x x x x status:draft category:7 tag:42");
        AssertClause(Assert.Single(atTokenLimit.Text.Clauses), AuthorTextField.Any, false, "x");
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseFaceted("x x x x x x x x x status:draft"));
        const string prefix = "status:draft ";
        var atRawLimit = new string('x', WireLimits.AuthorTextSearchQueryChars - prefix.Length);
        AssertClause(Assert.Single(AuthorTextProfile.ParseFaceted(prefix + atRawLimit).Text.Clauses), AuthorTextField.Any, false, atRawLimit);
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseFaceted(prefix + atRawLimit + 'x'));
    }

    [Theory]
    [InlineData("draft", AuthorArticleState.Draft)]
    [InlineData("scheduled", AuthorArticleState.Scheduled)]
    [InlineData("published", AuthorArticleState.Published)]
    [InlineData("retracted", AuthorArticleState.Retracted)]
    public void OnlyExplicitlyFacetedQueriesAdmitTheSupportedStatusWords(string name, AuthorArticleState expected)
    {
        var text = "status:" + name + " word";
        var faceted = AuthorTextProfile.ParseFaceted(text);
        Assert.Equal(expected, faceted.Status);
        Assert.Null(faceted.CategoryId);
        Assert.Null(faceted.TagId);
        AssertClause(Assert.Single(faceted.Text.Clauses), AuthorTextField.Any, false, "word");
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseRanked(text));
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.Parse(text));
    }

    [Fact]
    public void QuotedTextContainingFacetSyntaxIsStillText()
    {
        var faceted = AuthorTextProfile.ParseFaceted("\"status:draft\"");
        Assert.Null(faceted.Status);
        Assert.Null(faceted.CategoryId);
        Assert.Null(faceted.TagId);
        AssertClause(Assert.Single(faceted.Text.Clauses), AuthorTextField.Any, true, "status", "draft");
    }

    [Theory]
    [InlineData("status:draft category:2 tag:3")]
    [InlineData("status:draft , .")]
    [InlineData("status:archived word")]
    [InlineData("status:deleted word")]
    [InlineData("status:Draft word")]
    [InlineData("status:\"draft\" word")]
    [InlineData("status: draft word")]
    [InlineData("status:draft status:published word")]
    [InlineData("category:2 category:02 word")]
    [InlineData("tag:3 tag:3 word")]
    [InlineData("category:\"42\" word")]
    [InlineData("tag:0 word")]
    [InlineData("category:+1 word")]
    [InlineData("tag:-1 word")]
    [InlineData("category:2147483648 word")]
    [InlineData("tag:١ word")]
    [InlineData("category:1.0 word")]
    [InlineData("word tag:")]
    [InlineData("word updated-at.before:2026-01-01")]
    [InlineData("word property:priority")]
    [InlineData("word Tag:42")]
    public void InvalidOrFilterOnlyFacetedQueriesFailClosed(string query)
    {
        Assert.Throws<ProtocolException>(() => AuthorTextProfile.ParseFaceted(query));
    }

    private static void AssertClause(AuthorTextClause clause, AuthorTextField field, bool phrase, params string[] terms)
    {
        Assert.Equal(field, clause.Field);
        Assert.Equal(phrase, clause.Phrase);
        Assert.Equal(terms, clause.Terms);
    }
}
