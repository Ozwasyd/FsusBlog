using System.Globalization;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticleQueryRankingTests
{
    [Theory]
    [InlineData("文章", "文章", 0)]
    [InlineData("العربية", "العربية", 0)]
    [InlineData("café", "cafe\u0301", 0)]
    [InlineData("fsus", "FSUS", 0)]
    [InlineData("Ｆｓｕｓ", "Fsus", 0)]
    [InlineData("🙂文章", "🙂文章", 0)]
    [InlineData("article", "articles", 1)]
    [InlineData("artcle", "article", 2)]
    public void TitleNormalizationAndMatchClassesAreStable(
        string query,
        string title,
        int expectedMatch)
    {
        AuthorArticleQueryRank? rank = AuthorArticleQueryRanking.Rank(query, Candidate(1, title));
        Assert.NotNull(rank);
        Assert.Equal(expectedMatch, rank.TitleMatch);
    }

    [Fact]
    public void RankingPreservesDiacriticsAndRejectsNonmatches()
    {
        Assert.NotEqual(
            AuthorArticleQueryRanking.NormalizeText("café"),
            AuthorArticleQueryRanking.NormalizeText("cafe"));
        Assert.Null(AuthorArticleQueryRanking.Rank("ab", Candidate(1, "ac")));
        Assert.Null(AuthorArticleQueryRanking.Rank("unrelated", Candidate(1, "article")));
    }

    [Fact]
    public void ExactTitleCannotBeOverriddenByRecentOrderOrStatus()
    {
        AuthorArticleQueryRank exact = AuthorArticleQueryRanking.Rank(
            "article", Candidate(2, "article") with
            {
                Status = AuthorArticleQueryStatus.Archived
            })!;
        AuthorArticleQueryRank recentPrefix = AuthorArticleQueryRanking.Rank(
            "article", Candidate(1, "articles") with
            {
                VerifiedRecentOrdinal = 1
            })!;
        Assert.True(AuthorArticleQueryRanking.Compare(exact, recentPrefix) < 0);
    }

    [Fact]
    public void ExactTitlePrecedesPrefixAndFuzzyMatches()
    {
        AuthorArticleQueryRank exact = AuthorArticleQueryRanking.Rank("article", Candidate(3, "article"))!;
        AuthorArticleQueryRank prefix = AuthorArticleQueryRanking.Rank("article", Candidate(2, "articles"))!;
        AuthorArticleQueryRank fuzzy = AuthorArticleQueryRanking.Rank("article", Candidate(1, "articl"))!;
        Assert.True(AuthorArticleQueryRanking.Compare(exact, prefix) < 0);
        Assert.True(AuthorArticleQueryRanking.Compare(prefix, fuzzy) < 0);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(10000)]
    public void RankingKeepsEveryIdentityAndStableTiesRegardlessOfInputOrder(int count)
    {
        List<AuthorArticleQueryRank> ranks = Enumerable.Range(1, count)
            .Reverse()
            .Select(articleId => AuthorArticleQueryRanking.Rank("article", Candidate(articleId, "article"))!)
            .ToList();
        ranks.Sort(AuthorArticleQueryRanking.Compare);
        Assert.Equal(Enumerable.Range(1, count), ranks.Select(static rank => rank.ArticleId));
    }

    [Fact]
    public void DuplicateTitlesAndSlugsRetainDistinctStableIdentities()
    {
        AuthorArticleQueryCandidate first = Candidate(1, "article") with
        {
            Slug = "same-slug"
        };
        AuthorArticleQueryCandidate second = first with
        {
            ArticleId = 2
        };
        AuthorArticleQueryRank firstRank = AuthorArticleQueryRanking.Rank("same-slug", first)!;
        AuthorArticleQueryRank secondRank = AuthorArticleQueryRanking.Rank("same-slug", second)!;
        Assert.Equal(0, firstRank.SlugMatch);
        Assert.True(AuthorArticleQueryRanking.Compare(firstRank, secondRank) < 0);
        Assert.NotEqual(firstRank.ArticleId, secondRank.ArticleId);
    }

    [Fact]
    public void TaxonomyMatchesAndServerHistoryOrdinalAreExplicitFactors()
    {
        AuthorArticleQueryRank category = AuthorArticleQueryRanking.Rank(
            "category", Candidate(1, "article") with
            {
                Category = "category"
            })!;
        AuthorArticleQueryRank tag = AuthorArticleQueryRanking.Rank(
            "tag", Candidate(2, "article") with
            {
                Tags = ["tag"]
            })!;
        Assert.Equal(0, category.TaxonomyMatch);
        Assert.Equal(0, tag.TaxonomyMatch);
        AuthorArticleQueryRank recent = AuthorArticleQueryRanking.Rank(
            "", Candidate(2, "article") with
            {
                VerifiedRecentOrdinal = 1
            })!;
        AuthorArticleQueryRank older = AuthorArticleQueryRanking.Rank(
            "", Candidate(1, "article") with
            {
                VerifiedRecentOrdinal = 2
            })!;
        Assert.True(AuthorArticleQueryRanking.Compare(recent, older) < 0);
    }

    [Fact]
    public void NormalizationIsIndependentOfAmbientCulture()
    {
        CultureInfo original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("tr-TR");
            Assert.Equal("IDENTITY", AuthorArticleQueryRanking.NormalizeText("identity"));
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public void CancellationAndInvalidCandidatesFailBeforeAResult()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() =>
            AuthorArticleQueryRanking.Rank("article", Candidate(1, "article"), cancellation.Token));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryRanking.Rank("article", Candidate(1, "article") with
            {
                PermissionToken = ""
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryRanking.Rank("article", Candidate(1, "article") with
            {
                VerifiedRecentOrdinal = 0
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryRanking.Rank(new string('a', 129), Candidate(1, "article")));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryRanking.Rank("article", Candidate(1, new string('a', 513))));
    }

    [Fact]
    public void RequestRejectsUnknownScopesUnavailableInboxAndUnboundedResponses()
    {
        AuthorArticleQueryRequest request = Request();
        AuthorArticleQueryContract.ValidateRequest(request);
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Limit = 51
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Statuses = [(AuthorArticleQueryStatus)99]
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Buckets = [(AuthorArticleQueryBucket)99]
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Statuses = [AuthorArticleQueryStatus.Draft, AuthorArticleQueryStatus.Draft]
            }));
        Assert.Throws<ArgumentException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Collation = "ambient"
            }));
        NotSupportedException unavailable = Assert.Throws<NotSupportedException>(() =>
            AuthorArticleQueryContract.ValidateRequest(request with
            {
                Buckets = [AuthorArticleQueryBucket.Inbox]
            }));
        Assert.Equal("author_article_query_inbox_unavailable", unavailable.Message);
    }

    private static AuthorArticleQueryCandidate Candidate(int articleId, string title)
        => new(articleId, 701, title, "slug", "category", [], AuthorArticleQueryStatus.Draft, "permission-revision", null);

    private static AuthorArticleQueryRequest Request()
        => new(1, new(42, "primary-site"), Guid.CreateVersion7(), 1, "article",
            [AuthorArticleQueryStatus.Draft], [AuthorArticleQueryBucket.Draft], "en-US",
            AuthorArticleQueryContract.Collation, 50, null);
}
