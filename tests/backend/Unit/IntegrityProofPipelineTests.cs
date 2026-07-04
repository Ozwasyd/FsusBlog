using FsusBlog.Core.Integrity;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofPipelineTests
{
    [Fact]
    public void OutboxReplay_SchedulesIntegrityProofAfterRequiredEdgesWithoutRequiringIt()
    {
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string dispatcher = ReadRepoFile("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs");
        string processOne = Slice(dispatcher, "private async Task<bool> ProcessOneAsync", "    private static async Task<List<ArticleMutationOutboxEvent>> ClaimPendingOutboxEventsAsync");
        string replayMethod = Slice(sideEffects, "public async Task<ArticleMutationReplayResult> ReplayOutboxAsync", "    private async Task<Article?> LoadArticleWithContentAsync");

        Assert.Contains("IntegrityProof = \"integrity-proof\"", sideEffects, StringComparison.Ordinal);
        Assert.Contains("IIntegrityProofScheduler integrityProofScheduler", sideEffects, StringComparison.Ordinal);
        Assert.DoesNotContain("IntegrityProof,", Slice(sideEffects, "public static readonly IReadOnlySet<string> Required", "    };"), StringComparison.Ordinal);

        Assert.Contains("coordinator.ReplayOutboxAsync(item.AggregateId, item.EventType, completedAfterReplay", processOne, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required.All(completed.Contains)", replayMethod, StringComparison.Ordinal);
        Assert.Contains("RunOptionalEdgeAsync(ArticleMutationReplayEdges.IntegrityProof", replayMethod, StringComparison.Ordinal);
        Assert.Contains("integrityProofScheduler.ScheduleFromOutboxAsync", replayMethod, StringComparison.Ordinal);

        int publicHot = replayMethod.IndexOf("ArticleMutationReplayEdges.PublicHotRead", replayMethod.IndexOf("try", StringComparison.Ordinal), StringComparison.Ordinal);
        int requiredGuard = replayMethod.IndexOf("ArticleMutationReplayEdges.Required.All(completed.Contains)", StringComparison.Ordinal);
        int proof = replayMethod.IndexOf("RunOptionalEdgeAsync(ArticleMutationReplayEdges.IntegrityProof", StringComparison.Ordinal);
        int schedule = replayMethod.IndexOf("await ScheduleIntegrityProofIfRequiredEdgesCompleteAsync(normalized)", StringComparison.Ordinal);

        Assert.True(publicHot >= 0);
        Assert.True(schedule > publicHot);
        Assert.True(proof > requiredGuard);
    }

    [Fact]
    public void OutboxReplay_SchedulesDistinctArticleRightsProofAfterPublishProofPath()
    {
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string pipeline = ReadRepoFile("src/backend/Infrastructure/Integrity/IntegrityProofPipeline.cs");
        string model = ReadRepoFile("src/backend/Infrastructure/Integrity/ArticleRightsProof.cs");

        Assert.Contains("IntegrityProof = \"integrity-proof\"", sideEffects, StringComparison.Ordinal);
        Assert.Contains("ScheduleArticleRightsProofFromOutboxAsync", pipeline, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsProofIdempotency.BuildKey", pipeline, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsProofCanonicalPayloadV1.BuildSigningPayload", pipeline, StringComparison.Ordinal);
        Assert.Contains("AppendArticleRightsProofAsync", pipeline, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", pipeline, StringComparison.Ordinal);
        Assert.Contains("article:{articleId}:revision:{articleRevisionId}:rights:{proofVersion}", model, StringComparison.Ordinal);
        Assert.Contains("ProofBindingEnabled", pipeline, StringComparison.Ordinal);
    }

    [Fact]
    public void IntegrityProofFailure_IsRecordedAsNonRequiredEdgeWithoutFailingReplay()
    {
        string sideEffects = ReadRepoFile("src/backend/Services/ArticleMutationSideEffects.cs");
        string dispatcher = ReadRepoFile("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs");
        string replayMethod = Slice(sideEffects, "public async Task<ArticleMutationReplayResult> ReplayOutboxAsync", "    private async Task<Article?> LoadArticleWithContentAsync");
        string processOne = Slice(dispatcher, "private async Task<bool> ProcessOneAsync", "    private static async Task<List<ArticleMutationOutboxEvent>> ClaimPendingOutboxEventsAsync");

        Assert.Contains("async Task RunOptionalEdgeAsync", replayMethod, StringComparison.Ordinal);
        Assert.Contains("failed[edgeName] = error;", replayMethod, StringComparison.Ordinal);
        Assert.Contains("return ArticleMutationReplayResult.Success(completedDuringReplay, failed)", replayMethod, StringComparison.Ordinal);
        Assert.Contains("replay.CompletedEdges.Count + replay.FailedEdges.Count", dispatcher, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationReplayEdges.Required.All(completedAfterReplay.Contains)", processOne, StringComparison.Ordinal);
        Assert.DoesNotContain("ArticleMutationReplayEdges.Required.All(completedAfterReplay.Contains) && !replay.FailedEdges", processOne, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("created", PublishProofPublicationState.Public, PublishProofStatus.Pending)]
    [InlineData("updated", PublishProofPublicationState.Public, PublishProofStatus.Pending)]
    [InlineData("scheduled-published", PublishProofPublicationState.Public, PublishProofStatus.Pending)]
    [InlineData("rollback", PublishProofPublicationState.Public, PublishProofStatus.Pending)]
    [InlineData("deleted", PublishProofPublicationState.Deleted, PublishProofStatus.NotPublic)]
    [InlineData("archived", PublishProofPublicationState.Archived, PublishProofStatus.NotPublic)]
    public void Planner_ClassifiesMutationAndDoesNotFakeReadyBeforeArtifacts(
        string eventType,
        PublishProofPublicationState publicationState,
        PublishProofStatus expectedInitialStatus)
    {
        var completedEdges = ArticleMutationReplayEdges.Required.ToHashSet(StringComparer.Ordinal);

        IntegrityProofOutboxPlan plan = IntegrityProofOutboxPlanner.BuildPlan(
            articleId: 910002,
            eventType,
            completedEdges,
            artifactStates:
            [
                ArtifactDigestState.Missing,
                ArtifactDigestState.Pending,
                ArtifactDigestState.Unknown
            ],
            attemptCount: 0);

        Assert.True(plan.ShouldSchedule);
        Assert.Equal(publicationState, plan.PublicationState);
        Assert.Equal(expectedInitialStatus, plan.Status);
        Assert.NotEqual(PublishProofStatus.Ready, plan.Status);
        Assert.True(plan.ShouldRetry == (expectedInitialStatus is PublishProofStatus.Pending or PublishProofStatus.Retrying));
    }

    [Fact]
    public void Planner_WaitsForRequiredEdgesAndUsesLowCardinalityFailureReasons()
    {
        HashSet<string> incomplete = ArticleMutationReplayEdges.Required
            .Where(edge => edge != ArticleMutationReplayEdges.PublicHotRead)
            .ToHashSet(StringComparer.Ordinal);

        IntegrityProofOutboxPlan waiting = IntegrityProofOutboxPlanner.BuildPlan(
            articleId: 910002,
            eventType: "updated",
            completedEdges: incomplete,
            artifactStates: [ArtifactDigestState.Ready],
            attemptCount: 0);
        IntegrityProofOutboxPlan retrying = IntegrityProofOutboxPlanner.BuildPlan(
            articleId: 910002,
            eventType: "updated",
            completedEdges: ArticleMutationReplayEdges.Required,
            artifactStates: [ArtifactDigestState.Unavailable],
            attemptCount: IntegrityProofOutboxPlanner.RetryingAttemptThreshold);
        IntegrityProofOutboxPlan failed = IntegrityProofOutboxPlanner.BuildPlan(
            articleId: 910002,
            eventType: "updated",
            completedEdges: ArticleMutationReplayEdges.Required,
            artifactStates: [ArtifactDigestState.HashMismatch],
            attemptCount: IntegrityProofOutboxPlanner.PoisonAttemptThreshold);

        Assert.False(waiting.ShouldSchedule);
        Assert.Equal("required-edges-incomplete", waiting.FailureCode);
        Assert.Equal(PublishProofStatus.Retrying, retrying.Status);
        Assert.Equal("artifact-unavailable", retrying.FailureCode);
        Assert.Equal(PublishProofStatus.Failed, failed.Status);
        Assert.Equal("artifact-hash-mismatch", failed.FailureCode);
    }

    [Fact]
    public void Planner_UsesCurrentPublicationStateOverEventName()
    {
        IntegrityProofOutboxPlan plan = IntegrityProofOutboxPlanner.BuildPlan(
            articleId: 910002,
            eventType: "updated",
            completedEdges: ArticleMutationReplayEdges.Required,
            artifactStates: [ArtifactDigestState.Ready],
            attemptCount: 0,
            publicationStateOverride: PublishProofPublicationState.Archived);

        Assert.True(plan.ShouldSchedule);
        Assert.Equal(PublishProofPublicationState.Archived, plan.PublicationState);
        Assert.Equal(PublishProofStatus.NotPublic, plan.Status);
        Assert.Equal("article-not-public", plan.FailureCode);
        Assert.False(plan.ShouldRetry);
    }

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"start marker not found: {startMarker}");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"end marker not found: {endMarker}");
        return source[start..end];
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));
}
