using System.Text.Json;

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
    public void CreatePlan_PastScheduledDeadline_IsRejected()
        => Assert.Throws<ArgumentException>(() => ArticlePublicationTransitionWriter.CreatePlan(
            hasCurrentPublication: false,
            ArticleStatus.Scheduled,
            s_now,
            s_now));

    [Fact]
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
        Assert.Equal(1201, root.GetProperty("articlePublicationId").GetInt64());
        Assert.Equal(4, root.GetProperty("publicationNo").GetInt32());
    }
}
