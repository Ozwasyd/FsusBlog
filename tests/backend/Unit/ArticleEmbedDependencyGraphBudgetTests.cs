using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedDependencyGraphBudgetTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string ArticleC = "article:01991e72-f301-7ad1-b490-0c39d6a75c82";
    private static readonly string s_digest = new('a', 64);
    private static readonly ArticleEmbedActorContext s_actor = new("actor:author", "site:primary", s_digest);
    private static readonly ArticleEmbedRuntimeContext s_runtime = new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, s_digest);
    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host", 1);
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 4096, 60000, 128);
    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Fact]
    public void SharedMemoSubtreeRechecksDepthAtItsNewSourceEdge()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];
        var budgets = s_budgets with
        {
            MaxDepth = 2
        };

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, budgets);

        ArticleEmbedResolvedNode original = Assert.Single(graph.Results[0].Children);
        ArticleEmbedResolvedNode reused = Assert.Single(Assert.Single(graph.Results[1].Children).Children);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, original.Status);
        Assert.Equal(ArticleB, reused.Target!.PortableArticleIdentity);
        Assert.Equal(ArticleEmbedErrorCode.DepthExceeded, reused.Error?.Code);
        Assert.Empty(reused.Children);
        Assert.Equal(3, graph.Receipt.MaxObservedDepth);
        Assert.Equal(5, graph.Receipt.Observed.Nodes);
        AssertValid(requests, snapshot, budgets, graph);
    }

    [Fact]
    public void SharedMemoSubtreeDebitsEveryExpandedSourceEdge()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];
        var budgets = s_budgets with
        {
            MaxExpandedNodes = 4
        };

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, budgets);

        ArticleEmbedResolvedNode reused = Assert.Single(Assert.Single(graph.Results[1].Children).Children);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, reused.Error?.Code);
        Assert.Equal("expanded_nodes_exceeded", reused.Error!.SafeReasonCode);
        Assert.Equal(5, graph.Receipt.Observed.Nodes);
        Assert.Equal(384, graph.Receipt.Observed.Bytes);
        AssertValid(requests, snapshot, budgets, graph);
    }

    [Fact]
    public void MemoReusePreservesCoordinatesAndSingleAuthorityReadsWithinLimits()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, s_budgets);

        ArticleEmbedResolvedNode original = Assert.Single(graph.Results[0].Children);
        ArticleEmbedResolvedNode reused = Assert.Single(Assert.Single(graph.Results[1].Children).Children);
        Assert.Equal(original.Coordinate, reused.Coordinate);
        Assert.Equal(original.Directive, reused.Directive);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, reused.Status);
        Assert.Equal(5, graph.Receipt.Observed.Nodes);
        Assert.Equal(3, graph.Receipt.Observed.Depth);
        Assert.Equal(384, graph.Receipt.Observed.Bytes);
        AssertValid(requests, snapshot, s_budgets, graph);
    }

    [Fact]
    public void RepeatedRootKeepsCacheHitButCannotReuseItsDescendantsPastTheNodeBudget()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleA, 1)];
        var budgets = s_budgets with
        {
            MaxExpandedNodes = 3
        };

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, budgets);

        Assert.True(graph.Receipt.Items[1].CacheHit);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, Assert.Single(graph.Results[1].Children).Error?.Code);
        Assert.Equal(4, graph.Receipt.Observed.Nodes);
        Assert.Equal(256, graph.Receipt.Observed.Bytes);
        AssertValid(requests, snapshot, budgets, graph);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void VerifierRejectsResealedResolvedMemoSubtreesBeyondEffectiveLimits(bool depth)
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];
        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, s_budgets);
        var limited = depth ? s_budgets with
        {
            MaxDepth = 2
        } : s_budgets with
        {
            MaxExpandedNodes = 4
        };
        var candidate = Reseal(graph, graph.Receipt with
        {
            Budgets = limited
        });

        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, limited, candidate);

        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(candidate).IsValid);
        Assert.False(verification.Valid);
        Assert.Contains(depth ? "resolved_node_beyond_depth_budget" : "resolved_node_beyond_node_budget", verification.ReasonCodes);
    }

    [Fact]
    public void VerifierRejectsResealedMemoTraversalUndercount()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];
        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, s_budgets);
        var candidate = Reseal(graph, graph.Receipt with
        {
            Observed = graph.Receipt.Observed with
            {
                Nodes = 4
            }
        });

        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, candidate);

        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(candidate).IsValid);
        Assert.False(verification.Valid);
        Assert.Contains("graph_node_observation_mismatch", verification.ReasonCodes);
    }

    [Fact]
    public void MemoDescendantObservesElapsedBudgetAfterItsAncestorCacheHit()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1)];
        var budgets = s_budgets with
        {
            MaxElapsedMilliseconds = 100
        };
        var time = new BoundaryTimeProvider(7, elapsedMilliseconds: 101);

        // Projection setup and graph expansion own separate elapsed observations.
        // Keep setup deterministic so wall-clock scheduling cannot preempt the graph's negative.
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(
            requests, snapshot, budgets, new BoundaryTimeProvider(4, elapsedMilliseconds: 1));
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, projection).Valid);
        Assert.All(projection.Results, result => Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status));
        Assert.Equal(1, projection.Receipt.Observed.ElapsedMilliseconds);

        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection, time);

        ArticleEmbedResolvedNode reused = Assert.Single(Assert.Single(graph.Results[1].Children).Children);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, Assert.Single(graph.Results[0].Children).Status);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, Assert.Single(graph.Results[1].Children).Status);
        Assert.Equal(ArticleEmbedErrorCode.TimeExceeded, reused.Error?.Code);
        Assert.Equal("elapsed_exceeded", reused.Error!.SafeReasonCode);
        Assert.Empty(reused.Children);
        Assert.Equal(101, graph.Receipt.Observed.ElapsedMilliseconds);
        Assert.Equal(5, graph.Receipt.Observed.Nodes);
        AssertValid(requests, snapshot, budgets, graph);
    }

    [Fact]
    public void MemoDescendantObservesCancellationAfterItsAncestorCacheHit()
    {
        using var cancellation = new CancellationTokenSource();
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB), Facts(ArticleC, ArticleA));
        ArticleEmbedProviderRequest[] requests = [Request(ArticleA, 0), Request(ArticleC, 1, cancellation.Token)];
        var time = new BoundaryTimeProvider(6, onBoundary: cancellation.Cancel);

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, s_budgets, time);

        ArticleEmbedResolvedNode reused = Assert.Single(Assert.Single(graph.Results[1].Children).Children);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource, reused.Error?.Code);
        Assert.Equal("request_aborted", reused.Error!.SafeReasonCode);
        Assert.Empty(reused.Children);
        // A now-cancelled request cannot pass downstream graph verification/admission.
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
    }

    [Fact]
    public void ThousandRepeatedRootsRetainEveryEdgeWhileReusingOnlyProjectionFacts()
    {
        var snapshot = Snapshot(Facts(ArticleA, ArticleB), Facts(ArticleB));
        ArticleEmbedProviderRequest[] requests = Enumerable.Range(0, 1000).Select(index => Request(ArticleA, index)).ToArray();
        var budgets = s_budgets with
        {
            MaxExpandedNodes = 4096
        };

        ArticleEmbedAuthoringResolution graph = Expand(requests, snapshot, budgets);

        Assert.Equal(2000, graph.Receipt.Observed.Nodes);
        Assert.Equal(999, graph.Receipt.CacheHitCount);
        Assert.Equal(256, graph.Receipt.Observed.Bytes);
        Assert.All(graph.Results, result => Assert.Equal(ArticleB, Assert.Single(result.Children).Target!.PortableArticleIdentity));
        AssertValid(requests, snapshot, budgets, graph);
    }

    private static ArticleEmbedAuthoringResolution Expand(ArticleEmbedProviderRequest[] requests,
        ArticleEmbedAuthoritySnapshot snapshot, ArticleEmbedResolutionBudgetLimits budgets, TimeProvider? time = null)
    {
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, projection).Valid);
        return ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection, time);
    }

    private static void AssertValid(ArticleEmbedProviderRequest[] requests, ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedResolutionBudgetLimits budgets, ArticleEmbedAuthoringResolution graph)
    {
        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, graph);
        Assert.True(verification.Valid, string.Join(",", verification.ReasonCodes));
    }

    private static ArticleEmbedAuthoringResolution Reseal(ArticleEmbedAuthoringResolution graph, ArticleEmbedAuthoringReceipt receipt)
    {
        var candidate = graph with
        {
            Receipt = receipt with
            {
                ReceiptDigest = ArticleEmbedAuthoringDigest.ComputeReceipt(receipt)
            }
        };
        return candidate with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(candidate)
        };
    }

    private static ArticleEmbedProviderRequest Request(string token, int index, CancellationToken signal = default)
    {
        ArticleEmbedTargetCodec.TryDecode(token, ArticleEmbedTargetKind.Article, out var target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, $"request:budget:{index}", Host, s_document, 8,
            new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract, token, ArticleEmbedTargetKind.Article,
                new ArticleEmbedSourceRange(index * 32, index * 32 + 32)),
            target!, ArticleEmbedRequestedScope.Authoring, s_actor, s_runtime, s_digest, string.Empty, signal.CanBeCanceled ? signal : s_signal));
    }

    private static ArticleEmbedTargetFacts Facts(string article, params string[] nested)
        => new(article, s_actor.SiteIdentity, 1, 9, 9, 9, ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed, s_digest, "revision:9", 128,
            "Authorized target", new ArticleEmbedSafeProjectionReference(ArticleEmbedProjectionKind.SafeProjection, "projection:body", s_digest),
            [], [], nested.Select((target, index) => new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract,
                target, ArticleEmbedTargetKind.Article, new ArticleEmbedSourceRange(index * 32, index * 32 + 32))).ToArray());

    private static ArticleEmbedAuthoritySnapshot Snapshot(params ArticleEmbedTargetFacts[] facts)
        => ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version, Host, s_document, 8,
            s_digest, 1, s_actor, s_runtime, "zh-CN", "light", facts, string.Empty));

    private sealed class BoundaryTimeProvider(int boundary, long elapsedMilliseconds = 0, Action? onBoundary = null) : TimeProvider
    {
        private int _observations;

        public override long GetTimestamp()
        {
            if (++_observations == boundary)
            {
                onBoundary?.Invoke();
            }
            return _observations >= boundary ? elapsedMilliseconds * TimestampFrequency / 1000 : 0;
        }
    }

}
