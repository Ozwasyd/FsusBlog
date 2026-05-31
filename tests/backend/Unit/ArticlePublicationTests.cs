using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePublicationTests
{
    private static readonly DateTime Now = new(2026, 5, 18, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void IsPubliclyVisible_PublishedArticleWithPastPublishTime_ReturnsTrue()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = Now.AddMinutes(-1)
        };

        Assert.True(ArticlePublication.IsPubliclyVisible(article, Now));
    }

    [Theory]
    [InlineData(ArticleStatus.Draft)]
    [InlineData(ArticleStatus.Scheduled)]
    [InlineData(ArticleStatus.Archived)]
    [InlineData(ArticleStatus.Deleted)]
    public void IsPubliclyVisible_NonPublishedState_ReturnsFalse(ArticleStatus status)
    {
        var article = new Article
        {
            Status = status,
            PublishedAt = Now.AddMinutes(-1),
            ScheduledPublishAt = status == ArticleStatus.Scheduled ? Now.AddMinutes(-1) : null
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, Now));
    }

    [Fact]
    public void IsPubliclyVisible_FuturePublishedAt_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = Now.AddMinutes(1)
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, Now));
    }

    [Fact]
    public void IsPubliclyVisible_FutureScheduledPublishAt_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = Now.AddMinutes(-1),
            ScheduledPublishAt = Now.AddMinutes(1)
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, Now));
    }

    [Fact]
    public void IsPubliclyVisible_DeletedArticle_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = Now.AddMinutes(-1),
            IsDeleted = true
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, Now));
    }
}
