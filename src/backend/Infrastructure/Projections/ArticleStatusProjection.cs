using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class ArticleStatusProjection
{
    public static ArticleStatus Normalize(int status)
        => IsDefined(status) ? (ArticleStatus)status : ArticleStatus.Published;

    public static bool IsDefined(int status)
        => status is >= (int)ArticleStatus.Draft and <= (int)ArticleStatus.Deleted;
}
