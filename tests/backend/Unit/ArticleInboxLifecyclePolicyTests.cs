using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure source-contract cases; no database, host, fixtures or qualification receipts.</summary>
public sealed class ArticleInboxLifecyclePolicyTests
{
    private static readonly DateTime s_now = new(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void PersistedValuesAndTokens_PreserveExistingCoordinates()
    {
        Assert.Equal(new[] { 0, 1, 2, 3, 4, 5 }, Enum.GetValues<ArticleStatus>().Select(static status => (int)status));
        Assert.Equal(new[] { "draft", "scheduled", "published", "archived", "deleted", "inbox" },
            Enum.GetValues<ArticleStatus>().Select(static status => ArticleStatusValues.Token((int)status)));
        Assert.Equal(ArticleStatusValues.Inbox, (int)AuthorArticleQueryStatus.Inbox);
        Assert.Throws<ArgumentOutOfRangeException>(() => ArticleStatusValues.Token(6));
    }

    [Theory]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Inbox, ArticleStatusTransitionOperation.CreateInbox)]
    [InlineData(ArticleStatus.Draft, ArticleStatus.Inbox, ArticleStatusTransitionOperation.MoveToInbox)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Draft, ArticleStatusTransitionOperation.TriageInbox)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Archived, ArticleStatusTransitionOperation.ArchiveInbox)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Inbox, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Draft, ArticleStatus.Draft, ArticleStatusTransitionOperation.Create)]
    public void ExplicitCommands_AdmitOnlyTheirCanonicalEdge(ArticleStatus source, ArticleStatus target,
        ArticleStatusTransitionOperation operation)
        => Assert.Null(ArticleStatusTransitionPolicy.ValidateTransition((int)source, (int)target, null, s_now, operation));

    [Theory]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Inbox, ArticleStatusTransitionOperation.Create)]
    [InlineData(ArticleStatus.Draft, ArticleStatus.Draft, ArticleStatusTransitionOperation.CreateInbox)]
    [InlineData(ArticleStatus.Draft, ArticleStatus.Inbox, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Draft, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Archived, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Published, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Scheduled, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Deleted, ArticleStatusTransitionOperation.Update)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Published, ArticleStatusTransitionOperation.Rollback)]
    [InlineData(ArticleStatus.Inbox, ArticleStatus.Published, ArticleStatusTransitionOperation.ScheduledPublish)]
    [InlineData(ArticleStatus.Published, ArticleStatus.Inbox, ArticleStatusTransitionOperation.MoveToInbox)]
    [InlineData(ArticleStatus.Archived, ArticleStatus.Draft, ArticleStatusTransitionOperation.TriageInbox)]
    public void BypassCommands_RefuseBeforeCanonicalWrite(ArticleStatus source, ArticleStatus target,
        ArticleStatusTransitionOperation operation)
        => Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition((int)source, (int)target,
            target == ArticleStatus.Scheduled ? s_now.AddHours(1) : null, s_now, operation));

    [Theory]
    [InlineData(ArticleStatus.Inbox)]
    [InlineData(ArticleStatus.Draft)]
    public void ArchiveRestore_RequiresExactRecordedEditableSource(ArticleStatus previous)
    {
        Assert.Null(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Archived, (int)previous,
            null, s_now, ArticleStatusTransitionOperation.RestoreArchived, (int)previous));
        Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Archived, (int)previous,
            null, s_now, ArticleStatusTransitionOperation.RestoreArchived));
        ArticleStatus wrong = previous == ArticleStatus.Inbox ? ArticleStatus.Draft : ArticleStatus.Inbox;
        Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Archived, (int)wrong,
            null, s_now, ArticleStatusTransitionOperation.RestoreArchived, (int)previous));
        Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Archived,
            ArticleStatusValues.Published, null, s_now, ArticleStatusTransitionOperation.Update, (int)previous));
        Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Archived,
            ArticleStatusValues.Published, null, s_now, ArticleStatusTransitionOperation.Rollback, (int)previous));
    }

    [Fact]
    public void DeletedInbox_CannotUseExistingRestoreToPublishWithoutTriage()
        => Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Deleted,
            ArticleStatusValues.Published, null, s_now, ArticleStatusTransitionOperation.Restore, ArticleStatusValues.Inbox));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Inbox_NeverCreatesPublicationOrBecomesPublicWithHistoricalTimestamps(bool hasPublication)
    {
        ArticlePublicationTransitionPlan plan = ArticlePublicationTransitionWriter.CreatePlan(hasPublication,
            ArticleStatus.Inbox, null, s_now);
        Assert.Equal(ArticleStatus.Inbox, plan.StoredStatus);
        Assert.False(plan.CreatePublication);
        Assert.Null(plan.ScheduledPublishAt);
        Assert.Null(plan.PendingPublicationAt);
        Assert.Null(plan.PublishedAt);
        Assert.False(ArticlePublication.IsPubliclyVisible(ArticleStatus.Inbox, false, s_now.AddDays(-1), null, s_now));
        Assert.Equal("inbox", ArticleMutationVisibility.From(ArticleStatus.Inbox));
    }

    [Fact]
    public void Inbox_RejectsScheduleEvenThroughExplicitCapture()
        => Assert.Equal(ArticleStatusTransitionErrorCodes.ScheduledAtNotAllowed,
            ArticleStatusTransitionPolicy.ValidateTransition(ArticleStatusValues.Inbox, ArticleStatusValues.Inbox,
                s_now.AddHours(1), s_now, ArticleStatusTransitionOperation.CreateInbox)?.Code);
}
