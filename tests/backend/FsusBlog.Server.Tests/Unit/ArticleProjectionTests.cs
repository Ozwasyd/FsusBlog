using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleProjectionTests
{
    // ─── ToResponse(ArticleListItemReadModel) ───────────────────────────────

    [Fact]
    public void ToResponse_UsesSnippetOverSummaryWhenBothPresent()
    {
        var item = BuildListItem(summary: "the summary", snippet: "the snippet");

        ArticleListItemResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal("the snippet", result.Summary);
    }

    [Fact]
    public void ToResponse_FallsBackToSummaryWhenSnippetIsEmpty()
    {
        var item = BuildListItem(summary: "the summary", snippet: "");

        ArticleListItemResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal("the summary", result.Summary);
    }

    [Fact]
    public void ToResponse_FallsBackToSummaryWhenSnippetIsNull()
    {
        var item = BuildListItem(summary: "the summary", snippet: null);

        ArticleListItemResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal("the summary", result.Summary);
    }

    [Fact]
    public void ToResponse_CapsTagsAtTwo()
    {
        var item = BuildListItem() with
        {
            Tags =
            [
                new TagReadModel { Id = 1, Name = "a" },
                new TagReadModel { Id = 2, Name = "b" },
                new TagReadModel { Id = 3, Name = "c" },
            ]
        };

        ArticleListItemResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal(2, result.Tags.Count);
        Assert.Equal(1, result.Tags[0].Id);
        Assert.Equal(2, result.Tags[1].Id);
    }

    [Fact]
    public void ToResponse_MapsFieldsCorrectly()
    {
        var time = new DateTime(2024, 6, 1, 12, 0, 0);
        var item = BuildListItem() with
        {
            Id = 42,
            Title = "Test Article",
            Views = 123,
            CreateTime = time,
            CategoryId = 7,
            CategoryName = "Tech",
            IsDeleted = true
        };

        ArticleListItemResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal(42, result.Id);
        Assert.Equal("Test Article", result.Title);
        Assert.Equal(123, result.Views);
        Assert.Equal(time, result.CreateTime);
        Assert.Equal(7, result.Category.Id);
        Assert.Equal("Tech", result.Category.Name);
        Assert.True(result.IsDeleted);
    }

    // ─── ToResponse(ArticleDetailReadModel) ────────────────────────────────

    [Fact]
    public void ToDetailResponse_UsesContentWhenPresent()
    {
        var item = BuildDetailItem(content: "# body", summary: "summary text");

        ArticleDetailResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal("# body", result.Content);
    }

    [Fact]
    public void ToDetailResponse_FallsBackToSummaryWhenContentIsEmpty()
    {
        var item = BuildDetailItem(content: "", summary: "summary text");

        ArticleDetailResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal("summary text", result.Content);
    }

    [Fact]
    public void ToDetailResponse_ReturnsEmptyStringWhenBothMissing()
    {
        var item = BuildDetailItem(content: "", summary: null);

        ArticleDetailResponse result = ArticleProjection.ToResponse(item);

        Assert.Equal(string.Empty, result.Content);
    }

    // ─── ResolveDetailContent ───────────────────────────────────────────────

    [Fact]
    public void ResolveDetailContent_PreservesLeadingWhitespaceInContent()
    {
        var item = BuildDetailItem(content: "  body  ", summary: "other");

        string result = ArticleProjection.ResolveDetailContent(item);

        Assert.Equal("  body  ", result);
    }

    [Fact]
    public void ResolveDetailContent_TrimsSummaryWhenUsedAsFallback()
    {
        var item = BuildDetailItem(content: "", summary: "  summary  ");

        string result = ArticleProjection.ResolveDetailContent(item);

        Assert.Equal("summary", result);
    }

    // ─── ToCategoryResponse ─────────────────────────────────────────────────

    [Fact]
    public void ToCategoryResponse_MapsAllFields()
    {
        CategoryListItemResponse result = ArticleProjection.ToCategoryResponse(3, "Science", 17);

        Assert.Equal(3, result.Id);
        Assert.Equal("Science", result.Name);
        Assert.Equal(17, result.ArticleCount);
    }

    // ─── ToResponsePage ─────────────────────────────────────────────────────

    [Fact]
    public void ToResponsePage_MapsItemsAndTotal()
    {
        var page = new ArticleListPageReadModel
        {
            Items = [BuildListItem() with { Id = 5 }, BuildListItem() with { Id = 6 }],
            Total = 99
        };

        PageResponse<ArticleListItemResponse> result = ArticleProjection.ToResponsePage(page);

        Assert.Equal(99, result.Total);
        Assert.Equal(2, result.Items.Count);
        Assert.Equal(5, result.Items[0].Id);
        Assert.Equal(6, result.Items[1].Id);
    }

    // ─── ToTagResponse ───────────────────────────────────────────────────────

    [Fact]
    public void ToTagResponse_MapsIdAndName()
    {
        var tag = new TagReadModel { Id = 99, Name = "dotnet" };

        TagDto result = ArticleProjection.ToTagResponse(tag);

        Assert.Equal(99, result.Id);
        Assert.Equal("dotnet", result.Name);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    private static ArticleListItemReadModel BuildListItem(string? summary = "summary", string? snippet = null)
        => new()
        {
            Id = 1,
            Title = "Title",
            Summary = summary,
            Snippet = snippet,
            Views = 0,
            CreateTime = DateTime.UtcNow,
            CategoryId = 1,
            CategoryName = "Cat",
            Tags = [],
            IsDeleted = false
        };

    private static ArticleDetailReadModel BuildDetailItem(string content = "content", string? summary = null)
        => new()
        {
            Id = 1,
            Title = "Title",
            Content = content,
            Summary = summary,
            Views = 0,
            WordCount = 0,
            EstimatedReadingMinutes = 0,
            ShowReadingNotice = false,
            CreateTime = DateTime.UtcNow,
            CategoryId = 1,
            CategoryName = "Cat",
            Tags = []
        };
}
