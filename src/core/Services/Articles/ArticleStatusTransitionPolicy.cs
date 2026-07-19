namespace FsusBlog.Core.Services.Articles;

public static class ArticleStatusValues
{
    public const int Draft = 0;
    public const int Scheduled = 1;
    public const int Published = 2;
    public const int Archived = 3;
    public const int Deleted = 4;
}

public static class ArticleStatusTransitionErrorCodes
{
    public const string UndefinedStatus = "article_status_undefined";
    public const string ScheduledAtRequired = "article_scheduled_at_required";
    public const string ScheduledAtMustBeFuture = "article_scheduled_at_must_be_future";
    public const string ScheduledAtNotAllowed = "article_scheduled_at_not_allowed";
    public const string DeletedRequiresDeleteFlow = "article_deleted_requires_delete_flow";
    public const string InvalidTransition = "article_status_transition_invalid";
}

public enum ArticleStatusTransitionOperation
{
    Create = 0,
    Update = 1,
    Rollback = 2,
    Restore = 3,
    ScheduledPublish = 4
}

public readonly record struct ArticleStatusTransitionValidation(string Code, string Message);

public sealed class ArticleStatusTransitionValidationException(
    ArticleStatusTransitionValidation validation)
    : ArgumentException(validation.Message)
{
    public ArticleStatusTransitionValidation Validation { get; } = validation;
}

public static class ArticleStatusTransitionPolicy
{
    public static ArticleStatusTransitionValidation? ValidateTarget(
        int targetStatus,
        DateTime? scheduledPublishAt,
        DateTime utcNow)
    {
        if (!IsDefined(targetStatus))
        {
            return new(
                ArticleStatusTransitionErrorCodes.UndefinedStatus,
                "文章状态未定义");
        }

        if (targetStatus == ArticleStatusValues.Deleted)
        {
            return new(
                ArticleStatusTransitionErrorCodes.DeletedRequiresDeleteFlow,
                "Deleted 只能通过删除流程进入");
        }

        if (targetStatus == ArticleStatusValues.Scheduled)
        {
            if (!scheduledPublishAt.HasValue)
            {
                return new(
                    ArticleStatusTransitionErrorCodes.ScheduledAtRequired,
                    "Scheduled 状态必须提供计划发布时间");
            }

            if (scheduledPublishAt.Value <= utcNow)
            {
                return new(
                    ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture,
                    "计划发布时间必须晚于当前时间");
            }

            return null;
        }

        return scheduledPublishAt.HasValue
            ? new(
                ArticleStatusTransitionErrorCodes.ScheduledAtNotAllowed,
                "非 Scheduled 状态不得提供计划发布时间")
            : null;
    }

    public static ArticleStatusTransitionValidation? ValidateTransition(
        int sourceStatus,
        int targetStatus,
        DateTime? scheduledPublishAt,
        DateTime utcNow,
        ArticleStatusTransitionOperation operation)
    {
        if (!IsDefined(sourceStatus))
        {
            return new(
                ArticleStatusTransitionErrorCodes.UndefinedStatus,
                "文章当前状态未定义");
        }

        ArticleStatusTransitionValidation? targetValidation = ValidateTarget(
            targetStatus,
            scheduledPublishAt,
            utcNow);
        if (targetValidation.HasValue)
        {
            return targetValidation;
        }

        bool allowed = operation switch
        {
            ArticleStatusTransitionOperation.Create => sourceStatus == targetStatus,
            ArticleStatusTransitionOperation.Update => IsEditable(sourceStatus) && IsEditable(targetStatus),
            ArticleStatusTransitionOperation.Rollback => IsEditable(sourceStatus)
                && targetStatus == ArticleStatusValues.Published,
            ArticleStatusTransitionOperation.Restore => sourceStatus == ArticleStatusValues.Deleted
                && targetStatus == ArticleStatusValues.Published,
            ArticleStatusTransitionOperation.ScheduledPublish => sourceStatus is ArticleStatusValues.Scheduled
                    or ArticleStatusValues.Published
                && targetStatus == ArticleStatusValues.Published,
            _ => false
        };

        return allowed
            ? null
            : new(
                ArticleStatusTransitionErrorCodes.InvalidTransition,
                $"文章状态不能从 {sourceStatus} 转换到 {targetStatus}（{operation}）");
    }

    public static bool IsDefined(int status)
        => status is >= ArticleStatusValues.Draft and <= ArticleStatusValues.Deleted;

    private static bool IsEditable(int status)
        => status is ArticleStatusValues.Draft
            or ArticleStatusValues.Scheduled
            or ArticleStatusValues.Published
            or ArticleStatusValues.Archived;
}
