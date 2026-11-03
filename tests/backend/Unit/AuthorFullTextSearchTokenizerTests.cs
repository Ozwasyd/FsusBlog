using System.Collections.Immutable;
using System.Globalization;
using System.Text;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchTokenizerTests
{
    [Theory]
    [InlineData("CAFÉ cafe\u0301", "café|café")]
    [InlineData("ПРИВЕТ мир", "привет|мир")]
    [InlineData("中文日本語 한글", "中|文|日|本|語|한|글")]
    [InlineData("👩‍💻 👨‍👩‍👧‍👦 👍🏽 1️⃣", "👩‍💻|👨‍👩‍👧‍👦|👍🏽|1️⃣")]
    [InlineData("العَرَبِيَّة שלום", "العَرَبِيَّة|שלום")]
    [InlineData("Σ ς σ K K İ I ı", "σ|σ|σ|k|k|İ|i|ı")]
    [InlineData("\uFEFFHello\r\nworld!", "hello|world")]
    [InlineData("a,b.c: d/e", "a|b|c|d|e")]
    public void Tokenize_Preserves_Source_Order_And_Normalization(string source, string expected)
    {
        ImmutableArray<AuthorSearchToken> tokens = Tokenize(source);
        Assert.Equal(expected, string.Join('|', tokens.Select(static token => token.Term)));
        Assert.Equal(Enumerable.Range(0, tokens.Length), tokens.Select(static token => token.Position));
        int previousEnd = 0;
        foreach (AuthorSearchToken token in tokens)
        {
            AuthorFullTextSearchContract.ValidateRange(token.Source, source, "canonical-parser", "document:1");
            Assert.True(token.Source.Utf16Start >= previousEnd);
            Assert.True(token.Source.Utf16End > token.Source.Utf16Start);
            previousEnd = token.Source.Utf16End;
        }
    }

    [Fact]
    public void Tokenize_Maps_Composed_Term_To_Original_Decomposed_Span()
    {
        string source = "👩‍💻 cafe\u0301\r\n中";
        AuthorSearchToken token = Tokenize(source)[1];
        Assert.Equal("café", token.Term);
        Assert.Equal("cafe\u0301", source[token.Source.Utf16Start..token.Source.Utf16End]);
        Assert.Equal(Encoding.UTF8.GetBytes("cafe\u0301"),
            Encoding.UTF8.GetBytes(source)[token.Source.Utf8Start..token.Source.Utf8End]);
    }

    [Fact]
    public void Tokenize_Uses_Exact_Field_Range_And_Rejects_Partial_Grapheme()
    {
        string source = "before cafe\u0301 after";
        AuthorSearchSourceRange range = Range(source, 7, 12);
        Assert.Equal("café", Assert.Single(AuthorFullTextSearchTokenizer.Tokenize(
            source, range, "canonical-parser", "document:1")).Term);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.Tokenize(
            source, Range(source, 7, 11), "canonical-parser", "document:1"));
    }

    [Fact]
    public void Tokenize_Is_Culture_Independent_And_Does_Not_Remove_Diacritics()
    {
        CultureInfo previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("tr-TR");
            Assert.Equal("i|ı|café|cafe", string.Join('|', Tokenize("I ı CAFÉ cafe").Select(static token => token.Term)));
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
    }

    [Fact]
    public void Tokenize_Rejects_Drift_Tamper_Invalid_Unicode_And_Budgets()
    {
        string source = "secret";
        AuthorSearchSourceRange range = Range(source, 0, source.Length);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.Tokenize(
            source, range with
            {
                Authority = "public-search-index"
            }, "canonical-parser", "document:1"));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.Tokenize(
            source, range, "other-parser", "document:1"));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.Tokenize(
            source, range, "canonical-parser", "other-document"));
        Assert.Throws<AuthorSearchContractException>(() => Tokenize("\uD800"));
        Assert.Throws<AuthorSearchContractException>(() => Tokenize(
            new string('a', AuthorFullTextSearchTokenizer.MaxSourceCharacters + 1)));
        Assert.Throws<AuthorSearchContractException>(() => Tokenize(
            new string('中', AuthorFullTextSearchTokenizer.MaxTokens + 1)));
    }

    [Fact]
    public void Tokenize_Empty_And_Large_Word_Have_Bounded_Output()
    {
        Assert.Empty(Tokenize(string.Empty));
        string source = new('a', AuthorFullTextSearchTokenizer.MaxSourceCharacters);
        AuthorSearchToken token = Assert.Single(Tokenize(source));
        Assert.Equal(source.Length, token.Term.Length);
        Assert.Equal(source.Length, token.Source.Utf16End);
    }

    private static ImmutableArray<AuthorSearchToken> Tokenize(string source)
        => AuthorFullTextSearchTokenizer.Tokenize(source, Range(source, 0, source.Length),
            "canonical-parser", "document:1");

    private static AuthorSearchSourceRange Range(string source, int start, int end)
        => new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "canonical-parser", "document:1", 1,
            AuthorFullTextSearchContract.Digest(source), start, end,
            Encoding.UTF8.GetByteCount(source.AsSpan(0, start)), Encoding.UTF8.GetByteCount(source.AsSpan(0, end)));
}
