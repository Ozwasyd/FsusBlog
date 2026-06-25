using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Tests;

public sealed class ServerCacheBinaryCodecTests
{
    [Fact]
    public void ArticleListPage_UtcDateTimes_RoundTripWithoutTickDrift()
    {
        DateTime created = new(2026, 6, 25, 9, 30, 0, DateTimeKind.Utc);
        DateTime scheduled = new(2026, 6, 26, 9, 30, 0, DateTimeKind.Utc);
        DateTime published = new(2026, 6, 27, 9, 30, 0, DateTimeKind.Utc);
        var page = new ArticleListPageReadModel
        {
            Total = 1,
            Items =
            [
                CreateItem(created) with
                {
                    ScheduledPublishAt = scheduled,
                    PublishedAt = published
                }
            ]
        };

        byte[] payload = ServerCacheBinaryCodec.EncodeArticleListPage(page);
        (bool success, ArticleListPageReadModel? decoded) = ServerCacheBinaryCodec.DecodeArticleListPage(payload);

        Assert.True(success);
        ArticleListItemReadModel item = Assert.Single(decoded!.Items);
        Assert.Equal(created, item.CreateTime);
        Assert.Equal(DateTimeKind.Utc, item.CreateTime.Kind);
        Assert.Equal(scheduled, item.ScheduledPublishAt);
        Assert.Equal(DateTimeKind.Utc, item.ScheduledPublishAt!.Value.Kind);
        Assert.Equal(published, item.PublishedAt);
        Assert.Equal(DateTimeKind.Utc, item.PublishedAt!.Value.Kind);
    }

    [Theory]
    [InlineData(DateTimeKind.Unspecified)]
    [InlineData(DateTimeKind.Local)]
    public void ArticleListPage_NonUtcDateTimes_AreRejected(DateTimeKind kind)
    {
        var page = new ArticleListPageReadModel
        {
            Total = 1,
            Items = [CreateItem(new DateTime(2026, 6, 25, 9, 30, 0, kind))]
        };

        var ex = Assert.Throws<InvalidOperationException>(() => ServerCacheBinaryCodec.EncodeArticleListPage(page));

        Assert.Contains("UTC", ex.Message, StringComparison.Ordinal);
    }

    private static ArticleListItemReadModel CreateItem(DateTime createTime)
        => new()
        {
            Id = 1,
            Title = "Article",
            Summary = "Summary",
            CoverImageUrl = "/cover.webp",
            Snippet = "Snippet",
            Views = 1,
            CreateTime = createTime,
            CategoryId = 2,
            CategoryName = "Category",
            Tags = [new TagReadModel { Id = 3, Name = "Tag" }],
            IsDeleted = false,
            Status = ArticleStatus.Published
        };
}
