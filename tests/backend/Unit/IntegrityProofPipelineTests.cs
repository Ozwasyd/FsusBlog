using FsusBlog.Core.Integrity;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;

namespace FsusBlog.Server.Tests.Unit;

public sealed class IntegrityProofPipelineTests
{
    [Fact]
    public void OutboxReplay_SchedulesIntegrityProofAfterRequiredEdgesWithoutRequiringIt()
    {
        Assert.Equal("integrity-proof", ArticleMutationReplayEdges.IntegrityProof);
        Assert.DoesNotContain(ArticleMutationReplayEdges.IntegrityProof, ArticleMutationReplayEdges.Required);
        Assert.Contains(
            typeof(ArticleMutationSideEffectCoordinator).GetConstructors().Single().GetParameters(),
            static parameter => parameter.ParameterType == typeof(IIntegrityProofScheduler));

        string processOne = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(ArticleMutationOutboxDispatcher),
            "ReplayOutboxAsync",
            "get_AggregateId",
            "get_EventType");
        Assert.Contains("get_CompletedEdges", processOne, StringComparison.Ordinal);

        IReadOnlyList<string> requiredGuard = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferencesInOrderContaining(
                typeof(ArticleMutationSideEffectCoordinator),
                "ArticleMutationReplayEdges.Required",
                "RunOptionalEdgeAsync");
        Assert.True(
            FindReference(requiredGuard, "ArticleMutationReplayEdges.Required") <
            FindReference(requiredGuard, "RunOptionalEdgeAsync"));
        string integritySchedule = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync));
        Assert.Contains("IIntegrityProofScheduler.ScheduleFromOutboxAsync", integritySchedule, StringComparison.Ordinal);

        Assert.Contains(ArticleMutationReplayEdges.PublicHotRead, ArticleMutationReplayEdges.Required);
    }

    [Fact]
    public void PublishProofUpsert_TypesNullableSupersededTimestampExplicitly()
    {
        string upsert = RuntimeMetadataInspection.DescribeMethods(
            typeof(IntegrityProofScheduler),
            "UpsertProofAsync");

        Assert.Contains("CAST(@SupersededAt AS timestamp)", upsert, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleRightsProofUpsert_TypesNullableNumericParametersExplicitly()
    {
        string upsert = RuntimeMetadataInspection.DescribeMethods(
            typeof(IntegrityProofScheduler),
            "UpsertArticleRightsProofAsync");

        Assert.Contains("CAST(@PublishProofId AS bigint)", upsert, StringComparison.Ordinal);
        Assert.Contains("CAST(@SigningKeyVersion AS integer)", upsert, StringComparison.Ordinal);
    }

    [Fact]
    public void OutboxReplay_SchedulesDistinctArticleRightsProofAfterPublishProofPath()
    {
        Assert.Equal("integrity-proof", ArticleMutationReplayEdges.IntegrityProof);
        string pipeline = RuntimeMetadataInspection.DescribeMethods(
            typeof(IntegrityProofScheduler),
            nameof(IntegrityProofScheduler.ScheduleFromOutboxAsync),
            nameof(IntegrityProofScheduler.ScheduleArticleRightsProofFromOutboxAsync));
        Assert.Contains("ScheduleArticleRightsProofFromOutboxAsync", pipeline, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsProofIdempotency.BuildKey", pipeline, StringComparison.Ordinal);
        Assert.Contains("ArticleRightsProofCanonicalPayloadV1.BuildSigningPayload", pipeline, StringComparison.Ordinal);
        Assert.Contains("AppendArticleRightsProofAsync", pipeline, StringComparison.Ordinal);
        Assert.Contains("article_rights_proof", pipeline, StringComparison.Ordinal);
        Assert.Contains("get_ProofBindingEnabled", pipeline, StringComparison.Ordinal);

        Assert.Equal(
            "article:910002:revision:810002:rights:1",
            ArticleRightsProofIdempotency.BuildKey(910002, 810002, 1));
    }

    [Fact]
    public void IntegrityProofFailure_IsRecordedAsNonRequiredEdgeWithoutFailingReplay()
    {
        string optionalEdge = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(ArticleMutationSideEffectCoordinator),
            "article-outbox-replay-optional-edge-failed",
            "Dictionary");
        Assert.Contains("set_Item", optionalEdge, StringComparison.Ordinal);

        string replay = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationSideEffectCoordinator),
            nameof(ArticleMutationSideEffectCoordinator.ReplayOutboxAsync));
        Assert.Contains("ArticleMutationReplayResult.Success", replay, StringComparison.Ordinal);
        Assert.Contains("get_FailedEdges", RuntimeMetadataInspection.DescribeType(typeof(ArticleMutationOutboxDispatcher)), StringComparison.Ordinal);

        string processOne = RuntimeMetadataInspection.DescribeMethods(
            typeof(ArticleMutationOutboxDispatcher),
            "ProcessOneAsync");
        Assert.Contains("ArticleMutationReplayEdges.Required", processOne, StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable.Any", processOne, StringComparison.Ordinal);
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

    private static int FindReference(IReadOnlyList<string> references, string fact)
    {
        int index = references.ToList().FindIndex(reference => reference.Contains(fact, StringComparison.Ordinal));
        Assert.True(index >= 0, $"Missing runtime reference '{fact}'.");
        return index;
    }
}
