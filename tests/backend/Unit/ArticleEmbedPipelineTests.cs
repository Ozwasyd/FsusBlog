using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

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
        Assert.Equal(256, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
    }

    [Theory]
    [InlineData("lower-limit")]
    [InlineData("lower-limit-consistent")]
    [InlineData("receipt-bytes")]
    [InlineData("result-bytes")]
    public void GraphRejectsResealedByteBudgetDrift(string dimension)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        ArticleEmbedResolutionBudgetLimits budgets = dimension.StartsWith("lower-limit", StringComparison.Ordinal)
            ? s_budgets with
            {
                MaxSourceBytes = 128
            } : s_budgets;
        ArticleEmbedAuthoringEmbedResult root = Assert.Single(graph.Results);
        bool changeResult = dimension is "lower-limit-consistent" or "result-bytes";
        graph = ResealGraph(graph with
        {
            Results = [root with { Result = root.Result with
            {
                Budgets = root.Result.Budgets with { Bytes = changeResult ? 0 : 256 }
            } }],
            Receipt = graph.Receipt with
            {
                Budgets = budgets,
                Observed = graph.Receipt.Observed with
                {
                    Bytes = dimension == "result-bytes" ? 256 : 0
                }
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, budgets, graph);
    }

    [Theory]
    [InlineData(ArticleEmbedErrorCode.SizeExceeded, "expanded_nodes_exceeded")]
    [InlineData(ArticleEmbedErrorCode.SizeExceeded, "source_bytes_exceeded")]
    [InlineData(ArticleEmbedErrorCode.SizeExceeded, "authority_messages_exceeded")]
    [InlineData(ArticleEmbedErrorCode.StaleSource, "request_aborted")]
    public void GraphRejectsUnobservedNestedFailures(ArticleEmbedErrorCode code, string reason)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        ArticleEmbedAuthoringEmbedResult root = Assert.Single(graph.Results);
        ArticleEmbedResolvedNode child = Assert.Single(root.Children);
        graph = ResealGraph(graph with
        {
            Results = [root with { Children = [child with
            {
                Status = ArticleEmbedProviderResultStatus.Failed,
                Coordinate = null,
                Error = new(code, reason),
                Children = []
            }] }]
        });

        Assert.False(requests[0].AbortSignal.IsCancellationRequested);
        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, graph);
    }

    [Theory]
    [InlineData(false, 5)]
    [InlineData(false, 60_001)]
    [InlineData(true, 5)]
    [InlineData(true, 60_001)]
    public void GraphRejectsUnwitnessedTimeoutEvenWithResealedElapsed(bool rootFailure, long elapsed)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        ArticleEmbedAuthoringEmbedResult root = Assert.Single(graph.Results);
        ArticleEmbedResolvedNode child = Assert.Single(root.Children);
        var error = new ArticleEmbedError(ArticleEmbedErrorCode.TimeExceeded, "elapsed_exceeded");
        root = rootFailure ? root with
        {
            Result = root.Result with
            {
                Status = ArticleEmbedProviderResultStatus.Failed,
                Coordinate = null,
                Projection = null,
                Attribution = null,
                Visibility = ArticleEmbedVisibilityStatus.Unknown,
                Lifecycle = ArticleEmbedLifecycleStatus.Unknown,
                Permission = ArticleEmbedPermissionStatus.Unknown,
                Error = error
            },
            Eligibility = ArticleEmbedPublicationEligibility.AuthoringOnly,
            OpenSource = null,
            UpdateAvailable = false,
            Children = []
        } : root with
        {
            Children = [child with
        {
            Status = ArticleEmbedProviderResultStatus.Failed, Coordinate = null, Error = error, Children = []
        }]
        };
        var observed = new ArticleEmbedBudgetObservation(rootFailure ? 1 : 2, rootFailure ? 1 : 2,
            rootFailure ? 0 : 128, elapsed);
        graph = ResealGraph(graph with
        {
            Results = [root with { Result = root.Result with { Budgets = observed } }],
            Receipt = graph.Receipt with
            {
                Observed = observed,
                MaxObservedDepth = observed.Depth
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, graph);
        Assert.Contains("graph_time_evidence_unavailable",
            ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, graph).ReasonCodes);
    }

    [Fact]
    public void GraphRecordsRealTimeoutButCannotAdmitItWithoutIndependentTimeEvidence()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedResolutionBudgetLimits budgets = s_budgets with
        {
            MaxElapsedMilliseconds = 1
        };
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets, new StepTimeProvider());

        Assert.Equal(ArticleEmbedErrorCode.TimeExceeded, Assert.Single(evaluated.Graph.Results[0].Children).Error!.Code);
        Assert.True(evaluated.Graph.Receipt.Observed.ElapsedMilliseconds > budgets.MaxElapsedMilliseconds);
        AssertGraphRejectedEverywhere(requests, snapshot, budgets, evaluated.Graph);
    }

    [Fact]
    public void GraphRetainsCancellationObservedOnTheActualRequest()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        _cancellation.Cancel();
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedErrorCode.StaleSource, Assert.Single(evaluated.Graph.Results).Result.Error!.Code);
        Assert.Equal(0, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
    }

    [Fact]
    public void GraphChecksMonotonicResultAndReceiptElapsedObservations()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedProviderRequest second = ArticleEmbedContractValidator.Seal(Request(ArticleB) with
        {
            RequestId = "request:second"
        });
        requests = [requests[0], second];
        ArticleEmbedAuthoringResolution graph = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets).Graph;
        ArticleEmbedAuthoringEmbedResult first = graph.Results[0];
        ArticleEmbedAuthoringEmbedResult last = graph.Results[1];
        graph = ResealGraph(graph with
        {
            Results = [first with { Result = first.Result with { Budgets = first.Result.Budgets with { ElapsedMilliseconds = 10 } } },
                last with { Result = last.Result with { Budgets = last.Result.Budgets with { ElapsedMilliseconds = 5 } } }],
            Receipt = graph.Receipt with
            {
                Observed = graph.Receipt.Observed with
                {
                    ElapsedMilliseconds = 20
                }
            }
        });
        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, graph);

        graph = ResealGraph(graph with
        {
            Results = [graph.Results[0] with { Result = graph.Results[0].Result with
            {
                Budgets = graph.Results[0].Result.Budgets with { ElapsedMilliseconds = 1 }
            } }, graph.Results[1]],
            Receipt = graph.Receipt with
            {
                Observed = graph.Receipt.Observed with
                {
                    ElapsedMilliseconds = 4
                }
            }
        });
        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, graph);
    }

    [Fact]
    public void GraphChargesOnlyFreshAuthorizedProjectionReadsAtTheByteBoundary()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedProviderRequest second = ArticleEmbedContractValidator.Seal(Request(ArticleB) with
        {
            RequestId = "request:second"
        });
        requests = [requests[0], second];
        ArticleEmbedResolutionBudgetLimits budgets = s_budgets with
        {
            MaxSourceBytes = 256
        };
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);

        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, evaluated.Graph).Valid);
        Assert.All(evaluated.Graph.Results, result => Assert.Equal(256, result.Result.Budgets.Bytes));
        Assert.True(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.Equal(256, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.True(evaluated.Relations.Accepted);
        Assert.True(ArticleEmbedAuthoringRefreshPolicy.TryCompare(requests, snapshot, budgets, evaluated.Graph,
            requests[0].RequestId, Coordinate(requests[0].Target, 4), out bool update).IsValid);
        Assert.True(update);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GraphRetainsVerifiedProjectionStageBudgetFailures(bool messages)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        if (messages)
        {
            requests = [requests[0], ArticleEmbedContractValidator.Seal(Request(ArticleB) with { RequestId = "request:second" })];
        }
        ArticleEmbedResolutionBudgetLimits budgets = messages ? s_budgets with
        {
            MaxAuthorityMessages = 1
        }
            : s_budgets with
            {
                MaxSourceBytes = 127
            };
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);

        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, evaluated.Graph.Results[^1].Result.Error!.Code);
        Assert.Equal(messages ? 128 : 0, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, evaluated.Graph).Valid);
    }

    [Fact]
    public void GraphRechargesPathSensitiveParentsAndDoesNotChargeDeniedSource()
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedProviderRequest second = ArticleEmbedContractValidator.Seal(Request(ArticleA) with
        {
            RequestId = "request:second"
        });
        requests = [requests[0], second];
        snapshot = Snapshot(snapshot.Targets[0], snapshot.Targets[1] with
        {
            NestedDirectives = [new(ArticleEmbedSchemas.ParserContract, Host, ArticleEmbedTargetKind.Article, new(0, 32))]
        });
        ArticleEmbedResolutionBudgetLimits budgets = s_budgets with
        {
            MaxSourceBytes = 512
        };
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);
        Assert.Equal(512, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.False(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, evaluated.Graph).Valid);

        snapshot = Snapshot(snapshot.Targets[0], snapshot.Targets[1] with
        {
            Permission = ArticleEmbedPermissionStatus.Denied
        });
        evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);
        Assert.Equal(128, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, evaluated.Graph).Valid);
    }


    [Theory]
    [InlineData(ArticleEmbedErrorCode.PermissionDenied)]
    [InlineData(ArticleEmbedErrorCode.PermissionUnknown)]
    [InlineData(ArticleEmbedErrorCode.Missing)]
    [InlineData(ArticleEmbedErrorCode.Archived)]
    [InlineData(ArticleEmbedErrorCode.StaleTarget)]
    public void GraphMemoAdmitsCopiedProjectionFailuresAfterNestedExpansion(ArticleEmbedErrorCode code)
    {
        var (requests, snapshot) = MemoGraphInput(denied: true);
        ArticleEmbedTargetFacts target = snapshot.Targets[1] with
        {
            Permission = code == ArticleEmbedErrorCode.PermissionDenied ? ArticleEmbedPermissionStatus.Denied
                : code == ArticleEmbedErrorCode.PermissionUnknown ? ArticleEmbedPermissionStatus.Unknown
                : ArticleEmbedPermissionStatus.Allowed,
            Lifecycle = code == ArticleEmbedErrorCode.Archived ? ArticleEmbedLifecycleStatus.Archived
                : ArticleEmbedLifecycleStatus.Published,
            AuthorityGeneration = code == ArticleEmbedErrorCode.StaleTarget ? 2 : 1
        };
        snapshot = code == ArticleEmbedErrorCode.Missing ? Snapshot(snapshot.Targets[0])
            : Snapshot(snapshot.Targets[0], target);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(evaluated.Graph).IsValid);
        Assert.Equal(code, evaluated.Graph.Results[1].Result.Error!.Code);
        Assert.False(evaluated.Projection.Receipt.Items[1].CacheHit);
        Assert.False(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.Equal(0, evaluated.Graph.Receipt.CacheHitCount);
        Assert.Equal(128, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.Equal(3, evaluated.Graph.Receipt.Observed.Nodes);
        Assert.Equal(2, evaluated.Graph.Receipt.Observed.Depth);

        foreach (ArticleEmbedProviderRequest request in requests)
        {
            var single = ArticleEmbedAuthoringPipeline.Evaluate([request], snapshot, s_budgets);
            Assert.True(ArticleEmbedDependencyGraphVerifier.Verify([request], snapshot, s_budgets, single.Graph).Valid);
        }
        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph);
        Assert.True(verification.Valid, string.Join(", ", verification.ReasonCodes));
        Assert.True(evaluated.Relations.Accepted);
        ArticleEmbedRelationEdge edge = Assert.Single(evaluated.Relations.EdgeSet!.Edges);
        Assert.Equal(Host, edge.OwnerPortableArticleIdentity);
        Assert.Equal(ArticleA, edge.Target.PortableArticleIdentity);
    }

    [Fact]
    public void GraphMemoUsesGraphHitsWhenProjectionHasOnlySeenTheRoot()
    {
        var (requests, snapshot) = MemoGraphInput(denied: false);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.False(evaluated.Projection.Receipt.Items[1].CacheHit);
        Assert.True(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.Equal(1, evaluated.Graph.Receipt.CacheHitCount);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
    }

    [Fact]
    public void GraphMemoCopiesRepeatedProjectionFailureHits()
    {
        var (requests, snapshot) = MemoGraphInput(denied: true);
        ArticleEmbedProviderRequest repeated = ArticleEmbedContractValidator.Seal(requests[1] with
        {
            RequestId = "request:third"
        });
        requests = [requests[0], requests[1], repeated];
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.False(evaluated.Projection.Receipt.Items[1].CacheHit);
        Assert.True(evaluated.Projection.Receipt.Items[2].CacheHit);
        Assert.False(evaluated.Graph.Receipt.Items[1].CacheHit);
        Assert.True(evaluated.Graph.Receipt.Items[2].CacheHit);
        Assert.Equal(1, evaluated.Graph.Receipt.CacheHitCount);
        Assert.Equal(128, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.Equal(4, evaluated.Graph.Receipt.Observed.Nodes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
        Assert.Single(evaluated.Relations.EdgeSet!.Edges);
    }

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleEmbedTargetKind.Block)]
    public void GraphMemoLeavesUnboundSelectedProjectionFailuresUncached(ArticleEmbedTargetKind kind)
    {
        var (requests, snapshot) = UnboundMemoGraphInput(kind);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);

        Assert.True(evaluated.Projection.Receipt.Items[1].CacheHit);
        Assert.All(evaluated.Graph.Receipt.Items, item => Assert.False(item.CacheHit));
        Assert.All(evaluated.Graph.Results, result => Assert.Equal(ArticleEmbedErrorCode.InvalidTarget, result.Result.Error!.Code));
        Assert.Equal(128, evaluated.Graph.Results[0].Result.Budgets.Bytes);
        Assert.Equal(256, evaluated.Graph.Results[1].Result.Budgets.Bytes);
        Assert.Equal(0, evaluated.Graph.Receipt.CacheHitCount);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, evaluated.Graph).Valid);
    }

    [Theory]
    [InlineData("projection")]
    [InlineData("graph")]
    [InlineData("unbound")]
    public void GraphMemoRejectsHitsBorrowedFromTheOtherStage(string stage)
    {
        var (requests, snapshot) = stage == "unbound" ? UnboundMemoGraphInput(ArticleEmbedTargetKind.Heading)
            : MemoGraphInput(denied: stage == "projection", cyclic: stage == "graph");
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        Assert.False(evaluated.Graph.Receipt.Items[1].CacheHit);
        ArticleEmbedAuthoringResolution forged = ResealGraph(evaluated.Graph with
        {
            Receipt = evaluated.Graph.Receipt with
            {
                CacheHitCount = 1,
                Items = [evaluated.Graph.Receipt.Items[0], evaluated.Graph.Receipt.Items[1] with { CacheHit = true }]
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, forged);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public void GraphMemoRejectsAnIncorrectAggregateHitCount(int count)
    {
        var (requests, snapshot) = MemoGraphInput(denied: false);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        Assert.Equal(1, evaluated.Graph.Receipt.CacheHitCount);
        ArticleEmbedAuthoringResolution forged = ResealGraph(evaluated.Graph with
        {
            Receipt = evaluated.Graph.Receipt with
            {
                CacheHitCount = count
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, forged);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GraphMemoRejectsUnderreportedHitsInEitherStage(bool projectionFailure)
    {
        var (requests, snapshot) = MemoGraphInput(denied: projectionFailure);
        if (projectionFailure)
        {
            requests = [ArticleEmbedContractValidator.Seal(requests[1] with { RequestId = "request:first" }), requests[1]];
        }
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        Assert.True(evaluated.Graph.Receipt.Items[1].CacheHit);
        ArticleEmbedAuthoringResolution forged = ResealGraph(evaluated.Graph with
        {
            Receipt = evaluated.Graph.Receipt with
            {
                CacheHitCount = 0,
                Items = [evaluated.Graph.Receipt.Items[0], evaluated.Graph.Receipt.Items[1] with { CacheHit = false }]
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, s_budgets, forged);
    }

    [Fact]
    public void GraphMemoRejectsAFalseHitUsedToDiscountSourceBytes()
    {
        var (requests, snapshot) = MemoGraphInput(denied: false, cyclic: true);
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets);
        Assert.Equal(512, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.False(evaluated.Graph.Receipt.Items[1].CacheHit);
        ArticleEmbedAuthoringEmbedResult second = evaluated.Graph.Results[1];
        ArticleEmbedResolutionBudgetLimits budgets = s_budgets with
        {
            MaxSourceBytes = 256
        };
        ArticleEmbedAuthoringResolution forged = ResealGraph(evaluated.Graph with
        {
            Results = [evaluated.Graph.Results[0], second with
            {
                Result = second.Result with { Budgets = second.Result.Budgets with { Bytes = 256 } }
            }],
            Receipt = evaluated.Graph.Receipt with
            {
                Budgets = budgets,
                Observed = evaluated.Graph.Receipt.Observed with
                {
                    Bytes = 256
                },
                CacheHitCount = 1,
                Items = [evaluated.Graph.Receipt.Items[0], evaluated.Graph.Receipt.Items[1] with { CacheHit = true }]
            }
        });

        AssertGraphRejectedEverywhere(requests, snapshot, budgets, forged);
    }

    [Fact]
    public void GraphMemoCopiedFailureDoesNotAvoidAnAuthorityMessageRead()
    {
        var (requests, snapshot) = MemoGraphInput(denied: true);
        const string MissingToken = "article:01991e72-c871-7a86-bc95-5518cf8bd7dc";
        ArticleEmbedTargetFacts parent = snapshot.Targets[0] with
        {
            NestedDirectives = [snapshot.Targets[0].NestedDirectives[0],
                new(ArticleEmbedSchemas.ParserContract, MissingToken, ArticleEmbedTargetKind.Article, new(32, 64))]
        };
        snapshot = Snapshot(parent, snapshot.Targets[1]);
        requests = [requests[1], requests[0]];
        ArticleEmbedResolutionBudgetLimits budgets = s_budgets with
        {
            MaxAuthorityMessages = 2
        };
        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, budgets);
        ArticleEmbedAuthoringEmbedResult root = evaluated.Graph.Results[1];
        ArticleEmbedResolvedNode child = root.Children[1];
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, child.Error!.Code);
        Assert.Equal("authority_messages_exceeded", child.Error.SafeReasonCode);
        Assert.Equal(128, evaluated.Graph.Receipt.Observed.Bytes);
        Assert.Equal(4, evaluated.Graph.Receipt.Observed.Nodes);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, evaluated.Graph).Valid);
        Assert.Single(evaluated.Relations.EdgeSet!.Edges);

        ArticleEmbedAuthoringResolution forged = ResealGraph(evaluated.Graph with
        {
            Results = [evaluated.Graph.Results[0], root with
            {
                Children = [root.Children[0], child with { Error = new(ArticleEmbedErrorCode.Missing, "target_missing") }]
            }]
        });
        AssertGraphRejectedEverywhere(requests, snapshot, budgets, forged);
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

    private static void AssertGraphRejectedEverywhere(ArticleEmbedProviderRequest[] requests,
        ArticleEmbedAuthoritySnapshot snapshot, ArticleEmbedResolutionBudgetLimits budgets, ArticleEmbedAuthoringResolution graph)
    {
        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(graph).IsValid);
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, graph).Valid);
        Assert.False(ArticleEmbedRelationDeriver.DeriveFromGraph(requests, snapshot, budgets, graph).Accepted);
        Assert.False(ArticleEmbedAuthoringRefreshPolicy.TryCompare(requests, snapshot, budgets, graph,
            requests[0].RequestId, Coordinate(requests[0].Target, 4), out bool update).IsValid);
        Assert.False(update);
    }

    private static ArticleEmbedAuthoringResolution ResealGraph(ArticleEmbedAuthoringResolution graph)
    {
        ArticleEmbedAuthoringEmbedResult[] results = graph.Results.Select(result => result with
        {
            Result = ArticleEmbedContractValidator.Seal(result.Result)
        }).ToArray();
        ArticleEmbedAuthoringReceipt receipt = graph.Receipt with
        {
            ResolvedCount = results.Count(result => result.Result.Status == ArticleEmbedProviderResultStatus.Resolved),
            FailedCount = results.Count(result => result.Result.Status == ArticleEmbedProviderResultStatus.Failed),
            Items = graph.Receipt.Items.Select((item, index) => item with
            {
                Status = results[index].Result.Status,
                ErrorCode = results[index].Result.Error?.Code,
                Visibility = results[index].Result.Visibility,
                Lifecycle = results[index].Result.Lifecycle,
                Permission = results[index].Result.Permission,
                ResolvedRevision = results[index].Result.Coordinate?.ResolvedRevision,
                Eligibility = results[index].Eligibility,
                ChildCount = results[index].Children.Count,
                ResultDigest = results[index].Result.ResultDigest
            }).ToArray()
        };
        receipt = receipt with
        {
            ReceiptDigest = ArticleEmbedAuthoringDigest.ComputeReceipt(receipt)
        };
        graph = graph with
        {
            Results = results,
            Receipt = receipt
        };
        return graph with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(graph)
        };
    }

    private (ArticleEmbedProviderRequest[] Requests, ArticleEmbedAuthoritySnapshot Snapshot) MemoGraphInput(bool denied, bool cyclic = false)
    {
        var (requests, snapshot) = NestedGraph(ArticleEmbedTargetKind.Article);
        ArticleEmbedProviderRequest second = ArticleEmbedContractValidator.Seal(Request(cyclic ? ArticleA : ArticleB) with
        {
            RequestId = "request:second"
        });
        ArticleEmbedTargetFacts target = snapshot.Targets[1] with
        {
            Permission = denied ? ArticleEmbedPermissionStatus.Denied : ArticleEmbedPermissionStatus.Allowed,
            NestedDirectives = cyclic ? [new(ArticleEmbedSchemas.ParserContract, Host, ArticleEmbedTargetKind.Article, new(0, 32))] : []
        };
        return ([requests[0], second], Snapshot(snapshot.Targets[0], target));
    }

    private (ArticleEmbedProviderRequest[] Requests, ArticleEmbedAuthoritySnapshot Snapshot) UnboundMemoGraphInput(ArticleEmbedTargetKind kind)
    {
        string token = kind == ArticleEmbedTargetKind.Heading ? $"{ArticleB}#{Heading}" : $"{ArticleB}#release-notes";
        Assert.True(ArticleEmbedTargetCodec.TryDecode(token, kind, out ArticleEmbedTargetIdentity? target).IsValid);
        ArticleEmbedProviderRequest first = ArticleEmbedContractValidator.Seal(Request(ArticleB) with
        {
            Directive = new(ArticleEmbedSchemas.ParserContract, token, kind, new(0, 32)),
            Target = target!
        });
        ArticleEmbedProviderRequest second = ArticleEmbedContractValidator.Seal(first with
        {
            RequestId = "request:second"
        });
        return ([first, second], Snapshot(Facts(ArticleB) with
        {
            NestedDirectives = [new(ArticleEmbedSchemas.ParserContract, Host, ArticleEmbedTargetKind.Article, new(0, 32))]
        }));
    }

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

    private sealed class StepTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => 1000;

        public override long GetTimestamp() => ++_timestamp;
    }
}
