using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Projections;

public static class CommentProjection
{
    public static UserCommentResponse ToResponse(UserCommentReadModel model)
    {
        UserCommentVisibilityView visibility = ResolveUserCommentVisibility(
            model.ModerationStatus,
            model.IsDeleted,
            model.HasBlockedRegions);

        return new()
        {
            Id = model.Id,
            Content = model.Content,
            CreateTime = model.CreateTime,
            ArticleId = model.ArticleId,
            ArticleTitle = model.ArticleTitle,
            RootId = model.RootId,
            ReplyToUserName = model.ReplyToUserName,
            ModerationStatus = model.ModerationStatus,
            ModerationStatusLabel = visibility.Label,
            VisibilityState = visibility.State,
            VisibilityReasonCode = visibility.ReasonCode,
            IsPubliclyVisible = visibility.IsPubliclyVisible
        };
    }

    public static UserCommentCoreModel ToCoreModel(UserCommentReadModel model)
    {
        UserCommentVisibilityView visibility = ResolveUserCommentVisibility(
            model.ModerationStatus,
            model.IsDeleted,
            model.HasBlockedRegions);
        var pod = PodProjector.ProjectUserComment(
            model.Id,
            model.ArticleId,
            model.CreateTime,
            model.Content,
            model.ArticleTitle,
            model.RootId,
            model.ReplyToUserName,
            model.ModerationStatus,
            visibility.Label,
            visibility.State,
            visibility.ReasonCode,
            visibility.IsPubliclyVisible,
            out _);
        return new UserCommentCoreModel(
            pod,
            model.Id,
            model.Content,
            model.CreateTime,
            model.ArticleId,
            model.ArticleTitle,
            model.RootId,
            model.ReplyToUserName,
            model.ModerationStatus,
            visibility.Label,
            visibility.State,
            visibility.ReasonCode,
            visibility.IsPubliclyVisible);
    }

    private static UserCommentVisibilityView ResolveUserCommentVisibility(
        int moderationStatus,
        bool isDeleted,
        bool hasBlockedRegions)
    {
        if (isDeleted)
        {
            return new("已删除", "deleted", "deleted_by_user_or_admin", false);
        }

        return moderationStatus switch
        {
            0 => new UserCommentVisibilityView("待审核，仅自己可见", "pending", "pending_review", false),
            1 when hasBlockedRegions => new UserCommentVisibilityView("已公开", "limited", "geo_limited", true),
            1 => new UserCommentVisibilityView("已公开", "public", "approved_public", true),
            2 => new UserCommentVisibilityView("未通过审核", "rejected", "rejected_by_moderation", false),
            3 => new UserCommentVisibilityView("已隐藏", "hidden", "hidden_by_moderation", false),
            _ => new UserCommentVisibilityView("待审核，仅自己可见", "pending", "pending_review", false)
        };
    }

    private readonly record struct UserCommentVisibilityView(
        string Label,
        string State,
        string ReasonCode,
        bool IsPubliclyVisible);
}
