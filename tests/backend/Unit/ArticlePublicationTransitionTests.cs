using FsusBlog.Contracts.Articles;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePublicationTransitionTests
{
    private static readonly DateTime s_now = new(2026, 7, 19, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void CreatePlan_NewScheduledArticle_StoresScheduledDeadline()
    {
        DateTime dueAt = s_now.AddHours(2);

        ArticlePublicationTransitionPlan plan = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: false,
            ArticleStatus.Scheduled,
            dueAt,
            s_now);

        Assert.Equal(ArticleStatus.Scheduled, plan.StoredStatus);
        Assert.Equal(dueAt, plan.ScheduledPublishAt);
        Assert.Null(plan.PendingPublicationAt);
        Assert.False(plan.CreatePublication);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CreatePlan_PublishedArticleScheduledRevision_PreservesCurrentPublicState()
    {
        DateTime dueAt = s_now.AddHours(2);

        ArticlePublicationTransitionPlan plan = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: true,
            ArticleStatus.Scheduled,
            dueAt,
            s_now);

        Assert.Equal(ArticleStatus.Published, plan.StoredStatus);
        Assert.Null(plan.ScheduledPublishAt);
        Assert.Equal(dueAt, plan.PendingPublicationAt);
        Assert.False(plan.CreatePublication);
    }

    [Theory]
    [InlineData(ArticleStatus.Published, true, false)]
    [InlineData(ArticleStatus.Archived, false, true)]
    [InlineData(ArticleStatus.Draft, false, false)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CreatePlan_CommonTransitions_AreDeterministic(
        ArticleStatus targetStatus,
        bool createsPublication,
        bool archives)
    {
        ArticlePublicationTransitionPlan plan = ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: true,
            targetStatus,
            scheduledPublishAt: null,
            s_now);

        Assert.Equal(targetStatus, plan.StoredStatus);
        Assert.Equal(createsPublication, plan.CreatePublication);
        Assert.Equal(archives ? s_now : null, plan.ArchivedAt);
        Assert.Equal(createsPublication ? s_now : null, plan.PublishedAt);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-plan-past-scheduled-deadline-is-rejected")]
    public void CreatePlan_PastScheduledDeadline_IsRejected()
    {
        ArticleStatusTransitionValidationException error = Assert.Throws<ArticleStatusTransitionValidationException>(
            () => ArticlePublicationTransitionWriter.CreatePlan(
                hasCurrentPublication: false,
                ArticleStatus.Scheduled,
                s_now,
                s_now));

        Assert.Equal(ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture, error.Validation.Code);
    }

    public static TheoryData<ArticleStatus, ArticleStatus, bool> CompleteStateMatrix => new()
    {
        { ArticleStatus.Draft, ArticleStatus.Draft, true },
        { ArticleStatus.Draft, ArticleStatus.Scheduled, true },
        { ArticleStatus.Draft, ArticleStatus.Published, true },
        { ArticleStatus.Draft, ArticleStatus.Archived, true },
        { ArticleStatus.Draft, ArticleStatus.Deleted, false },
        { ArticleStatus.Scheduled, ArticleStatus.Draft, true },
        { ArticleStatus.Scheduled, ArticleStatus.Scheduled, true },
        { ArticleStatus.Scheduled, ArticleStatus.Published, true },
        { ArticleStatus.Scheduled, ArticleStatus.Archived, true },
        { ArticleStatus.Scheduled, ArticleStatus.Deleted, false },
        { ArticleStatus.Published, ArticleStatus.Draft, true },
        { ArticleStatus.Published, ArticleStatus.Scheduled, true },
        { ArticleStatus.Published, ArticleStatus.Published, true },
        { ArticleStatus.Published, ArticleStatus.Archived, true },
        { ArticleStatus.Published, ArticleStatus.Deleted, false },
        { ArticleStatus.Archived, ArticleStatus.Draft, true },
        { ArticleStatus.Archived, ArticleStatus.Scheduled, true },
        { ArticleStatus.Archived, ArticleStatus.Published, true },
        { ArticleStatus.Archived, ArticleStatus.Archived, true },
        { ArticleStatus.Archived, ArticleStatus.Deleted, false },
        { ArticleStatus.Deleted, ArticleStatus.Draft, false },
        { ArticleStatus.Deleted, ArticleStatus.Scheduled, false },
        { ArticleStatus.Deleted, ArticleStatus.Published, true },
        { ArticleStatus.Deleted, ArticleStatus.Archived, false },
        { ArticleStatus.Deleted, ArticleStatus.Deleted, false }
    };

    [Theory]
    [MemberData(nameof(CompleteStateMatrix))]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-validate-transition-covers-complete-state-matrix")]
    public void ValidateTransition_CoversCompleteStateMatrix(
        ArticleStatus source,
        ArticleStatus target,
        bool expectedAllowed)
    {
        ArticleStatusTransitionOperation operation = source == ArticleStatus.Deleted
            && target == ArticleStatus.Published
                ? ArticleStatusTransitionOperation.Restore
                : ArticleStatusTransitionOperation.Update;
        DateTime? scheduledAt = target == ArticleStatus.Scheduled ? s_now.AddMinutes(5) : null;

        ArticleStatusTransitionValidation? result = ArticleStatusTransitionPolicy.ValidateTransition(
            (int)source,
            (int)target,
            scheduledAt,
            s_now,
            operation);

        Assert.Equal(expectedAllowed, !result.HasValue);
        if (!expectedAllowed)
        {
            Assert.Contains(
                result!.Value.Code,
                new[]
                {
                    ArticleStatusTransitionErrorCodes.DeletedRequiresDeleteFlow,
                    ArticleStatusTransitionErrorCodes.InvalidTransition
                });
        }
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(6)]
    [InlineData(int.MaxValue)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-validate-target-undefined-status-is-rejected-with-stable-code")]
    public void ValidateTarget_UndefinedStatus_IsRejectedWithStableCode(int status)
    {
        ArticleStatusTransitionValidation validation = Assert.IsType<ArticleStatusTransitionValidation>(
            ArticleStatusTransitionPolicy.ValidateTarget(status, null, s_now));

        Assert.Equal(ArticleStatusTransitionErrorCodes.UndefinedStatus, validation.Code);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-validate-target-missing-scheduled-timestamp-is-rejected-with-stable-code")]
    public void ValidateTarget_MissingScheduledTimestamp_IsRejectedWithStableCode()
    {
        ArticleStatusTransitionValidation validation = Assert.IsType<ArticleStatusTransitionValidation>(
            ArticleStatusTransitionPolicy.ValidateTarget((int)ArticleStatus.Scheduled, null, s_now));

        Assert.Equal(ArticleStatusTransitionErrorCodes.ScheduledAtRequired, validation.Code);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-validate-target-timestamp-on-non-scheduled-state-is-rejected-with-stable-code")]
    public void ValidateTarget_TimestampOnNonScheduledState_IsRejectedWithStableCode()
    {
        ArticleStatusTransitionValidation validation = Assert.IsType<ArticleStatusTransitionValidation>(
            ArticleStatusTransitionPolicy.ValidateTarget(
                (int)ArticleStatus.Published,
                s_now.AddMinutes(5),
                s_now));

        Assert.Equal(ArticleStatusTransitionErrorCodes.ScheduledAtNotAllowed, validation.Code);
    }

    [Theory]
    [InlineData(ArticleStatusTransitionOperation.Rollback, ArticleStatus.Draft, ArticleStatus.Published, true)]
    [InlineData(ArticleStatusTransitionOperation.Rollback, ArticleStatus.Draft, ArticleStatus.Draft, true)]
    [InlineData(ArticleStatusTransitionOperation.Rollback, ArticleStatus.Published, ArticleStatus.Archived, true)]
    [InlineData(ArticleStatusTransitionOperation.Rollback, ArticleStatus.Archived, ArticleStatus.Scheduled, false)]
    [InlineData(ArticleStatusTransitionOperation.Restore, ArticleStatus.Deleted, ArticleStatus.Published, true)]
    [InlineData(ArticleStatusTransitionOperation.Restore, ArticleStatus.Archived, ArticleStatus.Published, false)]
    [InlineData(ArticleStatusTransitionOperation.ScheduledPublish, ArticleStatus.Scheduled, ArticleStatus.Published, true)]
    [InlineData(ArticleStatusTransitionOperation.ScheduledPublish, ArticleStatus.Published, ArticleStatus.Published, true)]
    [InlineData(ArticleStatusTransitionOperation.ScheduledPublish, ArticleStatus.Draft, ArticleStatus.Published, false)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-validate-transition-enforces-operation-specific-sources")]
    public void ValidateTransition_EnforcesOperationSpecificSources(
        ArticleStatusTransitionOperation operation,
        ArticleStatus source,
        ArticleStatus target,
        bool expectedAllowed)
    {
        ArticleStatusTransitionValidation? result = ArticleStatusTransitionPolicy.ValidateTransition(
            (int)source,
            (int)target,
            null,
            s_now,
            operation);

        Assert.Equal(expectedAllowed, !result.HasValue);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void BuildOutboxPayload_BindsExactRevisionAndPublication()
    {
        var version = new ArticleVersionCoordinates(801, 7, 901, 1001, 1201, 4);

        string payload = ArticlePublicationTransitionWriter.BuildOutboxPayload(
            articleId: 42,
            eventType: "article-updated",
            version);

        using JsonDocument document = JsonDocument.Parse(payload);
        JsonElement root = document.RootElement;
        Assert.Equal(42, root.GetProperty("articleId").GetInt32());
        Assert.Equal("article-updated", root.GetProperty("eventType").GetString());
        Assert.Equal(801, root.GetProperty("articleRevisionId").GetInt64());
        Assert.Equal(7, root.GetProperty("revisionNo").GetInt32());
        Assert.Equal(901, root.GetProperty("rightsSnapshotId").GetInt64());
        Assert.Equal(1001, root.GetProperty("responsibilitySnapshotId").GetInt64());
        Assert.Equal(1201, root.GetProperty("releaseId").GetInt64());
        Assert.Equal(4, root.GetProperty("releaseNo").GetInt32());
    }
}
