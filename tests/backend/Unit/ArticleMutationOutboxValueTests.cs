using System.Text;

using FsusBlog.Server.Services;

using Outbox = FsusBlog.Contracts.Articles.Outbox;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationOutboxValueTests
{
    public static TheoryData<string> EventTypes => new()
    {
        "created", "updated", "deleted", "restored", "permanently-deleted", "trash-cleared",
        "scheduled-published", "category-updated", "tag-updated", "rights-proof-updated",
        "responsibility-updated"
    };

    [Theory]
    [MemberData(nameof(EventTypes))]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void OriginalEvents_PreserveExactPayloadBytesAndReplay(string eventType)
    {
        DateTime time = new(2026, 7, 20, 6, 30, 0, DateTimeKind.Utc);
        var version = new ArticleVersionCoordinates(1501, 15, 1651, 1701, 1601, 16, 7);
        var before = new ArticleMutationScopeSnapshot(2, [3, 4], "published");
        var after = new ArticleMutationScopeSnapshot(5, [4, 6], "archived");
        var original = ArticleMutationOutboxProducer.Create(1215, eventType, version, before, after, time);
        var value = Outbox.ArticleMutationOutboxValueFactory.Create(original.EventId, 1215, eventType,
            new(1501, 15, 1651, 1701, 1601, 16, 7), new(2, [3, 4], "published"),
            new(5, [4, 6], "archived"), time);
        string expected = "{\"schemaVersion\":2,\"articleId\":1215,\"eventType\":\"" + eventType
            + "\",\"articleRevisionId\":1501,\"revisionNo\":15,\"rightsSnapshotId\":1651,"
            + "\"responsibilitySnapshotId\":1701,\"responsibilityVersion\":7,\"releaseId\":1601,\"releaseNo\":16,"
            + "\"publicUpdatedAt\":\"2026-07-20T06:30:00Z\",\"occurredAt\":\"2026-07-20T06:30:00Z\","
            + "\"before\":{\"categoryId\":2,\"tagIds\":[3,4],\"visibility\":\"published\"},"
            + "\"after\":{\"categoryId\":5,\"tagIds\":[4,6],\"visibility\":\"archived\"}}";

        Assert.Contains(eventType, ArticleMutationEventTypes.All);
        Assert.Equal(11, ArticleMutationEventTypes.All.Count);
        Assert.Equal(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(value.PayloadJson));
        Assert.Equal(original.PayloadJson, value.PayloadJson);
        Assert.Equal(original.EventId, value.EventId);
        Assert.Equal(original.CreatedAt, value.CreatedAt);
        Assert.Equal(original.CreatedAt, original.NextRetryAt);
        Assert.Equal("pending", original.Status);
        Assert.Equal(0, original.RetryCount);
        for (int replay = 0; replay < 2; replay++)
        {
            var envelope = Outbox.ArticleMutationOutboxEnvelopeCodec.Read(value);
            Assert.Equal(value.EventId, envelope.EventId);
            Assert.Equal(time, envelope.OccurredAt);
            Assert.Equal(time, envelope.Version.PublicUpdatedAt);
            Assert.Equal([2, 5], envelope.Scope.CategoryIds);
            Assert.Equal([3, 4, 6], envelope.Scope.TagIds);
            Assert.Equal(expected, value.PayloadJson);
        }
    }

    [Theory]
    [InlineData("{\"schemaVersion\":1}")]
    [InlineData("{\"schemaVersion\":2,\"articleId\":42}")]
    [InlineData("{\"schemaVersion\":2,\"eventType\":\"deleted\"}")]
    [InlineData("{\"schemaVersion\":2,\"articleRevisionId\":999}")]
    [InlineData("{\"schemaVersion\":2,\"releaseId\":1601,\"articlePublicationId\":999}")]
    [InlineData("[]")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative)]
    public void NeutralCodec_PreservesOriginalConflictFailures(string payload)
    {
        var value = Outbox.ArticleMutationOutboxValueFactory.Create("retained-id", 1215, "updated",
            new(1501, 15, 1651, 1701, 1601, 16, 7), null, null, DateTime.UnixEpoch);
        Assert.Throws<InvalidOperationException>(() =>
            Outbox.ArticleMutationOutboxEnvelopeCodec.Read(value with { PayloadJson = payload }));
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void NullablePayload_PreservesOriginalTokenOrderAndNulls()
    {
        string payload = Outbox.ArticleMutationOutboxValueFactory.BuildOutboxPayload(
            1, "created", new(2, 3, 4, null, null, null));
        Assert.Equal("{\"schemaVersion\":2,\"articleId\":1,\"eventType\":\"created\",\"articleRevisionId\":2,"
            + "\"revisionNo\":3,\"rightsSnapshotId\":4,\"responsibilitySnapshotId\":null,"
            + "\"responsibilityVersion\":null,\"releaseId\":null,\"releaseNo\":null,"
            + "\"publicUpdatedAt\":null,\"occurredAt\":null,\"before\":null,\"after\":null}", payload);
    }
}
