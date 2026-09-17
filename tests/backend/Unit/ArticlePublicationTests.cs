using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePublicationTests
{
    private static readonly DateTime s_now = new(2026, 5, 18, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void IsPubliclyVisible_PublishedArticleWithPastPublishTime_ReturnsTrue()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = s_now.AddMinutes(-1)
        };

        Assert.True(ArticlePublication.IsPubliclyVisible(article, s_now));
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
            PublishedAt = s_now.AddMinutes(-1),
            ScheduledPublishAt = status == ArticleStatus.Scheduled ? s_now.AddMinutes(-1) : null
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, s_now));
    }

    [Fact]
    public void IsPubliclyVisible_FuturePublishedAt_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = s_now.AddMinutes(1)
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, s_now));
    }

    [Fact]
    public void IsPubliclyVisible_FutureScheduledPublishAt_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = s_now.AddMinutes(-1),
            ScheduledPublishAt = s_now.AddMinutes(1)
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, s_now));
    }

    [Fact]
    public void IsPubliclyVisible_DeletedArticle_ReturnsFalse()
    {
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = s_now.AddMinutes(-1),
            IsDeleted = true
        };

        Assert.False(ArticlePublication.IsPubliclyVisible(article, s_now));
    }

    [Theory]
    [InlineData(ArticleStatus.Draft, false, -1, -1)]
    [InlineData(ArticleStatus.Scheduled, false, -1, -1)]
    [InlineData(ArticleStatus.Archived, false, -1, -1)]
    [InlineData(ArticleStatus.Deleted, false, -1, -1)]
    [InlineData(ArticleStatus.Published, true, -1, -1)]
    [InlineData(ArticleStatus.Published, false, 1, -1)]
    [InlineData(ArticleStatus.Published, false, -1, 1)]
    public void PublicHotArtifactProjector_FinalVisibilityGateRejectsNonPublicInputs(
        ArticleStatus status,
        bool isDeleted,
        int publishedOffsetMinutes,
        int scheduledOffsetMinutes)
    {
        var article = new ArticleDetailReadModel
        {
            Id = 42,
            Status = status,
            IsDeleted = isDeleted,
            PublishedAt = s_now.AddMinutes(publishedOffsetMinutes),
            ScheduledPublishAt = s_now.AddMinutes(scheduledOffsetMinutes)
        };

        Assert.False(PublicHotArtifactProjector.IsPubliclyVisible(article, s_now));
    }
}
