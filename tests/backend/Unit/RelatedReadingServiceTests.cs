using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RelatedReadingServiceTests
{
    [Fact]
    public void BuildAsync_SourceUsesLightweightCandidatesAndUnifiedCache()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Distribution/RelatedReadingService.cs");
        string build = ExtractMethod(source, "public async Task<RelatedReadingResponse?> BuildAsync", "private async ValueTask<long> GetArticleListVersionAsync");
        string candidateLoader = ExtractMethod(source, "private async Task<CandidateIndex> LoadCandidateIndexAsync", "private async Task<RelatedArticleRow?> LoadAdjacentAsync");
        string keywordMatcher = ExtractMethod(source, "private static int CountKeywordMatches", "private static string[] ExtractKeywords");

        Assert.Contains("CachePolicyId.RelatedReading", build, StringComparison.Ordinal);
        Assert.Contains("cache.TryGetAsync", build, StringComparison.Ordinal);
        Assert.Contains("cache.SetRawAsync", build, StringComparison.Ordinal);
        Assert.Contains("LoadCandidateIndexAsync", build, StringComparison.Ordinal);
        Assert.DoesNotContain("LeftJoin<ArticleBody>", candidateLoader, StringComparison.Ordinal);
        Assert.DoesNotContain("MarkdownContent = body.MarkdownContent", candidateLoader, StringComparison.Ordinal);
        Assert.DoesNotContain("candidate.MarkdownContent", keywordMatcher, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildAsync_SourceConvergesRoundTripsAndKeywordAllocations()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Distribution/RelatedReadingService.cs");
        string build = ExtractMethod(source, "public async Task<RelatedReadingResponse?> BuildAsync", "private static (bool Success, RelatedReadingResponse? Value) DecodeRelatedReading");
        string candidateLoader = ExtractMethod(source, "private async Task<CandidateIndex> LoadCandidateIndexAsync", "private async Task<RelatedArticleRow?> LoadAdjacentAsync");
        string keywordMatcher = ExtractMethod(source, "private static int CountKeywordMatches", "private static string[] ExtractKeywords");
        string keywordExtractor = ExtractMethod(source, "private static string[] ExtractKeywords", "private static bool IsCjk");

        Assert.Contains("Task.WhenAll(versionTask, articleTask)", build, StringComparison.Ordinal);
        Assert.DoesNotContain("sourceTagIdsTask", build, StringComparison.Ordinal);
        Assert.DoesNotContain("candidateIndexTask", build, StringComparison.Ordinal);
        Assert.DoesNotContain("previousTask", build, StringComparison.Ordinal);
        Assert.DoesNotContain("nextTask", build, StringComparison.Ordinal);
        Assert.Contains("int[] sourceTagIds = await LoadSourceTagIdsAsync", build, StringComparison.Ordinal);
        Assert.Contains("CandidateIndex candidateIndex = await LoadCandidateIndexAsync", build, StringComparison.Ordinal);
        Assert.Contains("RelatedArticleRow? previous = await LoadAdjacentAsync", build, StringComparison.Ordinal);
        Assert.Contains("RelatedArticleRow? next = await LoadAdjacentAsync", build, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN article_tag", candidateLoader, StringComparison.Ordinal);
        Assert.DoesNotContain("LoadTagMapAsync", build, StringComparison.Ordinal);
        Assert.DoesNotContain("MarkdownContent", keywordMatcher, StringComparison.Ordinal);
        Assert.Contains("string.Create", keywordExtractor, StringComparison.Ordinal);
        Assert.DoesNotContain("Substring", keywordExtractor, StringComparison.Ordinal);
        Assert.DoesNotContain("ToArray()", keywordExtractor, StringComparison.Ordinal);
    }

    private static string ExtractMethod(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
