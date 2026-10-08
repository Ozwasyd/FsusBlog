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

    [Theory]
    [InlineData("中文 CAFÉ cafe\u0301 привет العربية 👩‍💻")]
    [InlineData("Σ ς σ K İ I ı")]
    [InlineData("a,b.c C++ 1️⃣")]
    public void Query_Value_Uses_The_One_Source_Tokenizer_Without_Forging_Source_Ranges(string text)
        => Assert.Equal(Tokenize(text).Select(static token => token.Term),
            AuthorFullTextSearchTokenizer.TokenizeQueryValue(text));

    [Fact]
    public void Query_Value_Rejects_Invalid_Unicode_And_Query_Budget()
    {
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.TokenizeQueryValue("\uD800"));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.TokenizeQueryValue(string.Empty));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.TokenizeQueryValue(
            new string('a', AuthorFullTextSearchContract.MaxQueryCharacters + 1)));
    }

    [Theory]
    [InlineData("İ", "I\u0307", false)]
    [InlineData("İ", "I\u0307", true)]
    [InlineData("ᾳ", "α\u0345", false)]
    [InlineData("ᾳ", "α\u0345", true)]
    [InlineData("한글", "\u1112\u1161\u11AB\u1100\u1173\u11AF", false)]
    [InlineData("한글", "\u1112\u1161\u11AB\u1100\u1173\u11AF", true)]
    public void Canonically_Equivalent_Reviewer_Inputs_Have_Identical_Terms(string nfc, string nfd, bool query)
    {
        Assert.Equal(nfc, nfd.Normalize(NormalizationForm.FormC));
        Assert.Equal(query ? AuthorFullTextSearchTokenizer.TokenizeQueryValue(nfc) : Tokenize(nfc).Select(t => t.Term),
            query ? AuthorFullTextSearchTokenizer.TokenizeQueryValue(nfd) : Tokenize(nfd).Select(t => t.Term));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Turkish_And_Greek_Canonical_Forms_Preserve_Distinctions_And_Raw_Identity(bool decomposed)
    {
        const string Canonical = "I İ ı i ᾳ Α\u0345 café cafe";
        string source = decomposed ? Canonical.Normalize(NormalizationForm.FormD) : Canonical;
        string[] expected = ["i", "İ", "ı", "i", "ᾳ", "ᾳ", "café", "cafe"];
        ImmutableArray<AuthorSearchToken> tokens = Tokenize(source);
        Assert.Equal(expected, tokens.Select(static token => token.Term));
        Assert.Equal(expected, AuthorFullTextSearchTokenizer.TokenizeQueryValue(source));
        string[] rawWords = source.Split(' ');
        int start = 0;
        for (int index = 0; index < tokens.Length; index++)
        {
            Assert.Equal(index, tokens[index].Position);
            Assert.Equal(Range(source, start, start + rawWords[index].Length), tokens[index].Source);
            start += rawWords[index].Length + 1;
        }
    }

    [Theory]
    [InlineData("한", "글")]
    [InlineData("\u1112\u1161\u11AB", "\u1100\u1173\u11AF")]
    public void Hangul_Classification_Preserves_Exact_Raw_Ranges_In_A_Bounded_Mixed_Field(string first, string second)
    {
        const string Prefix = "outside 👩‍💻 ";
        string field = "A" + first + second + "中İᾳ B";
        string source = Prefix + field + " ignored";
        AuthorSearchSourceRange fieldRange = Range(source, Prefix.Length, Prefix.Length + field.Length) with
        {
            SourceRevision = 37
        };
        ImmutableArray<AuthorSearchToken> tokens = AuthorFullTextSearchTokenizer.Tokenize(
            source, fieldRange, "canonical-parser", "document:1");
        string[] expected = ["a", "한", "글", "中", "İᾳ", "b"];
        Assert.Equal(expected, tokens.Select(static token => token.Term));
        Assert.Equal(expected, AuthorFullTextSearchTokenizer.TokenizeQueryValue(field));
        string[] rawTokens = ["A", first, second, "中", "İᾳ", "B"];
        int start = Prefix.Length;
        for (int index = 0; index < tokens.Length; index++)
        {
            if (index == tokens.Length - 1)
            {
                start++;
            }
            int end = start + rawTokens[index].Length;
            AuthorSearchSourceRange expectedRange = Range(source, start, end) with
            {
                SourceRevision = fieldRange.SourceRevision
            };
            Assert.Equal(index, tokens[index].Position);
            Assert.Equal(expectedRange, tokens[index].Source);
            Assert.Equal(rawTokens[index], source[start..end]);
            Assert.Equal(Encoding.UTF8.GetBytes(rawTokens[index]),
                Encoding.UTF8.GetBytes(source)[tokens[index].Source.Utf8Start..tokens[index].Source.Utf8End]);
            start = end;
        }
        if (first.Length > 1)
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchTokenizer.Tokenize(
                source, Range(source, Prefix.Length + 1, Prefix.Length + 2), "canonical-parser", "document:1"));
        }
    }

    [Fact]
    public void All_Modern_Hangul_Syllables_Share_Source_And_Query_Boundaries_With_Nfd()
    {
        // Keep each query below its real budget while checking all 11,172 syllables,
        // including adjacent syllables without spaces and both LV and LVT forms.
        for (int first = 0xAC00; first <= 0xD7A3; first += 256)
        {
            string canonical = string.Concat(Enumerable.Range(first, Math.Min(256, 0xD7A4 - first))
                .Select(static scalar => ((char)scalar).ToString()));
            string decomposed = canonical.Normalize(NormalizationForm.FormD);
            string[] expected = canonical.Select(static scalar => scalar.ToString()).ToArray();
            Assert.Equal(expected, Tokenize(canonical).Select(static token => token.Term));
            ImmutableArray<AuthorSearchToken> tokens = Tokenize(decomposed);
            Assert.Equal(expected, tokens.Select(static token => token.Term));
            Assert.Equal(expected, AuthorFullTextSearchTokenizer.TokenizeQueryValue(canonical));
            Assert.Equal(expected, AuthorFullTextSearchTokenizer.TokenizeQueryValue(decomposed));
            int start = 0;
            for (int index = 0; index < tokens.Length; index++)
            {
                int end = start + expected[index].Normalize(NormalizationForm.FormD).Length;
                Assert.Equal(index, tokens[index].Position);
                Assert.Equal(Range(decomposed, start, end), tokens[index].Source);
                start = end;
            }
            Assert.Equal(decomposed.Length, start);
        }
    }

    private static AuthorSearchSourceRange Range(string source, int start, int end)
        => new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "canonical-parser", "document:1", 1,
            AuthorFullTextSearchContract.Digest(source), start, end,
            Encoding.UTF8.GetByteCount(source.AsSpan(0, start)), Encoding.UTF8.GetByteCount(source.AsSpan(0, end)));
}
