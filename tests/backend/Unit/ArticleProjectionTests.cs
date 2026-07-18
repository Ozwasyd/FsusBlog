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
        Assert.Equal(901, result.Rights.SnapshotId);
        Assert.Equal("CC-BY-4.0", result.Rights.LicenseType);
        Assert.Equal("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", result.Rights.PolicyHash);
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
            Items =
            [
                BuildListItem() with
                {
                    Id = 5,
                    Tags =
                    [
                        new TagReadModel { Id = 1, Name = "one" },
                        new TagReadModel { Id = 2, Name = "two" },
                        new TagReadModel { Id = 3, Name = "three" }
                    ]
                },
                BuildListItem() with { Id = 6, Tags = ArticleReadModelCollections.EmptyTags }
            ],
            Total = 99,
            NextCursor = "cursor-6",
            HasMore = true
        };

        PageResponse<ArticleListItemResponse> result = ArticleProjection.ToResponsePage(page);

        Assert.Equal(99, result.Total);
        Assert.Equal(2, result.Items.Count);
        Assert.Equal(5, result.Items[0].Id);
        Assert.Equal(6, result.Items[1].Id);
        Assert.Equal("cursor-6", result.NextCursor);
        Assert.True(result.HasMore);
        Assert.Equal([1, 2], result.Items[0].Tags.Select(static tag => tag.Id));
        Assert.Empty(result.Items[1].Tags);
        Assert.Equal(2, result.Items[0].Status);
        Assert.Equal(2, result.Items[1].Status);
    }

    [Fact]
    public void ToResponsePage_PreservesTheSingleItemProjectionContract()
    {
        ArticleListItemReadModel source = BuildListItem("summary", "snippet") with
        {
            CoverImageUrl = "/cover.webp",
            Status = ArticleStatus.Draft,
            ScheduledPublishAt = DateTime.UnixEpoch.AddDays(1),
            PublishedAt = DateTime.UnixEpoch.AddDays(2),
            Tags = [new TagReadModel { Id = 7, Name = "seven" }]
        };

        ArticleListItemResponse expected = ArticleProjection.ToResponse(source);
        ArticleListItemResponse actual = Assert.Single(ArticleProjection.ToResponsePage(new ArticleListPageReadModel
        {
            Items = [source],
            Total = 1
        }).Items);

        Assert.Equal(expected with
        {
            Tags = actual.Tags
        }, actual);
        Assert.Equal(expected.Tags, actual.Tags);
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
            Tags = [],
            Rights = BuildRights()
        };

    private static ArticleRightsReadModel BuildRights()
        => new()
        {
            SnapshotId = 901,
            ArticleRevisionId = 801,
            RevisionNo = 7,
            Enabled = true,
            LicenseType = "CC-BY-4.0",
            CopyrightHolder = "Fésus",
            CopyrightYear = 2026,
            RightsStatement = "Line one\nLine two",
            AttributionTemplate = "{title} — {holder}",
            CopyPolicy = "append-attribution",
            MaxExcerptChars = 300,
            AllowCodeCopy = true,
            ShowPublicBadge = false,
            ProofBindingEnabled = true,
            CanonicalUrl = "https://example.test/article/1",
            PolicyHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ContentCanonicalHash = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ProofUrl = "https://example.test/proofs/rights/901",
            ProofStatus = "ready"
        };
}
