namespace FsusBlog.Contracts.Articles;

/// <summary>The existing current article status values, validated by the shared transition policy.</summary>
public static class ArticleStatusValues
{
    /// <summary>Unpublished editing state.</summary>
    public const int Draft = 0;
    /// <summary>Pending scheduled publication.</summary>
    public const int Scheduled = 1;
    /// <summary>Published state; visibility still requires valid publication coordinates.</summary>
    public const int Published = 2;
    /// <summary>Archived, non-public state.</summary>
    public const int Archived = 3;
    /// <summary>Deleted state, entered through the existing deletion flow.</summary>
    public const int Deleted = 4;
    /// <summary>Explicitly captured, unpublished content awaiting triage.</summary>
    public const int Inbox = 5;

    /// <summary>The sole stable lifecycle token projection; unknown values fail closed.</summary>
    public static string Token(int status) => status switch
    {
        Draft => "draft",
        Scheduled => "scheduled",
        Published => "published",
        Archived => "archived",
        Deleted => "deleted",
        Inbox => "inbox",
        _ => throw new ArgumentOutOfRangeException(nameof(status))
    };
}

/// <summary>Stable current article target/transition validation error codes.</summary>
public static class ArticleStatusTransitionErrorCodes
{
    /// <summary>The requested or source status is outside the defined set.</summary>
    public const string UndefinedStatus = "article_status_undefined";
    /// <summary>A Scheduled target has no scheduled publication time.</summary>
    public const string ScheduledAtRequired = "article_scheduled_at_required";
    /// <summary>The scheduled publication time is not later than the supplied current time.</summary>
    public const string ScheduledAtMustBeFuture = "article_scheduled_at_must_be_future";
    /// <summary>A non-Scheduled target carries a scheduled publication time.</summary>
    public const string ScheduledAtNotAllowed = "article_scheduled_at_not_allowed";
    /// <summary>An ordinary target write attempted to enter Deleted.</summary>
    public const string DeletedRequiresDeleteFlow = "article_deleted_requires_delete_flow";
    /// <summary>The source, target and operation do not form an allowed transition.</summary>
    public const string InvalidTransition = "article_status_transition_invalid";
}

/// <summary>Existing operation distinctions used by the current transition matrix.</summary>
public enum ArticleStatusTransitionOperation
{
    /// <summary>Create with equal source and target status.</summary>
    Create = 0,
    /// <summary>Update between editable states.</summary>
    Update = 1,
    /// <summary>Rollback from an editable state to Draft, Published or Archived.</summary>
    Rollback = 2,
    /// <summary>Restore a Deleted source to Published.</summary>
    Restore = 3,
    /// <summary>Publish from Scheduled or Published.</summary>
    ScheduledPublish = 4,
    /// <summary>Explicit capture into Inbox, separate from ordinary creation.</summary>
    CreateInbox = 5,
    /// <summary>Explicitly move Draft to Inbox.</summary>
    MoveToInbox = 6,
    /// <summary>Explicitly triage Inbox into Draft.</summary>
    TriageInbox = 7,
    /// <summary>Explicitly archive Inbox.</summary>
    ArchiveInbox = 8,
    /// <summary>Restore Archived to its persisted previous editable source.</summary>
    RestoreArchived = 9
}

/// <summary>A rejected current target or transition, with its stable code and display message.</summary>
public readonly record struct ArticleStatusTransitionValidation(string Code, string Message);

/// <summary>Argument failure carrying the original current transition validation.</summary>
public sealed class ArticleStatusTransitionValidationException(
    ArticleStatusTransitionValidation validation)
    : ArgumentException(validation.Message)
{
    /// <summary>The rejected target or transition details.</summary>
    public ArticleStatusTransitionValidation Validation { get; } = validation;
}

/// <summary>Argument failure carrying an existing current article write error code.</summary>
public sealed class ArticleWriteValidationException(
    string code,
    string message) : ArgumentException(message)
{
    /// <summary>The stable current article write error code.</summary>
    public string Code { get; } = code;
}

/// <summary>The existing pure current target checks and operation-specific transition matrix.</summary>
/// <remarks>Validation does not perform actor admission, persistence, content filtering or publication.</remarks>
public static class ArticleStatusTransitionPolicy
{
    /// <summary>Returns a target/schedule rejection, or null when these pure checks admit the target.</summary>
    /// <param name="targetStatus">The explicit current target status.</param>
    /// <param name="scheduledPublishAt">The requested schedule, required only for Scheduled.</param>
    /// <param name="utcNow">The caller's authoritative current UTC time used for the future-time check.</param>
    /// <returns>The original stable rejection, or null; Deleted requires the separate deletion flow.</returns>
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

    /// <summary>Validates the target first, then the existing operation-specific source/target edge.</summary>
    /// <param name="sourceStatus">The explicit persisted source status.</param>
    /// <param name="targetStatus">The requested current target status.</param>
    /// <param name="scheduledPublishAt">The requested schedule passed to target validation.</param>
    /// <param name="utcNow">The caller's authoritative current UTC time.</param>
    /// <param name="operation">The existing operation selecting the allowed transition edges.</param>
    /// <param name="previousEditableStatus">Persisted archive provenance; absent values never authorize editable restore.</param>
    /// <returns>The first target or transition rejection, or null; this is not a write grant.</returns>
    public static ArticleStatusTransitionValidation? ValidateTransition(
        int sourceStatus,
        int targetStatus,
        DateTime? scheduledPublishAt,
        DateTime utcNow,
        ArticleStatusTransitionOperation operation,
        int? previousEditableStatus = null)
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

        // Recorded editable provenance cannot be bypassed by a generic update or rollback.
        if (sourceStatus == ArticleStatusValues.Archived
            && previousEditableStatus is ArticleStatusValues.Draft or ArticleStatusValues.Inbox
            && targetStatus != ArticleStatusValues.Archived
            && operation != ArticleStatusTransitionOperation.RestoreArchived)
        {
            return new(ArticleStatusTransitionErrorCodes.InvalidTransition,
                "Archived 必须显式恢复到记录的来源状态");
        }

        bool allowed = operation switch
        {
            ArticleStatusTransitionOperation.Create => sourceStatus == targetStatus
                && targetStatus != ArticleStatusValues.Inbox,
            ArticleStatusTransitionOperation.CreateInbox => sourceStatus == ArticleStatusValues.Inbox
                && targetStatus == ArticleStatusValues.Inbox,
            ArticleStatusTransitionOperation.Update => (IsEditable(sourceStatus) && IsEditable(targetStatus))
                || (sourceStatus == ArticleStatusValues.Inbox && targetStatus == ArticleStatusValues.Inbox),
            ArticleStatusTransitionOperation.MoveToInbox => sourceStatus == ArticleStatusValues.Draft
                && targetStatus == ArticleStatusValues.Inbox,
            ArticleStatusTransitionOperation.TriageInbox => sourceStatus == ArticleStatusValues.Inbox
                && targetStatus == ArticleStatusValues.Draft,
            ArticleStatusTransitionOperation.ArchiveInbox => sourceStatus == ArticleStatusValues.Inbox
                && targetStatus == ArticleStatusValues.Archived,
            ArticleStatusTransitionOperation.RestoreArchived => sourceStatus == ArticleStatusValues.Archived
                && targetStatus is ArticleStatusValues.Inbox or ArticleStatusValues.Draft
                && targetStatus == previousEditableStatus,
            ArticleStatusTransitionOperation.Rollback => IsEditable(sourceStatus)
                && targetStatus is ArticleStatusValues.Draft
                    or ArticleStatusValues.Published
                    or ArticleStatusValues.Archived,
            ArticleStatusTransitionOperation.Restore => sourceStatus == ArticleStatusValues.Deleted
                && targetStatus == ArticleStatusValues.Published
                && previousEditableStatus != ArticleStatusValues.Inbox,
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

    /// <summary>Checks only membership in the current status set, not write or transition eligibility.</summary>
    public static bool IsDefined(int status)
        => status is >= ArticleStatusValues.Draft and <= ArticleStatusValues.Inbox;

    private static bool IsEditable(int status)
        => status is ArticleStatusValues.Draft
            or ArticleStatusValues.Scheduled
            or ArticleStatusValues.Published
            or ArticleStatusValues.Archived;
}
