using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedRelationDeriverTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string ArticleC = "article:01991e72-c397-75a2-b61a-da6d7dbd8092";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string DigestD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    private static readonly ArticleEmbedActorContext s_actor =
        new("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", DigestA);

    private static readonly ArticleEmbedActorContext s_otherActor =
        new("actor:01991e72-ffff-7fff-afff-027699b78ad8", "site:primary", DigestD);

    private static readonly ArticleEmbedRuntimeContext s_runtime =
        new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB);

    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host-1", 3);

    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);

    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Fact]
    public void DerivesAuthoringEdgesFromVerifiedResolutionOnly()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        var snapshot = Snapshot(
            AuthoringFacts(ArticleA, 4, nested: [toB]),
            AuthoringFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests = [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution =
            ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedRelationDerivation derivation =
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, s_budgets, resolution);

        Assert.True(derivation.Accepted);
        ArticleEmbedRelationEdgeSet set = derivation.EdgeSet!;
        Assert.Equal(ArticleEmbedEdgeScope.Authoring, set.Scope);
        Assert.Equal(2, set.Edges.Count);
        Assert.Equal(Host, set.Edges[0].OwnerPortableArticleIdentity);
        Assert.Equal(8, set.Edges[0].OwnerRevision);
        Assert.Equal(ArticleA, set.Edges[1].OwnerPortableArticleIdentity);
        Assert.Equal(4, set.Edges[1].OwnerRevision);
        Assert.All(set.Edges, edge => Assert.Equal(ArticleEmbedEdgeStatus.Current, edge.Status));
        Assert.Equal(resolution.Receipt.ReceiptDigest, set.SourceArtifactDigest);
        Assert.Empty(derivation.DependencyReceipts);
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests, snapshot, s_budgets, resolution, derivation).Valid);

        ArticleEmbedRelationDerivation again =
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, s_budgets, resolution);
        Assert.Equal(set.SetDigest, again.EdgeSet!.SetDigest);
    }

    [Fact]
    public void FailedAuthoringTargetsProduceNoEdges()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests =
        [
            AuthoringRequest("request:ok", ArticleA, ArticleEmbedTargetKind.Article, 0),
            AuthoringRequest("request:missing", ArticleB, ArticleEmbedTargetKind.Article, 40)
        ];
        ArticleEmbedAuthoringResolution resolution =
            ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedRelationDerivation derivation =
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, s_budgets, resolution);

        Assert.True(derivation.Accepted);
        Assert.Single(derivation.EdgeSet!.Edges);
        Assert.Equal(ArticleA, derivation.EdgeSet.Edges[0].Target.PortableArticleIdentity);
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests, snapshot, s_budgets, resolution, derivation).Valid);
    }

    [Fact]
    public void DerivesFrozenEdgesAndDependencyReceiptsFromSealedPlanOnly()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(
            PublicFacts(ArticleA, 4, nested: [toB]),
            PublicFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);

        ArticleEmbedRelationDerivation derivation =
            ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);

        Assert.True(derivation.Accepted);
        ArticleEmbedRelationEdgeSet set = derivation.EdgeSet!;
        Assert.Equal(ArticleEmbedEdgeScope.FrozenPublication, set.Scope);
        Assert.Equal(2, set.Edges.Count);
        Assert.All(set.Edges, edge =>
        {
            Assert.Equal(ArticleEmbedEdgeStatus.Frozen, edge.Status);
            Assert.Equal(ArticleEmbedVisibilityStatus.Public, edge.Visibility);
            Assert.Equal(ArticleEmbedLifecycleStatus.Published, edge.Lifecycle);
        });
        Assert.Equal(plan.PlanDigest, set.SourceArtifactDigest);
        Assert.Equal(2, derivation.DependencyReceipts.Count);
        for (int index = 0; index < 2; index++)
        {
            Assert.Equal(plan.PlanDigest, derivation.DependencyReceipts[index].PlanDigest);
            Assert.Equal(plan.Edges[index].EdgeDigest, derivation.DependencyReceipts[index].PublicationEdgeDigest);
            Assert.Equal(plan.Edges[index].Coordinate, derivation.DependencyReceipts[index].Coordinate);
        }
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromPlan(
            requests, authority, s_budgets, plan, derivation).Valid);
    }

    [Fact]
    public void FrozenProjectionRetainsCompleteNestedReceiptsAfterTargetUpdate()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        var authority = Authority(PublicFacts(ArticleA, 4, nested: [toB]), PublicFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationDerivation original = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);
        var mutableReceipts = original.DependencyReceipts.ToList();
        ArticleEmbedRelationDerivation derivation = original with
        {
            DependencyReceipts = mutableReceipts
        };

        Assert.True(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, derivation, out var first).IsValid);
        Assert.Equal(2, first.Length);
        Assert.Equal(new long[] { 4, 6 }, first.Select(receipt => receipt.Coordinate.ResolvedRevision));
        mutableReceipts.Clear();
        Assert.Equal(2, first.Length);

        var changedAuthority = Authority(PublicFacts(ArticleA, 9), PublicFacts(ArticleB, 12));
        ArticleEmbedPublicationPlan changedPlan = ArticleEmbedPublicationPlanner.Plan(requests, changedAuthority, s_budgets);
        Assert.NotEqual(plan.PlanDigest, changedPlan.PlanDigest);
        Assert.True(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, original, out var afterUpdate).IsValid);
        Assert.Equal(first.ToArray(), afterUpdate.ToArray());
        Assert.False(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, changedPlan, original, out var refused).IsValid);
        Assert.Empty(refused);
    }

    [Fact]
    public void FrozenProjectionRejectsMissingReorderedDuplicateForeignAndResealedReceipts()
    {
        var authority = Authority(PublicFacts(ArticleA, 4), PublicFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests =
        [
            PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0),
            PublicationRequest("request:b", ArticleB, ArticleEmbedTargetKind.Article, 100)
        ];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationDerivation original = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);
        var first = original.DependencyReceipts[0];
        var second = original.DependencyReceipts[1];
        foreach (ArticleEmbedRelationDerivation mutation in new[]
        {
            original with { DependencyReceipts = [first] },
            original with { DependencyReceipts = [second, first] },
            original with { DependencyReceipts = [first, first] },
            original with { DependencyReceipts = [ArticleEmbedRelationContractValidator.Seal(first with { PlanDigest = DigestC }), second] },
            original with { DependencyReceipts = [ArticleEmbedRelationContractValidator.Seal(first with { Coordinate = second.Coordinate }), second] },
            original with { Accepted = false },
            original with { RejectedReasonCode = "failed" }
        })
        {
            Assert.False(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, mutation, out var dependencies).IsValid);
            Assert.Empty(dependencies);
        }
        Assert.False(ArticleEmbedFrozenDependencyProjection.Project(DigestC, plan, original, out var foreign).IsValid);
        Assert.Empty(foreign);
    }

    [Theory]
    [InlineData(ArticleEmbedVisibilityStatus.Private, ArticleEmbedPermissionStatus.Allowed)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedPermissionStatus.Denied)]
    [InlineData(ArticleEmbedVisibilityStatus.Unknown, ArticleEmbedPermissionStatus.Unknown)]
    public void FrozenProjectionRejectsResealedNonPublicRelationFacts(ArticleEmbedVisibilityStatus visibility, ArticleEmbedPermissionStatus permission)
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationDerivation original = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);
        ArticleEmbedRelationEdge changed = ArticleEmbedRelationContractValidator.Seal(original.EdgeSet!.Edges[0] with
        {
            Visibility = visibility,
            Permission = permission
        });
        ArticleEmbedRelationDerivation mutation = original with
        {
            EdgeSet = ArticleEmbedRelationContractValidator.Seal(original.EdgeSet with
            {
                Edges = [changed]
            })
        };
        Assert.False(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, mutation, out var dependencies).IsValid);
        Assert.Empty(dependencies);
    }

    [Fact]
    public void FrozenProjectionAcceptsEmptyQualifiedPlanAndRejectsBlockedAndAuthoringSources()
    {
        var authority = Authority();
        ArticleEmbedProviderRequest[] requests = [];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationDerivation derivation = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);
        Assert.True(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, derivation, out var empty).IsValid);
        Assert.Empty(empty);

        var nonPublic = Authority(PublicFacts(ArticleA, 4) with
        {
            Visibility = ArticleEmbedVisibilityStatus.Private
        });
        ArticleEmbedProviderRequest[] blockedRequests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan blocked = ArticleEmbedPublicationPlanner.Plan(blockedRequests, nonPublic, s_budgets);
        Assert.False(ArticleEmbedFrozenDependencyProjection.Project(blocked.PlanDigest, blocked, derivation, out var refused).IsValid);
        Assert.Empty(refused);

        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] authoringRequests = [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution = ResolveGraph(authoringRequests, snapshot, s_budgets);
        ArticleEmbedRelationDerivation authoring = ArticleEmbedRelationDeriver.DeriveFromAuthoring(authoringRequests, snapshot, s_budgets, resolution);
        Assert.False(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, authoring, out var current).IsValid);
        Assert.Empty(current);
    }

    [Fact]
    public void FrozenProjectionPreservesOneThousandDirectiveOccurrencesWithinCanonicalBudgets()
    {
        using var cancellation = new CancellationTokenSource();
        var authority = Authority(PublicFacts(ArticleA, 4));
        var budgets = new ArticleEmbedResolutionBudgetLimits(4, 1000, 1_048_576, 60_000, 4096);
        ArticleEmbedProviderRequest[] requests = Enumerable.Range(0, 1000)
            .Select(index => PublicationRequest($"request:{index}", ArticleA, ArticleEmbedTargetKind.Article, index * 100)
                with
            {
                AbortSignal = cancellation.Token
            })
            .ToArray();
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, budgets);
        ArticleEmbedRelationDerivation derivation = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, budgets, plan);

        Assert.Equal(ArticleEmbedPublicationPlanStatus.Sealed, plan.Status);
        Assert.True(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, plan, derivation, out var dependencies).IsValid);
        Assert.Equal(1000, dependencies.Length);
        Assert.Equal(1000, dependencies.Select(receipt => receipt.EdgeIdentity).Distinct().Count());
        Assert.All(dependencies, receipt => Assert.Equal(4, receipt.Coordinate.ResolvedRevision));
        Assert.Equal(derivation.DependencyReceipts, dependencies.ToArray());
    }

    [Fact]
    public void FrozenProjectionRejectsUnboundedAndMalformedInputBeforeDigestWork()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationDerivation derivation = ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan);
        foreach (ArticleEmbedPublicationPlan mutation in new[]
        {
            plan with { Edges = Enumerable.Repeat(plan.Edges[0], ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound + 1).ToArray() },
            plan with { Receipt = null! },
            plan with { Receipt = plan.Receipt with { Items = null! } }
        })
        {
            Assert.False(ArticleEmbedFrozenDependencyProjection.Project(plan.PlanDigest, mutation, derivation, out var dependencies).IsValid);
            Assert.Empty(dependencies);
        }
    }

    [Fact]
    public void RejectsUnverifiedTamperedOrBlockedSources()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] authoringRequests =
            [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution =
            ResolveGraph(authoringRequests, snapshot, s_budgets);
        ArticleEmbedAuthoringResolution tampered = resolution with
        {
            Receipt = resolution.Receipt with
            {
                ResolvedCount = 0
            }
        };
        Assert.Equal(
            "article_embed_relation_source_unverified",
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(authoringRequests, snapshot, s_budgets, tampered).RejectedReasonCode);
        Assert.Equal(
            "article_embed_relation_source_unverified",
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(authoringRequests, snapshot, s_budgets, null).RejectedReasonCode);

        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] planRequests =
            [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan sealedPlan =
            ArticleEmbedPublicationPlanner.Plan(planRequests, authority, s_budgets);
        Assert.Equal(
            "article_embed_relation_source_unverified",
            ArticleEmbedRelationDeriver.DeriveFromPlan(planRequests, authority, s_budgets, sealedPlan with
            {
                Receipt = sealedPlan.Receipt with
                {
                    FrozenEdgeCount = 0
                }
            }).RejectedReasonCode);

        var blockedAuthority = Authority(PublicFacts(ArticleA, 4) with
        {
            Lifecycle = ArticleEmbedLifecycleStatus.Draft
        });
        ArticleEmbedPublicationPlan blocked =
            ArticleEmbedPublicationPlanner.Plan(planRequests, blockedAuthority, s_budgets);
        Assert.Equal(
            "article_embed_relation_plan_blocked",
            ArticleEmbedRelationDeriver.DeriveFromPlan(planRequests, blockedAuthority, s_budgets, blocked).RejectedReasonCode);
        Assert.True(ArticleEmbedRelationVerifier.VerifyFromPlan(
            planRequests, blockedAuthority, s_budgets, blocked,
            ArticleEmbedRelationDeriver.DeriveFromPlan(planRequests, blockedAuthority, s_budgets, blocked)).Valid);
    }

    [Fact]
    public void ReconcileTransitionsCurrentEdgesPrecisely()
    {
        var before = Snapshot(AuthoringFacts(ArticleA, 4), AuthoringFacts(ArticleB, 6));
        ArticleEmbedProviderRequest[] requests =
        [
            AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0),
            AuthoringRequest("request:b", ArticleB, ArticleEmbedTargetKind.Article, 40)
        ];
        ArticleEmbedRelationEdgeSet set = ArticleEmbedRelationDeriver
            .DeriveFromAuthoring(requests, before, s_budgets,
                ResolveGraph(requests, before, s_budgets))
            .EdgeSet!;

        var after = Snapshot(
            AuthoringFacts(ArticleA, 4, latest: 9),
            AuthoringFacts(ArticleB, 6) with
            {
                Lifecycle = ArticleEmbedLifecycleStatus.Archived
            });
        ArticleEmbedRelationReconciliation reconciliation =
            ArticleEmbedRelationDeriver.Reconcile(set, after, previousGeneration: 0);

        Assert.True(reconciliation.Accepted);
        Assert.Equal(1, reconciliation.ReconcileGeneration);
        Assert.Equal(ArticleEmbedEdgeStatus.UpdateAvailable, reconciliation.EdgeSet!.Edges[0].Status);
        Assert.Equal(9, reconciliation.EdgeSet.Edges[0].LatestObservedRevision);
        Assert.Equal(ArticleEmbedEdgeStatus.Broken, reconciliation.EdgeSet.Edges[1].Status);
        Assert.Equal(2, reconciliation.Tickets.Count);
        Assert.Equal(ArticleEmbedInvalidationReason.TargetUpdated, reconciliation.Tickets[0].Reason);
        Assert.Equal(ArticleEmbedInvalidationReason.TargetNonPublic, reconciliation.Tickets[1].Reason);
        Assert.Equal(set.Edges[0].EdgeIdentity, reconciliation.Tickets[0].EdgeIdentity);
        Assert.True(ArticleEmbedRelationVerifier.VerifyReconciliation(
            set, after, 0, reconciliation).Valid);
    }

    [Fact]
    public void HostRevisionAndContextDriftStaleEveryCurrentEdge()
    {
        var before = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedRelationEdgeSet set = ArticleEmbedRelationDeriver
            .DeriveFromAuthoring(requests, before, s_budgets,
                ResolveGraph(requests, before, s_budgets))
            .EdgeSet!;

        var moved = SnapshotAt(9, null, AuthoringFacts(ArticleA, 4));
        ArticleEmbedRelationReconciliation hostDrift =
            ArticleEmbedRelationDeriver.Reconcile(set, moved, previousGeneration: 3);
        Assert.Equal(4, hostDrift.ReconcileGeneration);
        Assert.Equal(ArticleEmbedEdgeStatus.Stale, hostDrift.EdgeSet!.Edges[0].Status);
        Assert.Equal(ArticleEmbedInvalidationReason.HostRevisionChanged, hostDrift.Tickets[0].Reason);
        Assert.True(ArticleEmbedRelationVerifier.VerifyReconciliation(set, moved, 3, hostDrift).Valid);

        var otherActor = SnapshotAt(8, s_otherActor, AuthoringFacts(ArticleA, 4));
        // A different actor context makes the whole stored family stale for this caller.
        ArticleEmbedRelationReconciliation contextDrift =
            ArticleEmbedRelationDeriver.Reconcile(set, otherActor, previousGeneration: 4);
        Assert.Equal(ArticleEmbedEdgeStatus.Stale, contextDrift.EdgeSet!.Edges[0].Status);
        Assert.True(ArticleEmbedRelationVerifier.VerifyReconciliation(set, otherActor, 4, contextDrift).Valid);
    }

    [Fact]
    public void FrozenEdgesNeverReconcileAndLaterUpdatesNeverRewriteThem()
    {
        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        ArticleEmbedRelationEdgeSet frozen =
            ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan).EdgeSet!;

        var laterSnapshot = Snapshot(AuthoringFacts(ArticleA, 9, latest: 9));
        Assert.Equal(
            "article_embed_relation_scope_frozen_immutable",
            ArticleEmbedRelationDeriver.Reconcile(frozen, laterSnapshot, 0).RejectedReasonCode);

        var laterAuthority = Authority(PublicFacts(ArticleA, 9) with
        {
            LatestObservedRevision = 9
        });
        ArticleEmbedPublicationPlan laterPlan = ArticleEmbedPublicationPlanner.Plan(requests, laterAuthority, s_budgets);
        ArticleEmbedRelationEdgeSet laterFrozen =
            ArticleEmbedRelationDeriver.DeriveFromPlan(requests, laterAuthority, s_budgets, laterPlan).EdgeSet!;
        Assert.Equal(4, frozen.Edges[0].ResolvedRevision);
        Assert.Equal(9, laterFrozen.Edges[0].ResolvedRevision);
        Assert.Equal(frozen.Edges[0].EdgeIdentity, laterFrozen.Edges[0].EdgeIdentity);
        Assert.NotEqual(frozen.Edges[0].EdgeDigest, laterFrozen.Edges[0].EdgeDigest);
    }

    [Fact]
    public void QuerySeparatesScopesAndBindsTheDerivationContext()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] authoringRequests =
            [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedRelationEdgeSet authoringSet = ArticleEmbedRelationDeriver
            .DeriveFromAuthoring(authoringRequests, snapshot, s_budgets,
                ResolveGraph(authoringRequests, snapshot, s_budgets))
            .EdgeSet!;

        var authority = Authority(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] planRequests = [PublicationRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedRelationEdgeSet frozenSet = ArticleEmbedRelationDeriver
            .DeriveFromPlan(planRequests, authority, s_budgets,
                ArticleEmbedPublicationPlanner.Plan(planRequests, authority, s_budgets))
            .EdgeSet!;

        ArticleEmbedRelationQueryReceipt publicReceipt = ArticleEmbedRelationDeriver
            .Query(frozenSet, ArticleEmbedRelationQueryKind.PublicDelivery, s_actor, s_runtime)!;
        Assert.NotNull(publicReceipt);
        Assert.Equal(frozenSet.SetDigest, publicReceipt.SetDigest);
        Assert.Single(publicReceipt.Items);
        Assert.Equal(ArticleEmbedEdgeStatus.Frozen, publicReceipt.Items[0].Status);
        Assert.True(ArticleEmbedRelationVerifier.VerifyQuery(
            frozenSet, ArticleEmbedRelationQueryKind.PublicDelivery, s_actor, s_runtime, publicReceipt).Valid);

        Assert.Null(ArticleEmbedRelationDeriver.Query(
            authoringSet, ArticleEmbedRelationQueryKind.PublicDelivery, s_actor, s_runtime));
        Assert.Null(ArticleEmbedRelationDeriver.Query(
            frozenSet, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_actor, s_runtime));
        Assert.Null(ArticleEmbedRelationDeriver.Query(
            authoringSet, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_otherActor, s_runtime));
        Assert.NotNull(ArticleEmbedRelationDeriver.Query(
            authoringSet, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_actor, s_runtime));
    }

    [Fact]
    public void CacheKeysBindScopeRevisionActorRuntimeAndMaterial()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        var authoringKey = ArticleEmbedRelationDeriver.BuildCacheKey(snapshot, ArticleEmbedEdgeScope.Authoring);
        var frozenKey = ArticleEmbedRelationDeriver.BuildCacheKey(snapshot, ArticleEmbedEdgeScope.FrozenPublication);

        Assert.NotEqual(
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey),
            ArticleEmbedRelationDigest.ComputeCacheKey(frozenKey));
        Assert.NotEqual(
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey),
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey with
            {
                HostSourceRevision = 9
            }));
        Assert.NotEqual(
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey),
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey with
            {
                PermissionContextDigest = DigestD
            }));
        Assert.NotEqual(
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey),
            ArticleEmbedRelationDigest.ComputeCacheKey(authoringKey with
            {
                MaterialTheme = "dark"
            }));
        Assert.True(ArticleEmbedRelationContractValidator.Validate(authoringKey).IsValid);
    }

    [Fact]
    public void VerifierRejectsEdgeSetTicketReceiptAndQueryTamper()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution =
            ResolveGraph(requests, snapshot, s_budgets);
        ArticleEmbedRelationDerivation derivation =
            ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, s_budgets, resolution);
        ArticleEmbedRelationEdgeSet set = derivation.EdgeSet!;

        Assert.False(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests, snapshot, s_budgets, resolution, null).Valid);
        Assert.False(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests, snapshot, s_budgets, resolution, derivation with
            {
                EdgeSet = set with
                {
                    Edges = []
                }
            }).Valid);
        Assert.False(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests, snapshot, s_budgets, resolution, derivation with
            {
                EdgeSet = set with
                {
                    Edges = [ArticleEmbedRelationContractValidator.Seal(set.Edges[0] with
                    {
                        Status = ArticleEmbedEdgeStatus.UpdateAvailable
                    })]
                }
            }).Valid);
        Assert.False(ArticleEmbedRelationVerifier.VerifyFromAuthoring(
            requests,
            Snapshot(AuthoringFacts(ArticleA, 5)),
            s_budgets,
            resolution,
            derivation).Valid);

        var after = Snapshot(AuthoringFacts(ArticleA, 4, latest: 7));
        ArticleEmbedRelationReconciliation reconciliation =
            ArticleEmbedRelationDeriver.Reconcile(set, after, 2);
        Assert.False(ArticleEmbedRelationVerifier.VerifyReconciliation(set, after, 2, reconciliation with
        {
            Tickets = []
        }).Valid);
        Assert.False(ArticleEmbedRelationVerifier.VerifyReconciliation(set, after, 5, reconciliation).Valid);

        ArticleEmbedRelationQueryReceipt receipt = ArticleEmbedRelationDeriver
            .Query(set, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_actor, s_runtime)!;
        Assert.False(ArticleEmbedRelationVerifier.VerifyQuery(
            set, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_actor, s_runtime, receipt with
            {
                EdgeCount = 0
            }).Valid);
        Assert.False(ArticleEmbedRelationVerifier.VerifyQuery(
            set, ArticleEmbedRelationQueryKind.AuthoringCurrent, s_otherActor, s_runtime, receipt).Valid);
    }

    [Fact]
    public void RejectsMalformedEdgeSetsAndFrozenStatusMixups()
    {
        var snapshot = Snapshot(AuthoringFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [AuthoringRequest("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedRelationEdgeSet set = ArticleEmbedRelationDeriver
            .DeriveFromAuthoring(requests, snapshot, s_budgets,
                ResolveGraph(requests, snapshot, s_budgets))
            .EdgeSet!;

        Assert.Equal(
            "article_embed_relation_edge_scope_status_mismatch",
            ArticleEmbedRelationContractValidator.Validate(set.Edges[0] with
            {
                Status = ArticleEmbedEdgeStatus.Frozen
            }).ReasonCode);
        Assert.Equal(
            "article_embed_relation_edge_identity_mismatch",
            ArticleEmbedRelationContractValidator.Validate(set.Edges[0] with
            {
                EdgeIdentity = DigestD
            }).ReasonCode);
        Assert.Equal(
            "article_embed_relation_edge_duplicate_or_scope_mismatch",
            ArticleEmbedRelationContractValidator.Validate(set with
            {
                Edges = [set.Edges[0], set.Edges[0]]
            }).ReasonCode);
        Assert.Equal(
            "article_embed_relation_edge_set_digest_mismatch",
            ArticleEmbedRelationContractValidator.Validate(set with
            {
                HostSourceRevision = 9
            }).ReasonCode);
    }

    private static ArticleEmbedProviderRequest AuthoringRequest(
        string requestId,
        string token,
        ArticleEmbedTargetKind mode,
        int start,
        long sourceRevision = 8)
        => Request(requestId, token, mode, start, ArticleEmbedRequestedScope.Authoring, sourceRevision);

    private static ArticleEmbedProviderRequest PublicationRequest(
        string requestId,
        string token,
        ArticleEmbedTargetKind mode,
        int start,
        long sourceRevision = 8)
        => Request(requestId, token, mode, start, ArticleEmbedRequestedScope.PublicationPlan, sourceRevision);

    private static ArticleEmbedAuthoringResolution ResolveGraph(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests, ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets, TimeProvider? time = null)
    {
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets, time);
        return ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection, time);
    }

    private static ArticleEmbedProviderRequest Request(
        string requestId,
        string token,
        ArticleEmbedTargetKind mode,
        int start,
        ArticleEmbedRequestedScope scope,
        long sourceRevision)
    {
        ArticleEmbedTargetCodec.TryDecode(token, mode, out ArticleEmbedTargetIdentity? target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest,
            ArticleEmbedSchemas.Version,
            requestId,
            Host,
            s_document,
            sourceRevision,
            new ArticleEmbedDirectiveProjection(
                ArticleEmbedSchemas.ParserContract,
                token,
                mode,
                new ArticleEmbedSourceRange(start, start + 32)),
            target!,
            scope,
            s_actor,
            s_runtime,
            DigestC,
            string.Empty,
            s_signal));
    }

    private static ArticleEmbedDirectiveProjection Nested(string token, ArticleEmbedTargetKind mode, int start)
        => new(ArticleEmbedSchemas.ParserContract, token, mode, new ArticleEmbedSourceRange(start, start + 32));

    private static ArticleEmbedSafeProjectionReference Projection(string identity)
        => new(ArticleEmbedProjectionKind.SafeProjection, identity, DigestD);

    private static ArticleEmbedTargetFacts AuthoringFacts(
        string portableIdentity,
        long resolvedRevision,
        ArticleEmbedDirectiveProjection[]? nested = null,
        long? latest = null)
        => new(
            portableIdentity,
            s_actor.SiteIdentity,
            1,
            resolvedRevision,
            resolvedRevision,
            latest ?? resolvedRevision,
            ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published,
            ArticleEmbedPermissionStatus.Allowed,
            DigestB,
            $"version:{resolvedRevision}",
            128,
            "Target display",
            Projection("projection:article-body"),
            [],
            [],
            nested ?? []);

    private static ArticleEmbedAuthoritySnapshot Snapshot(params ArticleEmbedTargetFacts[] targets)
        => SnapshotAt(8, null, targets);

    private static ArticleEmbedAuthoritySnapshot SnapshotAt(
        long hostRevision,
        ArticleEmbedActorContext? actor,
        params ArticleEmbedTargetFacts[] targets)
        => ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot,
            ArticleEmbedAuthoringSchemas.Version,
            Host,
            s_document,
            hostRevision,
            DigestC,
            1,
            actor ?? s_actor,
            s_runtime,
            "zh-CN",
            "light",
            targets,
            string.Empty));

    private static ArticleEmbedPublicationTargetFacts PublicFacts(
        string portableIdentity,
        long resolvedRevision,
        ArticleEmbedDirectiveProjection[]? nested = null)
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
            128,
            "Target display",
            Projection("projection:article-body"),
            [],
            [],
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
}
