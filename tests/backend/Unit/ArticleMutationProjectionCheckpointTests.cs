using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Services.Background;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationProjectionCheckpointTests
{
    [Fact]
    public void CheckpointStatus_SerializesEveryTerminalStateWithinThePersistedColumnContract()
    {
        SugarColumn? statusColumn = typeof(ArticleMutationOutboxEdge)
            .GetProperty(nameof(ArticleMutationOutboxEdge.Status))!
            .GetCustomAttribute<SugarColumn>();
        Assert.NotNull(statusColumn);

        string[] statuses =
        [
            ArticleMutationOutboxEdgeStatus.Completed,
            ArticleMutationOutboxEdgeStatus.Failed,
            ArticleMutationOutboxEdgeStatus.Skipped
        ];
        Assert.Equal(statuses.Length, statuses.Distinct(StringComparer.Ordinal).Count());
        Assert.All(statuses, status => Assert.InRange(status.Length, 1, statusColumn.Length));

        foreach (string status in statuses)
        {
            var checkpoint = new ArticleMutationOutboxEdge
            {
                OutboxEventId = 396,
                EdgeName = ArticleMutationReplayEdges.ArticleDetailAeds,
                Status = status,
                AttemptCount = 1,
                UpdatedAt = DateTime.UnixEpoch
            };
            string payload = JsonSerializer.Serialize(checkpoint);
            ArticleMutationOutboxEdge restored = JsonSerializer.Deserialize<ArticleMutationOutboxEdge>(payload)!;
            Assert.Equal(status, restored.Status);
            Assert.Equal(checkpoint.EdgeName, restored.EdgeName);
            Assert.Equal(checkpoint.AttemptCount, restored.AttemptCount);
        }

        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId.Contains("article-mutation-outbox-edge", StringComparison.Ordinal));
        string migrationFingerprint = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("status varchar(24) NOT NULL DEFAULT 'pending'", migrationFingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void ReplayResult_SupersededPublicationUsesSkippedInsteadOfFabricatedCompletion()
    {
        var alreadyTerminal = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.PublicAotInvalidation,
            ArticleMutationReplayEdges.Notification
        };

        ArticleMutationReplayResult result = ArticleMutationReplayResult.ForSupersededPublication(alreadyTerminal);

        Assert.True(result.IsSuccess);
        Assert.Empty(result.CompletedEdges);
        Assert.Empty(result.FailedEdges);
        Assert.DoesNotContain(ArticleMutationReplayEdges.PublicAotInvalidation, result.SkippedEdges);
        Assert.DoesNotContain(ArticleMutationReplayEdges.Notification, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.SearchProjection, result.SkippedEdges);
        Assert.Contains(ArticleMutationReplayEdges.IntegrityProof, result.SkippedEdges);

        string replayRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync));
        Assert.Contains("ArticleMutationReplayResult.ForSupersededPublication", replayRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void Dispatcher_PersistsAndReloadsCompletedAndSkippedAsTerminalCheckpoints()
    {
        string processRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "ProcessOneAsync");
        string loadRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "LoadCompletedEdgesByOutboxIdAsync");
        string upsertRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "UpsertReplayEdgesAsync");

        Assert.Contains("ArticleMutationReplayResult.get_SkippedEdges", processRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required", processRuntime, StringComparison.Ordinal);
        Assert.Contains("skipped", loadRuntime, StringComparison.Ordinal);
        Assert.Contains("completed", loadRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayResult.get_SkippedEdges", upsertRuntime, StringComparison.Ordinal);
        Assert.Contains("skipped", upsertRuntime, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationDeliveryKey.Build", upsertRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void ReplayResult_FailureNeverCreatesSkippedCheckpointImplicitly()
    {
        ArticleMutationReplayResult failed = ArticleMutationReplayResult.Failed(
            "projection-failed",
            new HashSet<string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [ArticleMutationReplayEdges.SearchProjection] = "projection-failed"
            });

        Assert.False(failed.IsSuccess);
        Assert.Empty(failed.CompletedEdges);
        Assert.Empty(failed.SkippedEdges);
        Assert.Equal("projection-failed", failed.FailedEdges[ArticleMutationReplayEdges.SearchProjection]);
    }
}
