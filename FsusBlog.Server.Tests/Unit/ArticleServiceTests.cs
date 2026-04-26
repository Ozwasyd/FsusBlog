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
}
