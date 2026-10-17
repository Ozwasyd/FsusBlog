using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedPipelineTests : IDisposable
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string Heading = "heading:01991e72-d093-78ad-b06d-8f7664902992";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string DigestD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    private static readonly ArticleEmbedActorContext s_actor = new("actor:reader", "site:primary", DigestA);
    private static readonly ArticleEmbedRuntimeContext s_runtime = new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB);
    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host", 3);
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);
    private readonly CancellationTokenSource _cancellation = new();

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Article)]
    [InlineData(ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleEmbedTargetKind.Block)]
    public void PipelineSeparatesProjectionAndVerifiedNestedGraph(ArticleEmbedTargetKind kind)
    {
        var (requests, snapshot) = NestedGraph(kind);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.Empty(Assert.Single(evaluated.Projection.Results).Children);
        Assert.True(ArticleEmbedAuthoringVerifier.VerifyProjection(requests, snapshot, s_budgets, evaluated.Projection).Valid);
        ArticleEmbedResolvedNode child = Assert.Single(Assert.Single(evaluated.Graph.Results).Children);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, child.Status);
        Assert.Equal(kind, child.Target!.Kind);
        Assert.Equal(ProjectionIdentity(kind), child.Coordinate!.ProjectionIdentity);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.VerifyProjection(requests, snapshot, s_budgets, evaluated.Graph).Valid);
        Assert.True(evaluated.Relations.Accepted);
        Assert.Equal(2, evaluated.Relations.EdgeSet!.Edges.Count);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("projection")]
    [InlineData("projection-digest")]
    [InlineData("schema")]
    [InlineData("dependency-digest")]
    public void GraphRejectsResealedNestedCoordinateDrift(string dimension)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Heading);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);
        ArticleEmbedAuthoringEmbedResult root = Assert.Single(graph.Results);
        ArticleEmbedResolvedNode child = Assert.Single(root.Children);
        ArticleEmbedDependencyCoordinate coordinate = dimension switch
        {
            "version" => child.Coordinate! with { TargetVersionIdentity = "revision:other" },
            "projection" => child.Coordinate! with { ProjectionIdentity = "projection:other" },
            "projection-digest" => child.Coordinate! with { ProjectionDigest = DigestA },
            "schema" => child.Coordinate! with { SchemaVersion = 2 },
            _ => child.Coordinate!
        };
        coordinate = ArticleEmbedContractValidator.Seal(coordinate);
        if (dimension == "dependency-digest")
        {
            coordinate = coordinate with
            {
                DependencyDigest = DigestA
            };
        }
        ArticleEmbedAuthoringResolution tampered = graph with
        {
            Results = [root with { Children = [child with { Coordinate = coordinate }] }]
        };
        tampered = tampered with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(tampered)
        };
        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(tampered).IsValid);

        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, tampered);
        Assert.False(verification.Valid);
        Assert.Contains("nested_coordinate_mismatch", verification.ReasonCodes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void RefreshPreparesExactSelectionWithoutGrantingExecution(bool changed)
    {
        var (request, host, snapshot) = RefreshInput(changed);
        ArticleEmbedRefreshPlanningResult result = ArticleEmbedRefreshPlanner.Prepare(request, host, snapshot);

        Assert.Equal(changed ? ArticleEmbedRefreshPlanStatus.Prepared : ArticleEmbedRefreshPlanStatus.NoChange, result.Status);
        Assert.Null(result.ReasonCode);
        Assert.NotNull(result.Plan);
        Assert.False(result.Plan.CanExecute);
        ArticleEmbedRefreshPlanItem item = Assert.Single(result.Plan.Items);
        Assert.Equal(changed, item.Changed);
        Assert.Equal(request.Selections[0].RecordedCoordinate, item.OldCoordinate);
        Assert.Equal(request.Selections[0].DesiredCoordinate, item.NewCoordinate);
        Assert.Equal(host.Host, result.Plan.Host);
        Assert.Equal(host.Dependencies[0].Directive, item.Directive);
        Assert.Equal(host.Dependencies[0].RecordedCoordinate, item.OldCoordinate);
        Assert.Equal(-1, Assert.Single(result.Plan.SelectedGraph).ParentIndex);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RefreshCancellationWinsAcrossPipelineStages(bool duringProjection)
    {
        var (request, host, snapshot) = RefreshInput(changed: true);
        if (!duringProjection)
        {
            _cancellation.Cancel();
        }
        TimeProvider? time = duringProjection ? new CancellingTimeProvider(_cancellation) : null;

        ArticleEmbedRefreshPlanningResult result = ArticleEmbedRefreshPlanner.Prepare(request, host, snapshot, time);

        Assert.Equal(ArticleEmbedRefreshPlanStatus.Cancelled, result.Status);
        Assert.Equal("article_embed_refresh_cancelled", result.ReasonCode);
        Assert.Null(result.Plan);
    }

    [Fact]
    public void RefreshRejectsChangedDesiredCoordinateAndMissingPermission()
    {
        var (request, host, snapshot) = RefreshInput(changed: true);
        ArticleEmbedRefreshSelection selection = request.Selections[0];
        ArticleEmbedRefreshPlanRequest stale = request with
        {
            Selections = [selection with { DesiredCoordinate = Coordinate(selection.Request.Target, 6) }]
        };
        ArticleEmbedRefreshPlanningResult drift = ArticleEmbedRefreshPlanner.Prepare(stale, host, snapshot);
        Assert.Equal(ArticleEmbedRefreshPlanStatus.Stale, drift.Status);
        Assert.Null(drift.Plan);

        host = host with
        {
            EditPermission = ArticleEmbedPermissionStatus.Denied
        };
        Assert.True(ArticleEmbedRefreshPlanner.TryComputeHostFactsDigest(host, out string? digest));
        ArticleEmbedRefreshPlanningResult denied = ArticleEmbedRefreshPlanner.Prepare(request with
        {
            ExpectedHostFactsDigest = digest!
        }, host, snapshot);
        Assert.Equal(ArticleEmbedRefreshPlanStatus.Blocked, denied.Status);
        Assert.Equal("article_embed_refresh_host_edit_unavailable", denied.ReasonCode);
        Assert.Null(denied.Plan);
    }

    [Theory]
    [InlineData("depth", ArticleEmbedErrorCode.DepthExceeded)]
    [InlineData("nodes", ArticleEmbedErrorCode.SizeExceeded)]
    [InlineData("bytes", ArticleEmbedErrorCode.SizeExceeded)]
    [InlineData("messages", ArticleEmbedErrorCode.SizeExceeded)]
    public void GraphRetainsTypedNestedBudgetFailures(string dimension, ArticleEmbedErrorCode expected)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedResolutionBudgetLimits budgets = dimension switch
        {
            "depth" => s_budgets with { MaxDepth = 1 },
            "nodes" => s_budgets with { MaxExpandedNodes = 1 },
            "bytes" => s_budgets with { MaxSourceBytes = 128 },
            _ => s_budgets with { MaxAuthorityMessages = 1 }
        };

        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets).Graph;

        ArticleEmbedResolvedNode child = Assert.Single(Assert.Single(graph.Results).Children);
        Assert.Equal(ArticleEmbedProviderResultStatus.Failed, child.Status);
        Assert.Equal(expected, child.Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, graph).Valid);
    }

    [Fact]
    public void GraphSharesProjectionMemoWhileKeepingNestedExpansionObservable()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedProviderRequest second = Request(ArticleB);
        second = ArticleEmbedContractValidator.Seal(second with
        {
            RequestId = "request:second"
        });
        requests = [requests[0], second];

        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.Single(evaluated.Graph.Results[0].Children);
        Assert.Empty(evaluated.Graph.Results[1].Children);
        Assert.True(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.Equal(3, evaluated.Graph.Receipt.Observed.Nodes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
    }

    [Fact]
    public void RefreshBlocksNestedCycleWithoutReturningPartialPlan()
    {
        var (request, host, snapshot) = RefreshInput(changed: true);
        ArticleEmbedTargetFacts facts = snapshot.Targets[0] with
        {
            NestedDirectives = [new(ArticleEmbedSchemas.ParserContract, ArticleA, ArticleEmbedTargetKind.Article, new(0, 32))]
        };
        snapshot = Snapshot(facts);
        request = request with
        {
            ExpectedAuthoritySnapshotDigest = snapshot.SnapshotDigest
        };
        ArticleEmbedProviderRequest[] requests = [request.Selections[0].Request];
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        Assert.Equal(ArticleEmbedErrorCode.Cycle, Assert.Single(graph.Results[0].Children).Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).Valid);

        ArticleEmbedRefreshPlanningResult result = ArticleEmbedRefreshPlanner.Prepare(request, host, snapshot);

        Assert.Equal(ArticleEmbedRefreshPlanStatus.Blocked, result.Status);
        Assert.Null(result.Plan);
    }

    public void Dispose() => _cancellation.Dispose();

    private (ArticleEmbedProviderRequest[] Requests, ArticleEmbedAuthoritySnapshot Snapshot) NestedGraph(ArticleEmbedTargetKind kind)
    {
        string token = kind switch
        {
            ArticleEmbedTargetKind.Heading => $"{ArticleB}#{Heading}",
            ArticleEmbedTargetKind.Block => $"{ArticleB}#release-notes",
            _ => ArticleB
        };
        var nested = new ArticleEmbedDirectiveProjection(ArticleEmbedSchemas.ParserContract, token, kind, new(0, 32));
        return ([Request(ArticleA)], Snapshot(Facts(ArticleA) with
        {
            NestedDirectives = [nested]
        }, Facts(ArticleB)));
    }

    private (ArticleEmbedRefreshPlanRequest Request, ArticleEmbedRefreshHostFacts Host, ArticleEmbedAuthoritySnapshot Snapshot) RefreshInput(bool changed)
    {
        ArticleEmbedProviderRequest provider = Request(ArticleA);
        ArticleEmbedDependencyCoordinate oldCoordinate = Coordinate(provider.Target, changed ? 4 : 5);
        var host = new ArticleEmbedRefreshHostFacts(
            new(Host, "draft:host", 8, s_document, 8, DigestC), s_actor, ArticleEmbedPermissionStatus.Allowed,
            [new("directive:root", provider.Directive, oldCoordinate)]);
        Assert.True(ArticleEmbedRefreshPlanner.TryComputeHostFactsDigest(host, out string? digest));
        ArticleEmbedAuthoritySnapshot snapshot = Snapshot(Facts(ArticleA));
        var request = new ArticleEmbedRefreshPlanRequest("refresh:one", s_actor, host.Host, digest!,
            snapshot.AuthorityGeneration, snapshot.SnapshotDigest, s_budgets,
            [new("directive:root", provider, oldCoordinate, Coordinate(provider.Target, 5))]);
        return (request, host, snapshot);
    }

    private ArticleEmbedProviderRequest Request(string token)
    {
        Assert.True(ArticleEmbedTargetCodec.TryDecode(token, ArticleEmbedTargetKind.Article, out ArticleEmbedTargetIdentity? target).IsValid);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:root", Host, s_document, 8,
            new(ArticleEmbedSchemas.ParserContract, token, ArticleEmbedTargetKind.Article, new(0, 32)), target!,
            ArticleEmbedRequestedScope.Authoring, s_actor, s_runtime, DigestC, string.Empty, _cancellation.Token));
    }

    private static ArticleEmbedDependencyCoordinate Coordinate(ArticleEmbedTargetIdentity target, long revision)
        => ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate, ArticleEmbedSchemas.Version, target, revision,
            $"revision:{revision}", "projection:article", DigestD, string.Empty));

    private static ArticleEmbedTargetFacts Facts(string article)
        => new(article, s_actor.SiteIdentity, 1, 5, 5, 5, ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed, DigestB, "revision:5", 128,
            "Target display", new(ArticleEmbedProjectionKind.SafeProjection, "projection:article", DigestD),
            [new(Heading, new(ArticleEmbedProjectionKind.SafeProjection, "projection:heading", DigestD))],
            [new("release-notes", new(ArticleEmbedProjectionKind.SafeProjection, "projection:block", DigestD))], []);

    private static string ProjectionIdentity(ArticleEmbedTargetKind kind) => kind switch
    {
        ArticleEmbedTargetKind.Heading => "projection:heading",
        ArticleEmbedTargetKind.Block => "projection:block",
        _ => "projection:article"
    };

    private static ArticleEmbedAuthoritySnapshot Snapshot(params ArticleEmbedTargetFacts[] targets)
        => ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version, Host, s_document,
            8, DigestC, 1, s_actor, s_runtime, "zh-CN", "light", targets, string.Empty));

    private sealed class CancellingTimeProvider(CancellationTokenSource cancellation) : TimeProvider
    {
        private int _observations;

        public override long GetTimestamp()
        {
            if (++_observations == 2)
            {
                cancellation.Cancel();
            }
            return _observations;
        }
    }
}
