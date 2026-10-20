using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleSourceGenerationAuthorityTests
{
    [Theory]
    [InlineData(ArticleMutationEventTypes.Created)]
    [InlineData(ArticleMutationEventTypes.Updated)]
    [InlineData(ArticleMutationEventTypes.Deleted)]
    [InlineData(ArticleMutationEventTypes.Restored)]
    [InlineData(ArticleMutationEventTypes.PermanentlyDeleted)]
    [InlineData(ArticleMutationEventTypes.TrashCleared)]
    [InlineData(ArticleMutationEventTypes.ScheduledPublished)]
    [InlineData(ArticleMutationEventTypes.CategoryUpdated)]
    [InlineData(ArticleMutationEventTypes.TagUpdated)]
    [InlineData(ArticleMutationEventTypes.RightsProofUpdated)]
    [InlineData(ArticleMutationEventTypes.ResponsibilityUpdated)]
    public void OriginalProducer_AllSupportedEventTypesValidate(string eventType)
    {
        Assert.Equal(11, ArticleMutationEventTypes.All.Count);
        ArticleSourceGenerationAuthority.ValidateEvent(Event(eventType));
    }

    [Theory]
    [InlineData("missing-row")]
    [InlineData("missing-article")]
    [InlineData("empty-event-id")]
    [InlineData("wrong-owner")]
    [InlineData("legacy-schema")]
    [InlineData("future-schema")]
    [InlineData("unknown-type")]
    [InlineData("missing-revision")]
    [InlineData("tampered-revision")]
    [InlineData("missing-rights")]
    [InlineData("unpaired-publication")]
    [InlineData("unpaired-responsibility")]
    public void InvalidOriginalFacts_FailClosed(string fault)
    {
        ArticleMutationOutboxEvent item = Event(ArticleMutationEventTypes.Created);
        switch (fault)
        {
            case "missing-row":
                item.Id = 0;
                break;
            case "missing-article":
                item.AggregateId = 0;
                break;
            case "empty-event-id":
                item.EventId = Guid.Empty.ToString("N");
                break;
            case "wrong-owner":
                item.AggregateType = "comment";
                break;
            case "legacy-schema":
                item.SchemaVersion = 1;
                break;
            case "future-schema":
                item.SchemaVersion = 3;
                break;
            case "unknown-type":
                item.EventType = "source-test-unknown";
                break;
            case "missing-revision":
                item.ArticleRevisionId = null;
                break;
            case "tampered-revision":
                item.RevisionNo = 2;
                break;
            case "missing-rights":
                item.RightsSnapshotId = null;
                break;
            case "unpaired-publication":
                item.PublicationNo = 1;
                break;
            case "unpaired-responsibility":
                item.ResponsibilityVersion = 1;
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(fault));
        }
        Assert.Throws<InvalidOperationException>(() => ArticleSourceGenerationAuthority.ValidateEvent(item));
    }

    private static ArticleMutationOutboxEvent Event(string eventType)
    {
        ArticleMutationOutboxEvent item = ArticleMutationOutboxProducer.Create(
            1, eventType, new ArticleVersionCoordinates(10, 1, 20, null, null, null),
            null, new ArticleMutationScopeSnapshot(1, [], "draft"),
            new DateTime(2026, 10, 9, 0, 0, 0, DateTimeKind.Utc));
        item.Id = 1;
        return item;
    }
}
