using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class ArticleServiceTests
{
    [Fact]
    public void OrderHotArticlesForTests_PreservesRequestedOrder()
    {
        List<PopularArticleSummaryDto> articles =
        [
            new(2, "two", 20),
            new(1, "one", 10)
        ];

        List<PopularArticleSummaryDto> ordered = ArticleService.OrderHotArticlesForTests([1, 2, 3], articles);

        Assert.Equal([1, 2], ordered.Select(static it => it.Id).ToArray());
    }

    [Fact]
    public void OrderHotArticlesForTests_EmptyArticles_ReturnsEmpty()
    {
        var ordered = ArticleService.OrderHotArticlesForTests([1, 2], []);
        Assert.Empty(ordered);
    }

    [Fact]
    public void OrderHotArticlesForTests_EmptyIds_ReturnsEmpty()
    {
        List<PopularArticleSummaryDto> articles = [new(1, "a", 10)];
        var ordered = ArticleService.OrderHotArticlesForTests([], articles);
        Assert.Empty(ordered);
    }

    [Fact]
    public void GetHotArticlesAsync_RuntimeFiltersSeedIdsByArticleIdColumn()
    {
        string runtimeShape = FsusBlog.Server.Tests.Unit.RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleService),
            nameof(ArticleService.GetHotArticlesAsync));

        Assert.Contains("System.Linq.Expressions.Expression", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("Article.get_Id", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("SqlSugar.ISugarQueryable", runtimeShape, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/uploads/cover.webp", true)]
    [InlineData("  /uploads/cover.webp  ", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData(null, false)]
    public void HasUsableFeaturedCoverForTests_RequiresNonWhitespaceCover(string? coverImageUrl, bool expected)
    {
        Assert.Equal(expected, ArticleService.HasUsableFeaturedCoverForTests(coverImageUrl));
    }

    [Fact]
    public void AttachTagsForTests_AssignsTagsByArticleId()
    {
        List<ArticleListItemReadModel> items =
        [
            new() { Id = 1, Title = "one", Tags = [] },
            new() { Id = 2, Title = "two", Tags = [] }
        ];

        var tagMap = new Dictionary<int, List<TagReadModel>>
        {
            [2] = [new TagReadModel { Id = 8, Name = "perf" }]
        };

        ArticleService.AttachTagsForTests(items, tagMap);

        Assert.Empty(items[0].Tags);
        Assert.Single(items[1].Tags);
        Assert.Equal("perf", items[1].Tags[0].Name);
    }

    [Fact]
    public void AttachTagsForTests_EmptyItems_LeavesInputsUnchanged()
    {
        var items = new List<ArticleListItemReadModel>();
        List<ArticleListItemReadModel> originalItems = items;
        var primaryTag = new TagReadModel { Id = 7, Name = "backend" };
        var secondaryTag = new TagReadModel { Id = 11, Name = "protocol" };
        var tertiaryTag = new TagReadModel { Id = 13, Name = "testing" };
        List<TagReadModel> primaryTags = [primaryTag, secondaryTag];
        List<TagReadModel> secondaryTags = [tertiaryTag];
        var tagMap = new Dictionary<int, List<TagReadModel>>
        {
            [42] = primaryTags,
            [9] = secondaryTags
        };
        int[] expectedKeys = [.. tagMap.Keys];
        (int Id, string Name) primarySnapshot = (primaryTag.Id, primaryTag.Name);
        (int Id, string Name) secondarySnapshot = (secondaryTag.Id, secondaryTag.Name);
        (int Id, string Name) tertiarySnapshot = (tertiaryTag.Id, tertiaryTag.Name);

        ArticleService.AttachTagsForTests(items, tagMap);

        Assert.Same(originalItems, items);
        Assert.Empty(items);
        Assert.Equal(expectedKeys, tagMap.Keys);
        Assert.Same(primaryTags, tagMap[42]);
        Assert.Same(secondaryTags, tagMap[9]);
        Assert.Collection(
            primaryTags,
            tag =>
            {
                Assert.Same(primaryTag, tag);
                Assert.Equal(primarySnapshot, (tag.Id, tag.Name));
            },
            tag =>
            {
                Assert.Same(secondaryTag, tag);
                Assert.Equal(secondarySnapshot, (tag.Id, tag.Name));
            });
        TagReadModel remainingTag = Assert.Single(secondaryTags);
        Assert.Same(tertiaryTag, remainingTag);
        Assert.Equal(tertiarySnapshot, (remainingTag.Id, remainingTag.Name));
    }

    [Fact]
    public void AttachTagsForTests_EmptyTagMap_LeavesItemsWithEmptyTags()
    {
        var items = new List<ArticleListItemReadModel> { new() { Id = 1, Title = "x", Tags = [] } };
        ArticleService.AttachTagsForTests(items, new Dictionary<int, List<TagReadModel>>());
        Assert.Empty(items[0].Tags);
    }

    // ── Private static method tests via reflection ─────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(ArticleService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }
    [Theory]
    [InlineData("  hello  ", 100, "hello")]
    [InlineData("hello", 3, "hel")]
    [InlineData("", 10, "")]
    [InlineData("   ", 10, "")]
    [InlineData(null, 10, "")]
    public void NormalizeText_TrimsAndTruncates(string? input, int maxLen, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeText", [input, maxLen]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void ReadingEstimator_UsesContentAwareReadingSpeeds()
    {
        Assert.Equal(1, ReadingEstimator.Estimate(new string('字', 500)).Minutes);
        Assert.Equal(2, ReadingEstimator.Estimate(new string('字', 501)).Minutes);

        string englishShort = string.Join(' ', Enumerable.Repeat("word", 220));
        string englishLong = string.Join(' ', Enumerable.Repeat("word", 221));
        Assert.Equal(1, ReadingEstimator.Estimate(englishShort).Minutes);
        Assert.Equal(2, ReadingEstimator.Estimate(englishLong).Minutes);
    }

    [Fact]
    public void ReadingEstimator_SeparatesCodeAndImagesFromProse()
    {
        ReadingEstimate codeEstimate = ReadingEstimator.Estimate($"```cs\n{new string('x', 141)}\n```");
        Assert.Equal(141, codeEstimate.CodeChars);
        Assert.Equal(2, codeEstimate.Minutes);

        ReadingEstimate imageEstimate = ReadingEstimator.Estimate(string.Concat(Enumerable.Repeat("![a](/a.png)\n", 6)));
        Assert.Equal(6, imageEstimate.ImageCount);
        Assert.Equal(2, imageEstimate.Minutes);
    }

    [Theory]
    [InlineData("hello", "hello")]           // ≤200 chars → unchanged
    [InlineData(null, "")]                   // null → empty
    [InlineData("", "")]                     // empty → empty
    public void GenerateSafeSummary_ShortContent_ReturnsAsIs(string? input, string expected)
    {
        ArticleSummaryProjectionResult result = ArticleSummaryProjection.Resolve(null, input);
        Assert.Equal(expected, result.Text);
        Assert.True(result.IsGenerated);
    }

    [Fact]
    public void GenerateSafeSummary_LongContent_TruncatesAt200()
    {
        string longContent = new string('a', 300);
        ArticleSummaryProjectionResult result = ArticleSummaryProjection.Resolve(null, longContent);
        Assert.Equal(200, result.Text.Length);
        Assert.EndsWith("…", result.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void NormalizeTagIds_NullInput_ReturnsEmpty()
    {
        var result = InvokePrivateStatic<List<int>>("NormalizeTagIds", [null]);
        Assert.Empty(result);
    }

    [Fact]
    public void NormalizeTagIds_EmptyInput_ReturnsEmpty()
    {
        var result = InvokePrivateStatic<List<int>>("NormalizeTagIds", [new List<int>()]);
        Assert.Empty(result);
    }

    [Fact]
    public void NormalizeTagIds_DeduplicatesTags()
    {
        var result = InvokePrivateStatic<List<int>>("NormalizeTagIds", [new List<int> { 1, 2, 1, 3 }]);
        Assert.Equal([1, 2, 3], result);
    }

    [Fact]
    public void NormalizeTagIds_TruncatesTo32()
    {
        var input = Enumerable.Range(1, 50).ToList();
        var result = InvokePrivateStatic<List<int>>("NormalizeTagIds", [input]);
        Assert.Equal(32, result.Count);
    }

    [Fact]
    public void MergeIds_CombinesUniquePositiveIds()
    {
        var result = InvokePrivateStatic<List<int>>("MergeIds",
            [new int[] { 1, 2, 3 }, new int[] { 2, 3, 4 }]);
        Assert.Equal(4, result.Count);
        Assert.Contains(1, result);
        Assert.Contains(4, result);
    }

    [Fact]
    public void MergeIds_FiltersOutNonPositive()
    {
        var result = InvokePrivateStatic<List<int>>("MergeIds",
            [new int[] { 0, -1, 1 }, new int[] { -5, 2 }]);
        Assert.Equal(2, result.Count);
    }

    [Fact]
    public void BuildArticleListIdentity_ProducesConsistentKey()
    {
        var r1 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, null, null, false, null, false, ""]);
        var r2 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, null, null, false, null, false, ""]);
        Assert.Equal(r1, r2);
    }

    [Fact]
    public void BuildArticleListIdentity_DiffParamsProduceDiffKeys()
    {
        var r1 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, (int?)5, null, false, null, false, ""]);
        var r2 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, null, null, false, null, false, ""]);
        Assert.NotEqual(r1, r2);
    }

    [Fact]
    public void BuildArticleListIdentity_DiffKeywordProduceDiffKeys()
    {
        var r1 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, null, null, false, null, true, "中文 keyword"]);
        var r2 = InvokePrivateStatic<string>("BuildArticleListIdentity", [1L, 1, 10, null, null, false, null, true, ""]);
        Assert.NotEqual(r1, r2);
    }

    [Fact]
    public void NormalizeArticleListKeyword_TrimsAndLimitsLength()
    {
        var result = InvokePrivateStatic<string>("NormalizeArticleListKeyword", ["  " + new string('a', 100) + "  "]);
        Assert.Equal(80, result.Length);
        Assert.DoesNotContain(" ", result);
    }

    [Fact]
    public void BuildArticleTags_CreatesTagsWithCorrectIds()
    {
        var result = InvokePrivateStatic<List<ArticleTag>>("BuildArticleTags", [(object)42, new List<int> { 1, 2, 3 }]);
        Assert.Equal(3, result.Count);
        Assert.All(result, t => Assert.Equal(42, t.ArticleId));
        Assert.Equal(1, result[0].TagId);
        Assert.Equal(2, result[1].TagId);
        Assert.Equal(3, result[2].TagId);
    }

    [Fact]
    public void BuildArticleTags_EmptyTagIds_ReturnsEmpty()
    {
        var result = InvokePrivateStatic<List<ArticleTag>>("BuildArticleTags", [(object)5, new List<int>()]);
        Assert.Empty(result);
    }
}
