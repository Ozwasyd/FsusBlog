using System.Collections.Immutable;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchContractsTests
{
    private static readonly IReadOnlyDictionary<Guid, ArticlePropertyDefinition> s_definitions =
        new Dictionary<Guid, ArticlePropertyDefinition>();

    [Theory]
    [InlineData("\uFEFF中\r\n👩‍💻e\u0301العربية", 1, 2)]
    [InlineData("привет CAFÉ 中文", 0, 6)]
    [InlineData("a\r\nb", 3, 4)]
    public void Document_Binds_Exact_Raw_Utf16_And_Utf8_Ranges(string raw, int start, int end)
    {
        AuthorSearchDocument document = Document(raw, start, end);
        AuthorFullTextSearchContract.ValidateDocument(document, raw, s_definitions, "canonical-parse-package-v1", "article-7-epoch");

        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateDocument(document with
            {
                Source = document.Source with
                {
                    Utf8Start = document.Source.Utf8Start + 1
                }
            }, raw, s_definitions, "canonical-parse-package-v1", "article-7-epoch"));
        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateDocument(document, raw + "x", s_definitions, "canonical-parse-package-v1", "article-7-epoch"));
    }

    [Fact]
    public void Source_Ranges_Reject_Html_Dom_Normalized_And_Split_Scalar_Coordinates()
    {
        const string Raw = "\uFEFFa\r\n👩‍💻中";
        AuthorSearchDocument document = Document(Raw, 4, Raw.Length);
        foreach (string authority in new[] { "html-offset", "dom-path", "normalized-source", "textarea-index" })
        {
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorFullTextSearchContract.ValidateDocument(document with
                {
                    Source = document.Source with
                    {
                        Authority = authority
                    }
                }, Raw, s_definitions, "canonical-parse-package-v1", "article-7-epoch"));
        }
        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateRange(document.Source with
            {
                Utf16Start = 5
            }, Raw, "canonical-parse-package-v1", "article-7-epoch"));
        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateRange(document.Source with
            {
                Utf16End = Raw.Length + 1
            }, Raw, "canonical-parse-package-v1", "article-7-epoch"));
    }

    [Fact]
    public void Document_Rejects_History_Stale_Revision_Unknown_Field_And_Public_Index_Ownership()
    {
        const string Raw = "source";
        AuthorSearchDocument document = Document(Raw, 0, Raw.Length);
        foreach (AuthorSearchDocument mutation in new[]
        {
            document with { IndexOwner = "public-search-index" },
            document with { SchemaVersion = 2 },
            document with { TokenizerVersion = "unknown" },
            document with { Field = document.Field with { Kind = (AuthorSearchFieldKind)999 } },
            document with { Identity = document.Identity with { Scope = AuthorSearchScope.HistoricalRevisionUnavailable } },
            document with { Identity = document.Identity with { Status = ArticleStatus.Deleted } },
            document with { Source = document.Source with { SourceRevision = 2 } },
            document with { Source = document.Source with { ParserVersion = "unknown-future-version" } },
            document with { Source = document.Source with { DocumentEpoch = "article-8-epoch" } },
            document with { Identity = document.Identity with { PermissionRevision = 0 } },
            document with { ContentDigest = AuthorFullTextSearchContract.Digest("forged") }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorFullTextSearchContract.ValidateDocument(mutation, Raw, s_definitions, "canonical-parse-package-v1", "article-7-epoch"));
        }
    }

    [Theory]
    [InlineData("中文")]
    [InlineData("CAFÉ")]
    [InlineData("привет")]
    [InlineData("👩‍💻")]
    [InlineData("e\u0301")]
    [InlineData("العربية")]
    public void Closed_Query_Preserves_Raw_Unicode_And_Quoted_Phrases(string text)
    {
        AuthorSearchQuery query = Query(
            new(AuthorSearchClauseKind.PlainText, null, null, null, [text]),
            new(AuthorSearchClauseKind.QuotedPhrase, null, null, null, [text + " phrase"]));
        AuthorFullTextSearchContract.ValidateQuery(query, s_definitions);
        Assert.Equal(text, query.Clauses[0].Values[0]);
        Assert.Equal("NFC", AuthorFullTextSearchContract.Tokenizer.UnicodeNormalization);
        Assert.Equal("logical-source-order", AuthorFullTextSearchContract.Tokenizer.RtlOrder);
    }

    [Fact]
    public void Query_Rejects_Unknown_Operators_Duplicate_Filters_History_And_Budget_Drift()
    {
        AuthorSearchClause status = new(AuthorSearchClauseKind.Status, null, null, null, ["published"]);
        AuthorSearchQuery query = Query(status);
        AuthorFullTextSearchContract.ValidateQuery(query, s_definitions);
        foreach (AuthorSearchQuery mutation in new[]
        {
            Query(status, status),
            Query(status with { Operator = "regex" }),
            Query(status with { Kind = (AuthorSearchClauseKind)999 }),
            Query(status with { Values = ["unknown"] }),
            query with { PageSize = AuthorFullTextSearchContract.MaxPageSize + 1 },
            query with { Scope = AuthorSearchScope.HistoricalRevisionUnavailable },
            query with { PermissionRevision = 2 },
            query with { RankingVersion = "embedding" }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorFullTextSearchContract.ValidateQuery(mutation, s_definitions));
        }
    }

    [Fact]
    public void Snippet_Preserves_Ordered_Ranges_And_Truthful_Truncation()
    {
        const string Raw = "中文 café tail";
        AuthorSearchDocument document = Document(Raw, 0, Raw.Length);
        AuthorSearchSnippet snippet = new(document.ContentDigest, document.Field.ContentDigest,
            document.Field.Kind, null, Range(Raw, 0, 7), [Range(Raw, 0, 2), Range(Raw, 3, 7)], false, true);
        AuthorFullTextSearchContract.ValidateSnippet(snippet, document, Raw, "canonical-parse-package-v1", "article-7-epoch");
        foreach (AuthorSearchSnippet mutation in new[]
        {
            snippet with { TruncatedAfter = false },
            snippet with { DocumentDigest = AuthorFullTextSearchContract.Digest("other") },
            snippet with { Highlights = [Range(Raw, 3, 7), Range(Raw, 0, 2)] },
            snippet with { Highlights = [Range(Raw, 0, Raw.Length)] },
            snippet with { Highlights = [Range(Raw, 1, 1)] }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorFullTextSearchContract.ValidateSnippet(mutation, document, Raw, "canonical-parse-package-v1", "article-7-epoch"));
        }
    }

    [Fact]
    public void Result_Rejects_Stale_Permission_Generation_Query_And_Cross_User_Documents()
    {
        const string Raw = "中文";
        AuthorSearchQuery query = Query(new AuthorSearchClause(AuthorSearchClauseKind.PlainText, null, null, null, [Raw]));
        AuthorSearchDocument document = Document(Raw, 0, Raw.Length);
        var snippet = new AuthorSearchSnippet(document.ContentDigest, document.Field.ContentDigest,
            document.Field.Kind, null, document.Source, [], false, false);
        AuthorSearchResult result = AuthorFullTextSearchContract.SealResult(new(
            AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            query.QueryId, query.ContentDigest, 1, 1, 1, [new(document, snippet)], string.Empty));
        AuthorFullTextSearchContract.ValidateResult(result, query, 1, 1);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateResult(result, query, 2, 1));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateResult(result, query, 1, 2));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateResult(result with
        {
            QueryId = Guid.NewGuid()
        }, query, 1, 1));
        AuthorSearchDocument otherUser = AuthorFullTextSearchContract.SealDocument(document with
        {
            Identity = document.Identity with
            {
                UserId = 99
            }
        });
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateResult(result with
        {
            Matches = [new(otherUser, snippet)]
        }, query, 1, 1));
    }

    [Fact]
    public void Closed_Registry_Separates_Owners_And_Has_No_Ai_Or_Popularity_Ranking()
    {
        Assert.Equal(Enum.GetValues<AuthorSearchFieldKind>().Length, AuthorFullTextSearchContract.Fields.Count);
        Assert.Equal(4, AuthorFullTextSearchContract.OwnerBoundaries.Select(item => item.Owner).Distinct().Count());
        Assert.DoesNotContain(AuthorFullTextSearchContract.RankingFactors,
            factor => factor.ToString().Contains("View", StringComparison.OrdinalIgnoreCase)
                || factor.ToString().Contains("Embedding", StringComparison.OrdinalIgnoreCase)
                || factor.ToString().Contains("Pin", StringComparison.OrdinalIgnoreCase));
        Assert.Equal("article-id-ascending", AuthorFullTextSearchContract.StableTieBreakers[1]);
    }

    private static AuthorSearchSourceRange Range(string raw, int start, int end)
        => new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "canonical-parse-package-v1", "article-7-epoch",
            1, AuthorFullTextSearchContract.Digest(raw), start, end,
            Encoding.UTF8.GetByteCount(raw.AsSpan(0, start)), Encoding.UTF8.GetByteCount(raw.AsSpan(0, end)));

    private static AuthorSearchDocument Document(string raw, int start, int end)
        => AuthorFullTextSearchContract.SealDocument(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.DocumentSchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.IndexOwner,
            new(7, 42, "site-a", 1, 1, 1, 1, "zh-Hans", ArticleStatus.Draft, AuthorSearchScope.CurrentArticle),
            new(AuthorSearchFieldKind.MarkdownBody, AuthorFullTextSearchContract.Digest(raw), null, null, null),
            Range(raw, start, end), string.Empty));

    private static AuthorSearchQuery Query(params AuthorSearchClause[] clauses)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "site-a", 1, 1, AuthorSearchScope.CurrentArticle,
            clauses.ToImmutableArray(), 25, null, string.Empty));
}
