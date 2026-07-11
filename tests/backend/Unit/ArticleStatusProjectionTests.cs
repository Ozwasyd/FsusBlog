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
    [InlineData(int.MinValue, ArticleStatus.Published, false)]
    [InlineData(-1, ArticleStatus.Published, false)]
    [InlineData(5, ArticleStatus.Published, false)]
    [InlineData(int.MaxValue, ArticleStatus.Published, false)]
    public void NormalizeAndIsDefined_RecognizeOnlyDeclaredArticleStatuses(
        int raw,
        ArticleStatus expected,
        bool isDefined)
    {
        Assert.Equal(expected, ArticleStatusProjection.Normalize(raw));
        Assert.Equal(isDefined, ArticleStatusProjection.IsDefined(raw));
    }
}
