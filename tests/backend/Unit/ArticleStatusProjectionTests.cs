using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Projections;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleStatusProjectionTests
{
    [Theory]
    [InlineData(0, ArticleStatus.Draft, true)]
    [InlineData(1, ArticleStatus.Scheduled, true)]
    [InlineData(2, ArticleStatus.Published, true)]
    [InlineData(3, ArticleStatus.Archived, true)]
    [InlineData(4, ArticleStatus.Deleted, true)]
    [InlineData(5, ArticleStatus.Inbox, true)]
    public void NormalizeAndIsDefined_RecognizeOnlyDeclaredArticleStatuses(
        int raw,
        ArticleStatus expected,
        bool isDefined)
    {
        Assert.Equal(expected, ArticleStatusProjection.Normalize(raw));
        Assert.Equal(isDefined, ArticleStatusProjection.IsDefined(raw));
    }

    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(-1)]
    [InlineData(6)]
    [InlineData(int.MaxValue)]
    public void Normalize_UndefinedStatus_FailsClosed(int raw)
    {
        ArticleStatusTransitionValidationException error = Assert.Throws<ArticleStatusTransitionValidationException>(
            () => ArticleStatusProjection.Normalize(raw));

        Assert.False(ArticleStatusProjection.IsDefined(raw));
        Assert.Equal(ArticleStatusTransitionErrorCodes.UndefinedStatus, error.Validation.Code);
    }
}
