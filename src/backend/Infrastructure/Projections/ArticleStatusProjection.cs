using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class ArticleStatusProjection
{
    public static ArticleStatus Normalize(int status)
    {
        if (IsDefined(status))
        {
            return (ArticleStatus)status;
        }

        throw new ArticleStatusTransitionValidationException(new(
            ArticleStatusTransitionErrorCodes.UndefinedStatus,
            "文章状态未定义"));
    }

    public static bool IsDefined(int status)
        => ArticleStatusTransitionPolicy.IsDefined(status);
}
