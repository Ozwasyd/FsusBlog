using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Authoring;

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
}
