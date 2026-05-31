using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Shared.Contracts.Outputs;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBootstrapProviderTests
{
    [Fact]
    public async Task ArticleDetailProvider_DoesNotFallbackToPublicCacheWhenPrivateArticleIsHidden()
    {
        var articleService = Substitute.For<IArticleService>();
        articleService.GetByIdAsync(123, includePrivate: true).Returns(new ArticleDetailReadModel
        {
            Id = 123,
            Title = "scheduled",
            Content = "body",
            Summary = "summary",
            CategoryId = 1,
            CategoryName = "category",
            Status = ArticleStatus.Scheduled,
            ScheduledPublishAt = DateTime.UtcNow.AddHours(1),
            PublishedAt = null
        });

        var provider = new PublicAotArticleDetailBootstrapProvider(
            articleService,
            new RelatedReadingService(Substitute.For<ISqlSugarClient>()),
            CreateSystemService());

        Result<PublicPageSnapshot> result = await provider.BuildSnapshotAsync(
            new PublicAotRouteMatch(
                PublicPageKind.ArticleDetail,
                PublicPageId.ArticleDetail,
                "article:123",
                "/article/123",
                "/article/123",
                string.Empty));

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        await articleService.Received(1).GetByIdAsync(123, includePrivate: true);
        await articleService.DidNotReceive().GetByIdAsync(123);
    }

    [Fact]
    public async Task ArticleDetailProvider_UsesPublicReadFallbackWhenPrivateReadMisses()
    {
        var articleService = Substitute.For<IArticleService>();
        articleService.GetByIdAsync(123, includePrivate: true).Returns((ArticleDetailReadModel?)null);
        articleService.GetByIdAsync(123).Returns((ArticleDetailReadModel?)null);

        var provider = new PublicAotArticleDetailBootstrapProvider(
            articleService,
            new RelatedReadingService(Substitute.For<ISqlSugarClient>()),
            CreateSystemService());

        Result<PublicPageSnapshot> result = await provider.BuildSnapshotAsync(
            new PublicAotRouteMatch(
                PublicPageKind.ArticleDetail,
                PublicPageId.ArticleDetail,
                "article:123",
                "/article/123",
                "/article/123",
                string.Empty));

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
        await articleService.Received(1).GetByIdAsync(123, includePrivate: true);
        await articleService.Received(1).GetByIdAsync(123);
    }

    private static ISystemService CreateSystemService()
    {
        var systemService = Substitute.For<ISystemService>();
        systemService.GetSeoConfigAsync().Returns(new SeoConfigReadModel());
        return systemService;
    }
}
