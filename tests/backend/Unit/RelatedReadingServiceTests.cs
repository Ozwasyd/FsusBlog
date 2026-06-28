using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RelatedReadingServiceTests
{
    [Fact]
    public void BuildAsync_SourceUsesLightweightCandidatesAndUnifiedCache()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Distribution/RelatedReadingService.cs");
        string build = ExtractMethod(source, "public async Task<RelatedReadingResponse?> BuildAsync", "private async ValueTask<long> GetArticleListVersionAsync");
        string candidateLoader = ExtractMethod(source, "private async Task<List<RelatedArticleRow>> LoadCandidateIndexAsync", "private async Task<Dictionary<int, HashSet<int>>> LoadTagMapAsync");
        string keywordMatcher = ExtractMethod(source, "private static int CountKeywordMatches", "private static string[] ExtractKeywords");

        Assert.Contains("CachePolicyId.RelatedReading", build, StringComparison.Ordinal);
        Assert.Contains("cache.TryGetAsync", build, StringComparison.Ordinal);
        Assert.Contains("cache.SetRawAsync", build, StringComparison.Ordinal);
        Assert.Contains("LoadCandidateIndexAsync", build, StringComparison.Ordinal);
        Assert.DoesNotContain("LeftJoin<ArticleBody>", candidateLoader, StringComparison.Ordinal);
        Assert.DoesNotContain("MarkdownContent = body.MarkdownContent", candidateLoader, StringComparison.Ordinal);
        Assert.DoesNotContain("candidate.MarkdownContent", keywordMatcher, StringComparison.Ordinal);
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
