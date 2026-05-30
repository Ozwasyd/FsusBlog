using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class CommentProjection
{
    public static UserCommentResponse ToResponse(UserCommentReadModel model)
        => new()
        {
            Id = model.Id,
            Content = model.Content,
            CreateTime = model.CreateTime,
            ArticleId = model.ArticleId,
            ArticleTitle = model.ArticleTitle,
            RootId = model.RootId,
            ReplyToUserName = model.ReplyToUserName
        };

    public static UserCommentCoreModel ToCoreModel(UserCommentReadModel model)
    {
        var pod = PodProjector.ProjectUserComment(
            model.Id,
            model.ArticleId,
            model.CreateTime,
            model.Content,
            model.ArticleTitle,
            model.RootId,
            model.ReplyToUserName,
            out _);
        return new UserCommentCoreModel(
            pod,
            model.Id,
            model.Content,
            model.CreateTime,
            model.ArticleId,
            model.ArticleTitle,
            model.RootId,
            model.ReplyToUserName);
    }
}
