using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedAuthoringStagesTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string Heading = "heading:01991e72-d093-78ad-b06d-8f7664902992";
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleEmbedActorContext s_actor = new("actor:author", "site:primary", s_digest);
    private static readonly ArticleEmbedRuntimeContext s_runtime = new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, s_digest);
    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host", 1);
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 4096, 60000, 128);
    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Fact]
    public void ProviderProjectsOneTargetWhileOnlyTheGraphStageExpandsDependencies()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB, Host));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];

        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, s_budgets, projection);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
        Assert.Empty(projection.Results[0].Children);
        Assert.Equal(1, projection.Receipt.Observed.Nodes);
        Assert.Equal(1, projection.Receipt.MaxObservedDepth);
        Assert.Equal(128, projection.Receipt.Observed.Bytes);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, projection).Valid);
        ArticleEmbedResolvedNode child = Assert.Single(graph.Results[0].Children);
        Assert.Equal(ArticleB, child.Target!.PortableArticleIdentity);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, Assert.Single(child.Children).Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
        Assert.Empty(projection.Results[0].Children);
    }

    [Fact]
    public void FlatProjectionCannotMasqueradeAsACompleteRelationOrRefreshGraph()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedRelationDerivation incomplete = ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, s_budgets, projection);
        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            requests, snapshot, s_budgets, projection, requests[0].RequestId, projection.Results[0].Result.Coordinate, out bool changed);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, s_budgets, projection);

        Assert.False(incomplete.Accepted);
        Assert.Null(incomplete.EdgeSet);
        Assert.False(comparison.IsValid);
        Assert.False(changed);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
        Assert.Equal(ArticleEmbedErrorCode.Missing, Assert.Single(graph.Results[0].Children).Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
    }

    [Fact]
    public void PipelineComposesTheActualProjectionGraphAndRelationOwners()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];

        var stages = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.Empty(stages.Projection.Results[0].Children);
        Assert.Single(stages.Graph.Results[0].Children);
        Assert.True(stages.Relations.Accepted);
        Assert.Equal(2, stages.Relations.EdgeSet!.Edges.Count);
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromAuthoring(requests, snapshot, s_budgets, stages.Graph, stages.Relations).Valid);
        Assert.Equal(stages.Graph.Receipt.ReceiptDigest, stages.Relations.EdgeSet.SourceArtifactDigest);
        Assert.Empty(stages.Relations.DependencyReceipts);
    }

    [Fact]
    public void DependencyBudgetFailureCannotInvalidateTheAlreadyCompletedFlatProjection()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];
        var budgets = s_budgets with
        {
            MaxSourceBytes = 128
        };
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets);

        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
        Assert.Equal(128, projection.Receipt.Observed.Bytes);
        Assert.Equal(256, graph.Receipt.Observed.Bytes);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, Assert.Single(graph.Results[0].Children).Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, graph).Valid);
        Assert.Empty(projection.Results[0].Children);
    }

    [Fact]
    public void GraphRefusesProjectionAfterCancellationInsteadOfRequerying()
    {
        using var cancellation = new CancellationTokenSource();
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, signal: cancellation.Token)];
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);
        cancellation.Cancel();

        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, s_budgets, projection);

        Assert.Equal(ArticleEmbedAuthoringResolutionStatus.Rejected, graph.Status);
        Assert.Equal("article_embed_graph_projection_unverified", graph.RejectedReasonCode);
        Assert.Empty(graph.Results);
        Assert.Empty(projection.Results[0].Children);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
    }

    [Fact]
    public void GraphRefusesDriftedAuthorityAndUnverifiedProjectionDigests()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);
        var drifted = ArticleEmbedAuthoringContractValidator.Seal(snapshot with
        {
            HostDocument = s_document with
            {
                Epoch = 2
            }
        });
        var tampered = projection with
        {
            ResolutionDigest = new string('b', 64)
        };

        foreach (var pair in new[] { (Snapshot: drifted, Projection: projection), (Snapshot: snapshot, Projection: tampered) })
        {
            ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, pair.Snapshot, s_budgets, pair.Projection);
            Assert.Equal(ArticleEmbedAuthoringResolutionStatus.Rejected, graph.Status);
            Assert.Empty(graph.Results);
        }
    }

    [Fact]
    public void SelfTargetProjectionDoesNotAttemptRecursiveRendering()
    {
        var snapshot = Snapshot(Facts(Host));
        ArticleEmbedProviderRequest[] requests = [Request(Host)];
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, s_budgets, projection);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
        Assert.Empty(projection.Results[0].Children);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, graph.Results[0].Result.Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, projection).Valid);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleEmbedTargetKind.Block)]
    public void GraphNeverCopiesWholeArticleDependenciesIntoASelectedProjection(ArticleEmbedTargetKind mode)
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        string token = mode == ArticleEmbedTargetKind.Heading ? $"{ArticleA}#{Heading}" : $"{ArticleA}#exact-anchor";
        ArticleEmbedProviderRequest[] requests = [Request(token, mode)];
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, s_budgets, projection);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, projection.Results[0].Result.Status);
        Assert.Equal("projection_dependencies_unbound", graph.Results[0].Result.Error!.SafeReasonCode);
        Assert.Empty(graph.Results[0].Children);
        Assert.Null(graph.Results[0].Result.Coordinate);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, graph.Results[0].Eligibility);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedErrorCode.Cycle, "root_cycle_without_host_ancestor:request:stage")]
    [InlineData(ArticleEmbedErrorCode.DepthExceeded, "root_depth_failure_unjustified:request:stage")]
    public void GraphVerifierRejectsResealedUnjustifiedRootPathFailures(ArticleEmbedErrorCode code, string reason)
    {
        var snapshot = Snapshot(Facts(ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA)];
        var stages = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        ArticleEmbedProviderResult result = ArticleEmbedContractValidator.Seal(stages.Graph.Results[0].Result with
        {
            Status = ArticleEmbedProviderResultStatus.Failed,
            Coordinate = null,
            Projection = null,
            Attribution = null,
            Error = new ArticleEmbedError(code, code == ArticleEmbedErrorCode.Cycle ? "embed_cycle" : "depth_exceeded")
        });
        var item = stages.Graph.Receipt.Items[0] with
        {
            Status = ArticleEmbedProviderResultStatus.Failed,
            ErrorCode = code,
            ResolvedRevision = null,
            Eligibility = ArticleEmbedPublicationEligibility.AuthoringOnly,
            ResultDigest = result.ResultDigest
        };
        var receipt = stages.Graph.Receipt with
        {
            ResolvedCount = 0,
            FailedCount = 1,
            Items = [item]
        };
        receipt = receipt with
        {
            ReceiptDigest = ArticleEmbedAuthoringDigest.ComputeReceipt(receipt)
        };
        var candidate = stages.Graph with
        {
            Results = [stages.Graph.Results[0] with
            {
                Result = result,
                Eligibility = ArticleEmbedPublicationEligibility.AuthoringOnly,
                OpenSource = null
            }],
            Receipt = receipt
        };
        candidate = candidate with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(candidate)
        };
        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(candidate).IsValid);

        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, candidate);

        Assert.False(verification.Valid);
        Assert.Contains(reason, verification.ReasonCodes);
    }

    private static ArticleEmbedProviderRequest Request(string token, ArticleEmbedTargetKind mode = ArticleEmbedTargetKind.Article,
        CancellationToken signal = default)
    {
        ArticleEmbedTargetCodec.TryDecode(token, mode, out var target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:stage", Host, s_document, 8,
            new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract, token, mode, new ArticleEmbedSourceRange(0, 32)),
            target!, ArticleEmbedRequestedScope.Authoring, s_actor, s_runtime, s_digest, string.Empty,
            signal.CanBeCanceled ? signal : s_signal));
    }

    private static ArticleEmbedTargetFacts Facts(string article, params string[] nested)
        => new(article, s_actor.SiteIdentity, 1, 9, 9, 9, ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed, s_digest, "revision:9", 128,
            "Authorized target", Projection("projection:body"),
            [new ArticleEmbedHeadingFact(Heading, Projection("projection:heading"))],
            [new ArticleEmbedBlockFact("exact-anchor", Projection("projection:block"))],
            nested.Select((target, index) => new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract,
                target, ArticleEmbedTargetKind.Article, new ArticleEmbedSourceRange(index * 32, index * 32 + 32))).ToArray());

    private static ArticleEmbedSafeProjectionReference Projection(string identity)
        => new(ArticleEmbedProjectionKind.SafeProjection, identity, s_digest);

    private static ArticleEmbedAuthoritySnapshot Snapshot(params ArticleEmbedTargetFacts[] facts)
        => ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version, Host, s_document, 8,
            s_digest, 1, s_actor, s_runtime, "zh-CN", "light", facts, string.Empty));
}
