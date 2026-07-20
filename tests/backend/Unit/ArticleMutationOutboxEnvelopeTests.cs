using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationOutboxEnvelopeTests
{
    private static readonly DateTime s_occurredAt = new(2026, 7, 20, 6, 30, 0, DateTimeKind.Utc);

    [Fact]
    public void VersionedOutboxMigration_IsAdditiveAndRegistersExactCoordinateBackfill()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            item => item.MigrationId == ArticleMutationOutboxVersionMigrationDefinitions.MigrationId);
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ADD COLUMN IF NOT EXISTS rights_snapshot_id bigint NULL", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ADD COLUMN IF NOT EXISTS responsibility_version integer NULL", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("idx_article_mutation_outbox_version_coordinate", fingerprint, StringComparison.Ordinal);
        Assert.Contains("Versioned article mutation events preserve exact immutable coordinates", fingerprint, StringComparison.Ordinal);
        Assert.NotNull(typeof(ArticleMutationOutboxEvent).GetProperty(nameof(ArticleMutationOutboxEvent.SchemaVersion)));
        Assert.NotNull(typeof(ArticleMutationOutboxEvent).GetProperty(nameof(ArticleMutationOutboxEvent.RightsSnapshotId)));
        Assert.NotNull(typeof(ArticleMutationOutboxEvent).GetProperty(nameof(ArticleMutationOutboxEvent.ResponsibilityVersion)));
    }

    [Fact]
    public void VersionTwoEnvelope_PreservesExactReleasePolicyResponsibilityAndScopeCoordinates()
    {
        var item = new ArticleMutationOutboxEvent
        {
            EventId = "event-v2",
            AggregateId = 1215,
            SchemaVersion = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            ArticleRevisionId = 1501,
            RevisionNo = 15,
            ResponsibilitySnapshotId = 1701,
            ArticlePublicationId = 1601,
            PublicationNo = 16,
            EventType = "updated",
            CreatedAt = s_occurredAt,
            PayloadJson = """
                {
                  "schemaVersion": 2,
                  "articleId": 1215,
                  "eventType": "updated",
                  "articleRevisionId": 1501,
                  "revisionNo": 15,
                  "releaseId": 1601,
                  "releaseNo": 16,
                  "rightsSnapshotId": 1651,
                  "responsibilitySnapshotId": 1701,
                  "responsibilityVersion": 7,
                  "publicUpdatedAt": "2026-07-20T06:30:00Z",
                  "before": { "categoryId": 2, "tagIds": [3, 4], "visibility": "published" },
                  "after": { "categoryId": 5, "tagIds": [4, 6], "visibility": "archived" }
                }
                """
        };

        ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(item);

        Assert.False(envelope.IsLegacy);
        Assert.Equal(1501, envelope.Version.RevisionId);
        Assert.Equal(1601, envelope.Version.ReleaseId);
        Assert.Equal(1651, envelope.Version.RightsSnapshotId);
        Assert.Equal(1701, envelope.Version.ResponsibilitySnapshotId);
        Assert.Equal(7, envelope.Version.ResponsibilityVersion);
        Assert.Equal(s_occurredAt, envelope.Version.PublicUpdatedAt);
        Assert.Equal([2, 5], envelope.Scope.CategoryIds);
        Assert.Equal([3, 4, 6], envelope.Scope.TagIds);
        Assert.Equal("published", envelope.Scope.Before!.Visibility);
        Assert.Equal("archived", envelope.Scope.After!.Visibility);
    }

    [Fact]
    public void Producer_CreatesVersionTwoColumnsAndRoundTripsBeforeAfterScopes()
    {
        var version = new ArticleVersionCoordinates(1501, 15, 1651, 1701, 1601, 16, 7);
        var before = new ArticleMutationScopeSnapshot(2, [3, 4], "published");
        var after = new ArticleMutationScopeSnapshot(5, [4, 6], "archived");

        ArticleMutationOutboxEvent item = ArticleMutationOutboxProducer.Create(
            1215,
            ArticleMutationEventTypes.Updated,
            version,
            before,
            after,
            s_occurredAt);
        ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(item);

        Assert.Equal(ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion, item.SchemaVersion);
        Assert.Equal(1501, item.ArticleRevisionId);
        Assert.Equal(1651, item.RightsSnapshotId);
        Assert.Equal(1701, item.ResponsibilitySnapshotId);
        Assert.Equal(7, item.ResponsibilityVersion);
        Assert.Equal(1601, item.ArticlePublicationId);
        Assert.Equal([2, 5], envelope.Scope.CategoryIds);
        Assert.Equal([3, 4, 6], envelope.Scope.TagIds);
        Assert.Equal(s_occurredAt, envelope.OccurredAt);
    }

    [Fact]
    public void LegacyEnvelope_UsesStableColumnsAndArticlePublicationCompatibilityAlias()
    {
        var item = new ArticleMutationOutboxEvent
        {
            EventId = "legacy-event",
            AggregateId = 1215,
            ArticleRevisionId = 41,
            RevisionNo = 4,
            ArticlePublicationId = 51,
            PublicationNo = 5,
            EventType = "scheduled-published",
            CreatedAt = s_occurredAt,
            PayloadJson = """
                {
                  "articleId": 1215,
                  "eventType": "scheduled-published",
                  "articleRevisionId": 41,
                  "revisionNo": 4,
                  "articlePublicationId": 51,
                  "publicationNo": 5,
                  "rightsSnapshotId": 61
                }
                """
        };

        ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(item);

        Assert.True(envelope.IsLegacy);
        Assert.Equal(51, envelope.Version.ReleaseId);
        Assert.Equal(61, envelope.Version.RightsSnapshotId);
        Assert.Equal(s_occurredAt, envelope.OccurredAt);
    }

    [Fact]
    public void ConflictingReleaseAliases_AreRejectedInsteadOfReadingLatestState()
    {
        var item = new ArticleMutationOutboxEvent
        {
            EventId = "conflicting-event",
            AggregateId = 1215,
            ArticlePublicationId = 51,
            EventType = "updated",
            PayloadJson = """
                {
                  "articleId": 1215,
                  "eventType": "updated",
                  "releaseId": 52,
                  "articlePublicationId": 51
                }
                """
        };

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => ArticleMutationOutboxEnvelopeCodec.Read(item));

        Assert.Contains("conflicting releaseId aliases", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnsupportedFutureSchema_IsRejectedForSafeReplayMigration()
    {
        var item = new ArticleMutationOutboxEvent
        {
            EventId = "future-event",
            AggregateId = 1215,
            SchemaVersion = 99,
            EventType = "updated",
            PayloadJson = """{"schemaVersion":99,"articleId":1215,"eventType":"updated"}"""
        };

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => ArticleMutationOutboxEnvelopeCodec.Read(item));

        Assert.Contains("unsupported schema version 99", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SupersededReplay_PersistsOneExplicitReasonForEverySkippedEdge()
    {
        const string Reason = "superseded-by-release:1602";
        ArticleMutationReplayResult replay = ArticleMutationReplayResult.ForSupersededPublication(
            new HashSet<string>(StringComparer.Ordinal),
            Reason);

        Assert.True(replay.IsSuccess);
        Assert.NotEmpty(replay.SkippedEdges);
        Assert.All(replay.SkippedEdges, edge => Assert.Equal(Reason, replay.SkippedEdgeReasons[edge]));
    }

    [Fact]
    public async Task DispatcherVersionGate_SkipsSupersededConsumersWithReasonAndRunsCurrentConsumers()
    {
        const string Reason = "superseded-by-release:1602";
        var persistedEdges = new List<ArticleMutationOutboxEdge>();
        ICacheInvalidationDispatcher cache = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        bool shouldProcessSuperseded = await ArticleMutationOutboxDispatcher.RouteAfterVersionPreflightAsync(
            ArticleMutationVersionDisposition.Skip(Reason),
            reason =>
            {
                ArticleMutationReplayResult replay = ArticleMutationReplayResult.ForSupersededPublication(
                    new HashSet<string>(StringComparer.Ordinal),
                    reason);
                persistedEdges.AddRange(replay.SkippedEdges.Select(edge => new ArticleMutationOutboxEdge
                {
                    EdgeName = edge,
                    Status = ArticleMutationOutboxEdgeStatus.Skipped,
                    LastError = replay.SkippedEdgeReasons[edge]
                }));
                return Task.FromResult(false);
            },
            () => Task.FromResult(true));
        if (shouldProcessSuperseded)
        {
            await cache.InvalidateArticleMutationAsync(1215, CancellationToken.None);
            await publicAot.InvalidateArticleMutationAsync(1215, [], [], CancellationToken.None);
        }

        Assert.False(shouldProcessSuperseded);
        await cache.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default);
        await publicAot.DidNotReceiveWithAnyArgs().InvalidateArticleMutationAsync(default, default!, default!, default);
        Assert.NotEmpty(persistedEdges);
        Assert.All(persistedEdges, edge =>
        {
            Assert.Equal(ArticleMutationOutboxEdgeStatus.Skipped, edge.Status);
            Assert.Equal(Reason, edge.LastError);
        });

        bool shouldProcessCurrent = await ArticleMutationOutboxDispatcher.RouteAfterVersionPreflightAsync(
            ArticleMutationVersionDisposition.Process,
            _ => Task.FromResult(false),
            () => Task.FromResult(true));
        if (shouldProcessCurrent)
        {
            await cache.InvalidateArticleMutationAsync(1215, CancellationToken.None);
            await publicAot.InvalidateArticleMutationAsync(1215, [], [], CancellationToken.None);
        }

        Assert.True(shouldProcessCurrent);
        await cache.Received(1).InvalidateArticleMutationAsync(1215, Arg.Any<CancellationToken>());
        await publicAot.Received(1).InvalidateArticleMutationAsync(
            1215,
            Arg.Any<IEnumerable<int>>(),
            Arg.Any<IEnumerable<int>>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DelayedProjectionCoordinates_PreserveCurrentArtifactsAndNotificationUsesOccurredAt()
    {
        Assert.True(ArticleMutationProjectionVersionPolicy.PreserveCurrentWhenCoordinateDoesNotResolve(
            expectedReleaseId: 1601,
            coordinateResolved: false));
        Assert.False(ArticleMutationProjectionVersionPolicy.PreserveCurrentWhenCoordinateDoesNotResolve(
            expectedReleaseId: null,
            coordinateResolved: false));

        var queue = new PublicHotArtifactUpdateQueue(
            Microsoft.Extensions.Options.Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 4 }));
        PublicHotArtifactEnqueueResult queued = queue.Enqueue(1215, "outbox-updated", expectedReleaseId: 1601);
        Assert.True(queued.Accepted);
        Assert.True(queue.Reader.TryRead(out PublicHotArtifactUpdate update));
        Assert.Equal(1601, update.ExpectedReleaseId);

        DateTime occurredAt = new(2026, 7, 20, 7, 15, 0, DateTimeKind.Utc);
        IMessageRealtimePublisher publisher = Substitute.For<IMessageRealtimePublisher>();
        var delivery = new ArticleMutationDelivery(
            Substitute.For<ISearchIndexService>(),
            publisher,
            Substitute.For<IIntegrityProofScheduler>());
        await delivery.NotifyAsync(
            1215,
            "Updated",
            idempotencyKey: "delivery-key",
            eventTime: occurredAt,
            version: new ArticleMutationVersionReference(1501, 3, 1601, 4));

        await publisher.Received(1).PushArticleChangedAsync(
            Arg.Is<ArticleNoticeDto>(notice => notice.ArticleId == 1215
                && notice.EventTime == occurredAt
                && notice.RevisionId == "1501"
                && notice.ReleaseId == "1601"),
            "delivery-key");
    }

    [Fact]
    public void SupersededDisposition_ReturnsNewlyCompletedAndMarksEveryRemainingEdgeSkipped()
    {
        var terminal = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.PublicAotInvalidation,
            ArticleMutationReplayEdges.HttpCacheInvalidation,
            ArticleMutationReplayEdges.SearchProjection
        };
        var newlyCompleted = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.SearchProjection
        };

        ArticleMutationReplayResult result = ArticleMutationReplayResult.ForSupersededPublication(
            terminal,
            "superseded-by-release:1602",
            newlyCompleted);

        Assert.True(result.IsSuccess);
        Assert.Equal(newlyCompleted, result.CompletedEdges);
        Assert.DoesNotContain(ArticleMutationReplayEdges.SearchProjection, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.ArticleDetailAeds, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.PublicHotRead, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.Notification, result.SkippedEdges);
        Assert.All(result.SkippedEdges, edge =>
            Assert.Equal("superseded-by-release:1602", result.SkippedEdgeReasons[edge]));
    }
}
