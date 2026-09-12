using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedPublicationPlannerTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string ArticleC = "article:01991e72-c397-75a2-b61a-da6d7dbd8092";
    private const string HeadingA = "heading:01991e72-d093-78ad-b06d-8f7664902992";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string DigestD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    private static readonly ArticleEmbedActorContext s_actor =
        new("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", DigestA);

    private static readonly ArticleEmbedRuntimeContext s_runtime =
        new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB);

    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host-1", 3);

    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);

    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Fact]
    public void SealsPublicArticleHeadingAndBlockTargets()
    {
        var authority = Authority(
            PublicFacts(ArticleA, 17,
                headings: [new ArticleEmbedPublicationHeadingFact(HeadingA, Projection("projection:heading"))],
                blocks: [new ArticleEmbedPublicationBlockFact("release-notes-2026", Projection("projection:block"))]));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:article", ArticleA, ArticleEmbedTargetKind.Article, 0),
            Request("request:heading", $"{ArticleA}#{HeadingA}", ArticleEmbedTargetKind.Heading, 40),
            Request("request:block", $"{ArticleA}#release-notes-2026", ArticleEmbedTargetKind.Block, 80)
        ];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, plan.Status);
        Assert.Null(plan.BlockedReasonCode);
        Assert.Equal(3, plan.Edges.Count);
        Assert.All(plan.Edges, edge =>
        {
            Assert.Equal(ArticleEmbedPublicationEdgeStatus.Frozen, edge.Status);
            Assert.NotNull(edge.Coordinate);
            Assert.Equal(17, edge.Coordinate!.ResolvedRevision);
            Assert.Equal(Host, edge.OwnerPortableArticleIdentity);
            Assert.Equal(8, edge.OwnerRevision);
            Assert.Equal(1, edge.Depth);
            Assert.Null(edge.Error);
        });
        Assert.Equal("projection:article-body", plan.Edges[0].Coordinate!.ProjectionIdentity);
        Assert.Equal("projection:heading", plan.Edges[1].Coordinate!.ProjectionIdentity);
        Assert.Equal("projection:block", plan.Edges[2].Coordinate!.ProjectionIdentity);
        Assert.Equal(3, plan.Receipt.FrozenEdgeCount);
        Assert.Equal(0, plan.Receipt.BlockedEdgeCount);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
        Assert.True(ArticleEmbedPublicationContractValidator.ValidateForCommit(plan, authority).IsValid);
    }

    [Theory]
    [InlineData(ArticleEmbedVisibilityStatus.Private, ArticleEmbedLifecycleStatus.Published, ArticleEmbedErrorCode.Private)]
    [InlineData(ArticleEmbedVisibilityStatus.Unknown, ArticleEmbedLifecycleStatus.Published, ArticleEmbedErrorCode.Unpublished)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Draft, ArticleEmbedErrorCode.Draft)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Scheduled, ArticleEmbedErrorCode.Unpublished)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Archived, ArticleEmbedErrorCode.Archived)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Deleted, ArticleEmbedErrorCode.Deleted)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Unknown, ArticleEmbedErrorCode.Unpublished)]
    public void NonPublicTargetsBlockTheWholePlan(
        ArticleEmbedVisibilityStatus visibility,
        ArticleEmbedLifecycleStatus lifecycle,
        ArticleEmbedErrorCode expected)
    {
        var authority = Authority(PublicFacts(ArticleA, 9) with
        {
            Visibility = visibility,
            Lifecycle = lifecycle
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        ArticleEmbedPublicationEdge edge = Assert.Single(plan.Edges);
        Assert.Equal(ArticleEmbedPublicationEdgeStatus.Blocked, edge.Status);
        Assert.Equal(expected, edge.Error!.Code);
        Assert.Null(edge.Coordinate);
        Assert.Equal(edge.Error.SafeReasonCode, plan.BlockedReasonCode);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
        Assert.Equal(
            "article_embed_publication_plan_blocked",
            ArticleEmbedPublicationContractValidator.ValidateForCommit(plan, authority).ReasonCode);
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied, ArticleEmbedErrorCode.PermissionDenied)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, ArticleEmbedErrorCode.PermissionUnknown)]
    public void PermissionFailuresBlockPublication(
        ArticleEmbedPermissionStatus permission,
        ArticleEmbedErrorCode expected)
    {
        var authority = Authority(PublicFacts(ArticleA, 9) with
        {
            Permission = permission
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(expected, Assert.Single(plan.Edges).Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void IncompleteRevisionPackageBlocksPublication()
    {
        var authority = Authority(PublicFacts(ArticleA, 9) with
        {
            RevisionPackageComplete = false
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(ArticleEmbedErrorCode.Missing, Assert.Single(plan.Edges).Error!.Code);
        Assert.Equal("target_revision_incomplete", plan.BlockedReasonCode);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void MissingAmbiguousAndCoordinateFailuresBlockWithoutFirstMatch()
    {
        var authority = Authority(
            PublicFacts(ArticleA, 3,
                blocks:
                [
                    new ArticleEmbedPublicationBlockFact("dup-anchor", Projection("projection:one")),
                    new ArticleEmbedPublicationBlockFact("dup-anchor", Projection("projection:two"))
                ]),
            PublicFacts(ArticleB, 5),
            PublicFacts(ArticleB, 5));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:missing", ArticleC, ArticleEmbedTargetKind.Article, 0),
            Request("request:ambiguous", ArticleB, ArticleEmbedTargetKind.Article, 40),
            Request("request:heading-missing", $"{ArticleA}#{HeadingA}", ArticleEmbedTargetKind.Heading, 80),
            Request("request:block-duplicate", $"{ArticleA}#dup-anchor", ArticleEmbedTargetKind.Block, 120)
        ];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(4, plan.Edges.Count);
        Assert.Equal(ArticleEmbedErrorCode.Missing, plan.Edges[0].Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.Ambiguous, plan.Edges[1].Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.HeadingMissing, plan.Edges[2].Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.BlockDuplicate, plan.Edges[3].Error!.Code);
        Assert.Equal("target_missing", plan.BlockedReasonCode);
        Assert.Equal(0, plan.Receipt.FrozenEdgeCount);
        Assert.Equal(4, plan.Receipt.BlockedEdgeCount);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void NestedEmbedsFreezeAtTheOwnersResolvedRevision()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [toB]),
            PublicFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, plan.Status);
        Assert.Equal(2, plan.Edges.Count);
        Assert.Equal(Host, plan.Edges[0].OwnerPortableArticleIdentity);
        Assert.Equal(8, plan.Edges[0].OwnerRevision);
        Assert.Equal(ArticleA, plan.Edges[1].OwnerPortableArticleIdentity);
        Assert.Equal(4, plan.Edges[1].OwnerRevision);
        Assert.Equal(2, plan.Edges[1].Depth);
        Assert.Equal(6, plan.Edges[1].Coordinate!.ResolvedRevision);
        Assert.Equal(2, plan.Receipt.MaxObservedDepth);
        ArticleEmbedPublicationReceiptItem item = Assert.Single(plan.Receipt.Items);
        Assert.Equal(1, item.DescendantEdgeCount);
        Assert.Equal(0, item.BlockedDescendantCount);
        Assert.Equal(plan.Edges[0].EdgeDigest, item.EdgeDigest);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void SelfCycleAndMultiHopCycleBlockLocallyWithoutStackOverflow()
    {
        ArticleEmbedDirectiveProjection selfNested = Nested(ArticleA, ArticleEmbedTargetKind.Article, 10);
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 50);
        ArticleEmbedDirectiveProjection toA = Nested(ArticleA, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [selfNested, toB]),
            PublicFacts(ArticleB, 6, nested: [toA]));
        ArticleEmbedProviderRequest[] requests = [Request("request:cycles", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(4, plan.Edges.Count);
        Assert.Equal(ArticleEmbedPublicationEdgeStatus.Frozen, plan.Edges[0].Status);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, plan.Edges[1].Error!.Code);
        Assert.Equal(ArticleEmbedPublicationEdgeStatus.Frozen, plan.Edges[2].Status);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, plan.Edges[3].Error!.Code);
        Assert.Equal("embed_cycle", plan.BlockedReasonCode);
        ArticleEmbedPublicationVerification verification =
            ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan);
        Assert.True(verification.Valid, string.Join(",", verification.ReasonCodes));
    }

    [Fact]
    public void SharedSubtreeFreezesOnceAndRepeatReferencesStayConsistent()
    {
        ArticleEmbedDirectiveProjection toShared = Nested(ArticleC, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [toShared]),
            PublicFacts(ArticleB, 6, nested: [toShared]),
            PublicFacts(ArticleC, 8));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0),
            Request("request:b", ArticleB, ArticleEmbedTargetKind.Article, 40),
            Request("request:again", ArticleC, ArticleEmbedTargetKind.Article, 80)
        ];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, plan.Status);
        Assert.Equal(5, plan.Edges.Count);
        Assert.All(plan.Edges, edge => Assert.Equal(ArticleEmbedPublicationEdgeStatus.Frozen, edge.Status));
        string sharedCoordinateDigest = plan.Edges[1].Coordinate!.DependencyDigest;
        Assert.Equal(sharedCoordinateDigest, plan.Edges[3].Coordinate!.DependencyDigest);
        Assert.Equal(sharedCoordinateDigest, plan.Edges[4].Coordinate!.DependencyDigest);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void DepthNodeAndByteBudgetsBlockLocally()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        ArticleEmbedDirectiveProjection toC = Nested(ArticleC, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [toB], bytes: 700),
            PublicFacts(ArticleB, 6, nested: [toC], bytes: 700),
            PublicFacts(ArticleC, 8, bytes: 700));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        var depthLimited = new ArticleEmbedResolutionBudgetLimits(2, 64, 1_048_576, 60_000, 128);
        ArticleEmbedPublicationPlan deep = ArticleEmbedPublicationPlanner.Plan(requests, authority, depthLimited);
        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, deep.Status);
        Assert.Equal(ArticleEmbedErrorCode.DepthExceeded, deep.Edges[2].Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, depthLimited, deep).Valid);

        var nodeLimited = new ArticleEmbedResolutionBudgetLimits(8, 2, 1_048_576, 60_000, 128);
        ArticleEmbedPublicationPlan nodes = ArticleEmbedPublicationPlanner.Plan(requests, authority, nodeLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, nodes.Edges[2].Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, nodeLimited, nodes).Valid);

        var byteLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_000, 60_000, 128);
        ArticleEmbedPublicationPlan bytes = ArticleEmbedPublicationPlanner.Plan(requests, authority, byteLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, bytes.Edges[1].Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, byteLimited, bytes).Valid);

        var messageLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 2);
        ArticleEmbedPublicationPlan messages = ArticleEmbedPublicationPlanner.Plan(requests, authority, messageLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, messages.Edges[2].Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, messageLimited, messages).Valid);
    }

    [Fact]
    public void ElapsedBudgetBlocksWhenTheClockRunsOut()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        var time = new StepTimeProvider();
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 1, 128);

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, budgets, time);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(ArticleEmbedErrorCode.TimeExceeded, Assert.Single(plan.Edges).Error!.Code);
        Assert.Equal("elapsed_exceeded", plan.BlockedReasonCode);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, authority, budgets, plan).Valid);
    }

    [Fact]
    public void HostSourceActorRuntimeAndGenerationDriftBlock()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] driftedSource =
            [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0, sourceRevision: 99)];
        ArticleEmbedProviderRequest[] driftedEpoch =
            [Request("request:b", ArticleA, ArticleEmbedTargetKind.Article, 0, document: s_document with { Epoch = 9 })];
        ArticleEmbedProviderRequest[] driftedActor =
            [Request("request:c", ArticleA, ArticleEmbedTargetKind.Article, 0, actor: s_actor with { PermissionContextDigest = DigestD })];
        ArticleEmbedProviderRequest[] driftedRuntime =
            [Request("request:d", ArticleA, ArticleEmbedTargetKind.Article, 0, runtime: s_runtime with { RuntimeDigest = DigestD })];
        ArticleEmbedProviderRequest[] driftedHost =
            [Request("request:e", ArticleA, ArticleEmbedTargetKind.Article, 0, host: ArticleC)];

        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedPublicationPlanner.Plan(driftedSource, authority, s_budgets).Edges).Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedPublicationPlanner.Plan(driftedEpoch, authority, s_budgets).Edges).Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedPublicationPlanner.Plan(driftedActor, authority, s_budgets).Edges).Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleRuntime,
            Assert.Single(ArticleEmbedPublicationPlanner.Plan(driftedRuntime, authority, s_budgets).Edges).Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedPublicationPlanner.Plan(driftedHost, authority, s_budgets).Edges).Error!.Code);

        var driftedGeneration = Authority(PublicFacts(ArticleA, 4) with
        {
            AuthorityGeneration = 9
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:f", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan stale = ArticleEmbedPublicationPlanner.Plan(requests, driftedGeneration, s_budgets);
        Assert.Equal(ArticleEmbedErrorCode.StaleTarget, Assert.Single(stale.Edges).Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, driftedGeneration, s_budgets, stale).Valid);
    }

    [Fact]
    public void AbortedRequestBlocksItsEdges()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] aborted =
            [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0, cancellationToken: cancellation.Token)];

        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(aborted, authority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Blocked, plan.Status);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource, Assert.Single(plan.Edges).Error!.Code);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(aborted, authority, s_budgets, plan).Valid);
    }

    [Fact]
    public void WrongScopeAndMismatchedDirectivesBlock()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest wrongScope = ArticleEmbedContractValidator.Seal(
            Request("request:scope", ArticleA, ArticleEmbedTargetKind.Article, 0) with
            {
                RequestedScope = ArticleEmbedRequestedScope.Authoring
            });

        ArticleEmbedPublicationPlan scoped = ArticleEmbedPublicationPlanner.Plan([wrongScope], authority, s_budgets);
        Assert.Equal("publication_scope_required", Assert.Single(scoped.Edges).Error!.SafeReasonCode);
        Assert.True(ArticleEmbedPublicationVerifier.Verify([wrongScope], authority, s_budgets, scoped).Valid);

        // The sealed request contract already binds directive token to target, so a mismatched pair fails
        // validation before planning and records the request-level failure on the edge.
        ArticleEmbedProviderRequest mismatched = ArticleEmbedContractValidator.Seal(
            Request("request:mismatch", ArticleA, ArticleEmbedTargetKind.Article, 0) with
            {
                Directive = Nested(ArticleB, ArticleEmbedTargetKind.Article, 0)
            });
        ArticleEmbedPublicationPlan mismatch = ArticleEmbedPublicationPlanner.Plan([mismatched], authority, s_budgets);
        Assert.Equal("request_contract_invalid", Assert.Single(mismatch.Edges).Error!.SafeReasonCode);
        Assert.True(ArticleEmbedPublicationVerifier.Verify([mismatched], authority, s_budgets, mismatch).Valid);
    }

    [Fact]
    public void LaterTargetUpdatesNeverRewriteASealedPlan()
    {
        var firstAuthority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan sealedPlan = ArticleEmbedPublicationPlanner.Plan(requests, firstAuthority, s_budgets);
        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, sealedPlan.Status);
        Assert.Equal(4, Assert.Single(sealedPlan.Edges).Coordinate!.ResolvedRevision);

        var laterAuthority = Authority(PublicFacts(ArticleA, 9) with
        {
            LatestObservedRevision = 9
        });
        ArticleEmbedPublicationPlan later = ArticleEmbedPublicationPlanner.Plan(requests, laterAuthority, s_budgets);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, later.Status);
        Assert.Equal(9, Assert.Single(later.Edges).Coordinate!.ResolvedRevision);
        Assert.Equal(4, Assert.Single(sealedPlan.Edges).Coordinate!.ResolvedRevision);
        Assert.NotEqual(sealedPlan.PlanDigest, later.PlanDigest);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, laterAuthority, s_budgets, later).Valid);
        Assert.True(ArticleEmbedPublicationVerifier.Verify(requests, firstAuthority, s_budgets, sealedPlan).Valid);
    }

    [Fact]
    public void RejectsInvalidBudgetsTamperedAuthorityMissingRetentionAndOversizedSets()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        Assert.Equal(
            "article_embed_authoring_budgets_out_of_bounds",
            ArticleEmbedPublicationPlanner.Plan(requests, authority, null).BlockedReasonCode);
        Assert.Equal(
            "article_embed_authoring_budgets_out_of_bounds",
            ArticleEmbedPublicationPlanner.Plan(requests, authority, new ArticleEmbedResolutionBudgetLimits(0, 1, 1, 1, 1)).BlockedReasonCode);
        Assert.Equal(
            "article_embed_publication_authority_missing",
            ArticleEmbedPublicationPlanner.Plan(requests, null, s_budgets).BlockedReasonCode);
        Assert.Equal(
            "article_embed_publication_authority_digest_mismatch",
            ArticleEmbedPublicationPlanner.Plan(requests, authority with
            {
                AuthorityDigest = DigestD
            }, s_budgets).BlockedReasonCode);
        Assert.Equal(
            "frozen_artifact_retention_unavailable",
            ArticleEmbedPublicationPlanner.Plan(
                requests,
                ArticleEmbedPublicationContractValidator.Seal(authority with
                {
                    FrozenArtifactRetention = false
                }),
                s_budgets).BlockedReasonCode);
        Assert.Equal(
            "article_embed_publication_requests_missing",
            ArticleEmbedPublicationPlanner.Plan(null, authority, s_budgets).BlockedReasonCode);
        Assert.Equal(
            "article_embed_publication_request_set_exceeds_budget",
            ArticleEmbedPublicationPlanner.Plan(
                Enumerable.Range(0, 3)
                    .Select(index => Request($"request:{index}", ArticleA, ArticleEmbedTargetKind.Article, index * 40))
                    .ToArray(),
                authority,
                new ArticleEmbedResolutionBudgetLimits(8, 2, 1_048_576, 60_000, 128)).BlockedReasonCode);
    }

    [Fact]
    public void ValidateForCommitRejectsStaleOrBlockedPlans()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.True(ArticleEmbedPublicationContractValidator.ValidateForCommit(plan, authority).IsValid);
        Assert.Equal(
            "article_embed_publication_plan_stale",
            ArticleEmbedPublicationContractValidator.ValidateForCommit(
                plan,
                ArticleEmbedPublicationContractValidator.Seal(authority with
                {
                    AuthorityGeneration = 2
                })).ReasonCode);
        Assert.Equal(
            "article_embed_publication_authority_digest_mismatch",
            ArticleEmbedPublicationContractValidator.ValidateForCommit(plan, authority with
            {
                AuthorityDigest = DigestD
            }).ReasonCode);
        Assert.Equal(
            "article_embed_publication_plan_digest_mismatch",
            ArticleEmbedPublicationContractValidator.ValidateForCommit(plan with
            {
                PlanDigest = DigestD
            }, authority).ReasonCode);
    }

    [Fact]
    public void VerifierRejectsEdgeReceiptAndPlanTamper()
    {
        var authority = Authority(PublicFacts(ArticleA, 17));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, null).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Edges = [ArticleEmbedPublicationContractValidator.Seal(plan.Edges[0] with { Depth = 2 })]
        }).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Receipt = plan.Receipt with
            {
                FrozenEdgeCount = 0
            }
        }).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Receipt = plan.Receipt with
            {
                Items = [plan.Receipt.Items[0] with { ResolvedRevision = 18 }]
            }
        }).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(
            requests,
            Authority(PublicFacts(ArticleA, 18)),
            s_budgets,
            plan).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Status = ArticleEmbedPublicationPlanStatus.Blocked,
            BlockedReasonCode = "fabricated"
        }).Valid);
    }

    [Fact]
    public void VerifierRejectsDroppedReorderedAndFabricatedEdges()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [toB]),
            PublicFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        Assert.Equal(2, plan.Edges.Count);

        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Edges = [plan.Edges[0]]
        }).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Edges = [plan.Edges[1], plan.Edges[0]]
        }).Valid);
        Assert.False(ArticleEmbedPublicationVerifier.Verify(requests, authority, s_budgets, plan with
        {
            Edges =
            [
                plan.Edges[0],
                ArticleEmbedPublicationContractValidator.Seal(plan.Edges[1] with
                {
                    Coordinate = plan.Edges[1].Coordinate! with { ResolvedRevision = 7 }
                })
            ]
        }).Valid);
    }

    private static ArticleEmbedProviderRequest Request(
        string requestId,
        string token,
        ArticleEmbedTargetKind mode,
        int start,
        long sourceRevision = 8,
        ArticleEmbedDocumentIdentity? document = null,
        ArticleEmbedActorContext? actor = null,
        ArticleEmbedRuntimeContext? runtime = null,
        string? host = null,
        CancellationToken cancellationToken = default)
    {
        CancellationToken signal = cancellationToken.CanBeCanceled
            ? cancellationToken
            : s_signal;
        ArticleEmbedTargetCodec.TryDecode(token, mode, out ArticleEmbedTargetIdentity? target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest,
            ArticleEmbedSchemas.Version,
            requestId,
            host ?? Host,
            document ?? s_document,
            sourceRevision,
            new ArticleEmbedDirectiveProjection(
                ArticleEmbedSchemas.ParserContract,
                token,
                mode,
                new ArticleEmbedSourceRange(start, start + 32)),
            target!,
            ArticleEmbedRequestedScope.PublicationPlan,
            actor ?? s_actor,
            runtime ?? s_runtime,
            DigestC,
            string.Empty,
            signal));
    }

    private static ArticleEmbedDirectiveProjection Nested(string token, ArticleEmbedTargetKind mode, int start)
        => new(ArticleEmbedSchemas.ParserContract, token, mode, new ArticleEmbedSourceRange(start, start + 32));

    private static ArticleEmbedSafeProjectionReference Projection(string identity)
        => new(ArticleEmbedProjectionKind.SafeProjection, identity, DigestD);

    private static ArticleEmbedPublicationTargetFacts PublicFacts(
        string portableIdentity,
        long resolvedRevision,
        ArticleEmbedPublicationHeadingFact[]? headings = null,
        ArticleEmbedPublicationBlockFact[]? blocks = null,
        ArticleEmbedDirectiveProjection[]? nested = null,
        long bytes = 128)
        => new(
            portableIdentity,
            s_actor.SiteIdentity,
            1,
            resolvedRevision,
            resolvedRevision,
            ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published,
            ArticleEmbedPermissionStatus.Allowed,
            true,
            DigestB,
            $"version:{resolvedRevision}",
            DigestA,
            bytes,
            "Target display",
            Projection("projection:article-body"),
            headings ?? [],
            blocks ?? [],
            nested ?? []);

    private static ArticleEmbedPublicationAuthority Authority(params ArticleEmbedPublicationTargetFacts[] targets)
        => ArticleEmbedPublicationContractValidator.Seal(new ArticleEmbedPublicationAuthority(
            ArticleEmbedPublicationSchemas.Authority,
            ArticleEmbedPublicationSchemas.Version,
            Host,
            s_document,
            8,
            DigestC,
            "publication:request-1",
            9,
            1,
            s_actor,
            s_runtime,
            "zh-CN",
            "light",
            true,
            targets,
            string.Empty));

    private sealed class StepTimeProvider : TimeProvider
    {
        private long _now = 1_000_000;

        public override long GetTimestamp() => _now += TimestampFrequency * 60;
    }
}
