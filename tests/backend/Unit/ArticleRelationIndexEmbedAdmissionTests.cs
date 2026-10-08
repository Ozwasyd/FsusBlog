using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleRelationIndexEmbedAdmissionTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string Target = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string NestedTarget = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    private static readonly ArticleEmbedActorContext s_actor = new("actor:embed", "site:primary", DigestA);
    private static readonly ArticleRelationActorContext s_indexActor = new(s_actor.ActorIdentity, s_actor.SiteIdentity, s_actor.PermissionContextDigest);
    private static readonly ArticleEmbedRuntimeContext s_runtime = new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB);
    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host", 3);
    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);
    private static readonly ArticleEmbedSafeProjectionReference s_projection = new(ArticleEmbedProjectionKind.SafeProjection, "projection:body", DigestC);
    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Article, "")]
    [InlineData(ArticleEmbedTargetKind.Heading, "#heading:01991e72-c397-75a2-b61a-da6d7dbd8092")]
    [InlineData(ArticleEmbedTargetKind.Block, "#case-id-1")]
    public async Task ActualPipeline_BindsExactCoordinateInSameIndexWithoutLinkConversion(ArticleEmbedTargetKind kind, string suffix)
    {
        var input = Authoring(kind, suffix);
        ArticleRelationIndexEmbedAdmission admission = Admit(input);
        var source = new Source(Family(admission));
        var index = new ArticleRelationIndex(source, s_indexActor);
        ArticleRelationIndexSnapshot snapshot = await index.RebuildAsync(0);
        Assert.Empty(snapshot.Targets);
        Assert.Equal(1, admission.SchemaVersion);
        Assert.Equal(ArticleRelationIndexDependencyKind.Embed, admission.DependencyKind);
        Assert.Equal(input.Pipeline.Projection.Receipt.ReceiptDigest, admission.ProjectionReceiptDigest);
        Assert.Equal(input.Pipeline.Graph.Receipt.ReceiptDigest, admission.EdgeSet.SourceArtifactDigest);
        Assert.Equal(input.Pipeline.Relations.EdgeSet!.SetDigest, admission.EdgeSet.SetDigest);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.Authoring, 1);
        ArticleRelationIndexEmbedEntry entry = Assert.Single(inspection.Entries);
        Assert.Equal(4, entry.Edge.ResolvedRevision);
        Assert.Equal(input.Requests[0].Target, entry.Coordinate.Target);
        Assert.Equal(entry.Edge.DependencyDigest, entry.Coordinate.DependencyDigest);
        Assert.Equal(DigestC, entry.Coordinate.ProjectionDigest);
        Assert.Null(entry.PublicationReceipt);
        Assert.Empty(index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.FrozenPublication, 1).Entries);
        await index.RevalidateSourceAsync(inspection);
        Assert.Equal([Host], source.ArticleReads);
    }

    [Fact]
    public async Task NestedEdge_RereadsOriginalHostFamilyAndRetainsNestedOwner()
    {
        var input = Authoring(nested: true);
        ArticleRelationIndexEmbedAdmission admission = Admit(input);
        Assert.Single(input.Pipeline.Projection.Results);
        Assert.Empty(input.Pipeline.Projection.Results[0].Children);
        Assert.Single(input.Pipeline.Graph.Results[0].Children);
        var source = new Source(Family(admission));
        var index = new ArticleRelationIndex(source, s_indexActor);
        await index.RebuildAsync(0);
        var target = new ArticleEmbedTargetIdentity(NestedTarget, ArticleEmbedTargetKind.Article, null, null);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(target, ArticleEmbedEdgeScope.Authoring, 1);
        ArticleRelationIndexEmbedEntry entry = Assert.Single(inspection.Entries);
        Assert.Equal(Target, entry.Edge.OwnerPortableArticleIdentity);
        Assert.Equal(Host, entry.HostArticleIdentity);
        Assert.Equal(6, entry.Edge.ResolvedRevision);
        await index.RevalidateSourceAsync(inspection);
        Assert.Equal([Host], source.ArticleReads);
    }

    [Fact]
    public async Task ActualBlockSourceIntegration_PreservesEmbedCarrierThroughSameIndex()
    {
        var input = Authoring();
        ArticleRelationIndexEmbedAdmission admission = Admit(input);
        var source = new Source(Family(admission));
        var index = new ArticleRelationIndex(new ArticleBlockRelationIndexSource(source), s_indexActor);
        await index.RebuildAsync(0);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.Authoring, 1);
        Assert.Same(admission, Assert.Single(inspection.Entries).Admission);
        await index.RevalidateSourceAsync(inspection);
    }

    [Fact]
    public async Task LinkAndEmbed_ShareCommitAndBudgetButRemainDistinctQueryFamilies()
    {
        var input = Authoring(ArticleEmbedTargetKind.Block, "#case-id-1");
        ArticleRelationIndexArticle family = Family(Admit(input)) with
        {
            Sets = [LinkSet(1)]
        };
        var index = new ArticleRelationIndex(new Source(family), s_indexActor);
        ArticleRelationIndexSnapshot snapshot = await index.RebuildAsync(0);
        var target = new ArticleRelationTargetIdentity(Target, ArticleRelationTargetKind.Block, null, "case-id-1");
        ArticleRelationIndexInspection links = index.InspectTarget(target, 1);
        Assert.Single(links.Records);
        Assert.Equal(ArticleRelationKind.Outgoing, links.Records[0].Kind);
        ArticleRelationIndexEmbedInspection embeds = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.Authoring, 1);
        Assert.Equal(ArticleRelationIndexDependencyKind.Embed, embeds.DependencyKind);
        Assert.Single(embeds.Entries);
        Assert.Single(snapshot.Targets);
        Assert.Single(snapshot.EmbedTargets);
        await index.RevalidateSourceAsync(links);
        await index.RevalidateSourceAsync(embeds);
    }

    [Fact]
    public async Task LinkAndEmbed_UseOneCombinedStorageBudgetBeforeCommit()
    {
        var input = Authoring();
        ArticleRelationIndexArticle family = Family(Admit(input)) with
        {
            Sets = [LinkSet(ArticleRelationIndex.MaxRelations)]
        };
        var index = new ArticleRelationIndex(new Source(family), s_indexActor);
        ArticleRelationIndexException exception = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RebuildAsync(0));
        Assert.Equal("article_relation_index_storage_budget_exceeded", exception.ReasonCode);
        Assert.Equal("article_relation_index_rebuild_required", Assert.Throws<ArticleRelationIndexException>(() => index.ReadSnapshot(0)).ReasonCode);
    }

    [Fact]
    public async Task UnchangedHost_RetainsOriginalArtifactGenerationWhileRevalidationObservesCurrentCorpus()
    {
        var input = Authoring();
        ArticleRelationIndexEmbedAdmission admission = Admit(input);
        var source = new Source(Family(admission));
        var index = new ArticleRelationIndex(source, s_indexActor);
        await index.RebuildAsync(0);
        source.Generation = 2;
        await index.RebuildAsync(1);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.Authoring, 2);
        Assert.Equal(2, inspection.SourceGeneration);
        Assert.Equal(1, Assert.Single(inspection.Entries).Admission.SourceGeneration);
        await index.RevalidateSourceAsync(inspection);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Admission_OwnsVerifiedCollectionsBeforeCallerCanMutateThem(bool publication)
    {
        ArticleRelationIndexEmbedAdmission admission;
        List<ArticleEmbedRelationEdge> edges;
        List<ArticleEmbedDependencyReceipt> receipts;
        if (publication)
        {
            var input = PublicationInput();
            edges = input.Relations.EdgeSet!.Edges.ToList();
            receipts = input.Relations.DependencyReceipts.ToList();
            ArticleEmbedRelationDerivation derivation = input.Relations with
            {
                EdgeSet = input.Relations.EdgeSet with
                {
                    Edges = edges
                },
                DependencyReceipts = receipts
            };
            admission = ArticleRelationIndexEmbedAdmission.FromPublication(1, 1,
                input.Requests, input.Authority, s_budgets, input.Plan, derivation);
        }
        else
        {
            var input = Authoring();
            edges = input.Pipeline.Relations.EdgeSet!.Edges.ToList();
            receipts = input.Pipeline.Relations.DependencyReceipts.ToList();
            ArticleEmbedRelationDerivation derivation = input.Pipeline.Relations with
            {
                EdgeSet = input.Pipeline.Relations.EdgeSet with
                {
                    Edges = edges
                },
                DependencyReceipts = receipts
            };
            admission = ArticleRelationIndexEmbedAdmission.FromAuthoring(1, 1, input.Requests, input.Snapshot,
                s_budgets, input.Pipeline.Projection, input.Pipeline.Graph, derivation);
        }
        string digest = admission.EdgeSet.SetDigest;
        edges.Clear();
        receipts.Clear();
        var index = new ArticleRelationIndex(new Source(Family(admission)), s_indexActor);
        await index.RebuildAsync(0);
        Assert.Single(admission.EdgeSet.Edges);
        Assert.Equal(digest, admission.EdgeSet.SetDigest);
        Assert.Equal(publication ? 1 : 0, admission.DependencyReceipts.Length);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(admission.EdgeSet.Edges[0].Target,
            admission.EdgeSet.Scope, 1);
        Assert.Single(inspection.Entries);
        await index.RevalidateSourceAsync(inspection);
    }

    [Fact]
    public void Admission_RefusesOversizedCandidateBeforeOriginalVerifier()
    {
        var input = Authoring();
        ArticleEmbedRelationDerivation derivation = input.Pipeline.Relations with
        {
            EdgeSet = input.Pipeline.Relations.EdgeSet! with
            {
                Edges = Enumerable.Repeat(input.Pipeline.Relations.EdgeSet!.Edges[0],
                    ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound + 1).ToArray()
            }
        };
        ArticleRelationIndexException exception = Assert.Throws<ArticleRelationIndexException>(() =>
            ArticleRelationIndexEmbedAdmission.FromAuthoring(1, 1, input.Requests, input.Snapshot, s_budgets,
                input.Pipeline.Projection, input.Pipeline.Graph, derivation));
        Assert.Equal("article_relation_index_embed_edge_budget_exceeded", exception.ReasonCode);
    }

    [Theory]
    [InlineData("projection")]
    [InlineData("graph")]
    [InlineData("derivation")]
    [InlineData("actor")]
    [InlineData("runtime")]
    [InlineData("source-revision")]
    [InlineData("authority-generation")]
    [InlineData("generation-zero")]
    [InlineData("sequence-zero")]
    public void Authoring_RejectsUnverifiedOrMisboundPipelineArtifacts(string fault)
    {
        var input = Authoring();
        var projection = input.Pipeline.Projection;
        var graph = input.Pipeline.Graph;
        var relations = input.Pipeline.Relations;
        var snapshot = input.Snapshot;
        if (fault == "projection")
        {
            projection = projection with
            {
                ResolutionDigest = DigestB
            };
        }
        if (fault == "graph")
        {
            graph = graph with
            {
                ResolutionDigest = DigestB
            };
        }
        if (fault == "derivation")
        {
            relations = relations with
            {
                EdgeSet = relations.EdgeSet! with
                {
                    SourceArtifactDigest = DigestB
                }
            };
        }
        if (fault is "actor" or "runtime" or "source-revision" or "authority-generation")
        {
            snapshot = ArticleEmbedAuthoringContractValidator.Seal(snapshot with
            {
                Actor = fault == "actor" ? s_actor with
                {
                    PermissionContextDigest = DigestB
                } : snapshot.Actor,
                Runtime = fault == "runtime" ? s_runtime with
                {
                    ProviderVersion = 2
                } : snapshot.Runtime,
                HostSourceRevision = fault == "source-revision" ? 9 : snapshot.HostSourceRevision,
                AuthorityGeneration = fault == "authority-generation" ? 2 : snapshot.AuthorityGeneration
            });
        }
        Assert.Throws<ArticleRelationIndexException>(() => ArticleRelationIndexEmbedAdmission.FromAuthoring(
            fault == "sequence-zero" ? 0 : 1, fault == "generation-zero" ? 0 : 1,
            input.Requests, snapshot, s_budgets, projection, graph, relations));
    }

    [Theory]
    [InlineData("host")]
    [InlineData("sequence")]
    [InlineData("generation")]
    [InlineData("actor")]
    [InlineData("duplicate")]
    [InlineData("default")]
    public async Task Index_RefusesBridgeBindingBeforeAtomicCommit(string fault)
    {
        ArticleRelationIndexEmbedAdmission admission = Admit(Authoring(), fault == "sequence" ? 2 : 1, fault == "generation" ? 2 : 1);
        ArticleRelationIndexArticle family = Family(admission);
        if (fault == "host")
        {
            family = family with
            {
                ArticleIdentity = Target
            };
        }
        if (fault == "duplicate")
        {
            family = family with
            {
                Embeds = [admission, admission]
            };
        }
        if (fault == "default")
        {
            family = family with
            {
                Embeds = default
            };
        }
        var source = new Source(family);
        var actor = fault == "actor" ? s_indexActor with
        {
            PermissionContextDigest = DigestB
        } : s_indexActor;
        source.Actor = actor;
        var index = new ArticleRelationIndex(source, actor);
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RebuildAsync(0));
        Assert.Equal("article_relation_index_rebuild_required", Assert.Throws<ArticleRelationIndexException>(() => index.ReadSnapshot(0)).ReasonCode);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FrozenPublication_RetainsReceiptsAcrossCurrentReplacementAndRebuild(bool rebuild)
    {
        ArticleRelationIndexEmbedAdmission frozen = Publication();
        ArticleRelationIndexEmbedAdmission current = Admit(Authoring());
        var source = new Source(Family(current, frozen));
        var index = new ArticleRelationIndex(source, s_indexActor);
        ArticleRelationIndexSnapshot before = await index.RebuildAsync(0);
        source.Generation = 2;
        source.Article = Family(Admit(Authoring(revision: 9), 2, 2), frozen) with
        {
            SourceSequence = 2
        };
        ArticleRelationIndexSnapshot after = rebuild ? await index.RebuildAsync(1) : await index.ApplyAsync(Host, 1);
        Assert.Equal(2, after.IndexGeneration);
        var target = frozen.EdgeSet.Edges[0].Target;
        ArticleRelationIndexEmbedEntry entry = Assert.Single(index.InspectEmbedTarget(target, ArticleEmbedEdgeScope.FrozenPublication, 2).Entries);
        Assert.Equal(ArticleEmbedEdgeStatus.Frozen, entry.Edge.Status);
        Assert.Same(frozen, entry.Admission);
        Assert.Equal(1, entry.Admission.SourceGeneration);
        Assert.Equal(1, entry.Admission.HostSourceSequence);
        Assert.Equal(frozen.DependencyReceipts[0], entry.PublicationReceipt);
        Assert.Equal(frozen.EdgeSet.SourceArtifactDigest, entry.PublicationReceipt!.PlanDigest);
        Assert.Equal(entry.Coordinate, entry.PublicationReceipt.Coordinate);
        Assert.Equal(before.Articles[Host].Embeds[1].EdgeSet.SetDigest, entry.Admission.EdgeSet.SetDigest);
        await index.RevalidateSourceAsync(index.InspectEmbedTarget(target, ArticleEmbedEdgeScope.FrozenPublication, 2));
    }

    [Theory]
    [InlineData("remove")]
    [InlineData("dependency")]
    [InlineData("creation-generation")]
    public async Task FrozenPublication_CannotBeRemovedOrReboundByRebuild(string fault)
    {
        ArticleRelationIndexEmbedAdmission frozen = Publication();
        var source = new Source(Family(frozen));
        var index = new ArticleRelationIndex(source, s_indexActor);
        ArticleRelationIndexSnapshot before = await index.RebuildAsync(0);
        source.Generation = 2;
        source.Article = Family(fault == "remove" ? [] : [Publication(
            targetRevision: fault == "dependency" ? 5 : 4,
            generation: fault == "creation-generation" ? 2 : 1)]) with
        {
            SourceSequence = 2
        };
        ArticleRelationIndexException exception = await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RebuildAsync(1));
        Assert.Equal("article_relation_index_embed_history_immutable", exception.ReasonCode);
        Assert.Same(before, index.ReadSnapshot(1));
    }

    [Theory]
    [InlineData("blocked")]
    [InlineData("receipt")]
    [InlineData("coordinate")]
    [InlineData("plan")]
    public void Publication_RejectsBlockedOrTamperedOriginalArtifacts(string fault)
    {
        var input = PublicationInput(permission: fault == "blocked" ? ArticleEmbedPermissionStatus.Denied : ArticleEmbedPermissionStatus.Allowed);
        ArticleEmbedPublicationPlan plan = input.Plan;
        ArticleEmbedRelationDerivation relations = input.Relations;
        if (fault == "plan")
        {
            plan = plan with
            {
                PlanDigest = DigestB
            };
        }
        if (fault is "receipt" or "coordinate")
        {
            ArticleEmbedDependencyReceipt receipt = relations.DependencyReceipts[0];
            receipt = ArticleEmbedRelationContractValidator.Seal(receipt with
            {
                PlanDigest = fault == "receipt" ? DigestB : receipt.PlanDigest,
                Coordinate = fault == "coordinate" ? ArticleEmbedContractValidator.Seal(receipt.Coordinate with
                {
                    ProjectionDigest = DigestA
                }) : receipt.Coordinate
            });
            relations = relations with
            {
                DependencyReceipts = [receipt]
            };
        }
        Assert.Throws<ArticleRelationIndexException>(() => ArticleRelationIndexEmbedAdmission.FromPublication(
            1, 1, input.Requests, input.Authority, s_budgets, plan, relations));
    }

    [Theory]
    [InlineData("entries")]
    [InlineData("actor")]
    [InlineData("scope")]
    [InlineData("generation")]
    [InlineData("source-drift")]
    public async Task Inspection_RefusesTamperAndSourceDrift(string fault)
    {
        var input = Authoring();
        var source = new Source(Family(Admit(input)));
        var index = new ArticleRelationIndex(source, s_indexActor);
        await index.RebuildAsync(0);
        ArticleRelationIndexEmbedInspection inspection = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.Authoring, 1);
        inspection = inspection with
        {
            Entries = fault == "entries" ? [] : inspection.Entries,
            Actor = fault == "actor" ? s_indexActor with
            {
                PermissionContextDigest = DigestB
            } : inspection.Actor,
            Scope = fault == "scope" ? ArticleEmbedEdgeScope.FrozenPublication : inspection.Scope,
            SourceGeneration = fault == "generation" ? 2 : inspection.SourceGeneration
        };
        if (fault == "source-drift")
        {
            source.Article = Family(Admit(Authoring(revision: 9)));
        }
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RevalidateSourceAsync(inspection));
    }

    [Fact]
    public async Task EmptyInspection_StillRechecksGlobalSourceGeneration()
    {
        var input = Authoring();
        var source = new Source(Family(Admit(input)));
        var index = new ArticleRelationIndex(source, s_indexActor);
        await index.RebuildAsync(0);
        ArticleRelationIndexEmbedInspection empty = index.InspectEmbedTarget(input.Requests[0].Target, ArticleEmbedEdgeScope.FrozenPublication, 1);
        source.Generation = 2;
        await Assert.ThrowsAsync<ArticleRelationIndexException>(() => index.RevalidateSourceAsync(empty));
    }

    [Fact]
    public async Task ConcurrentEmbedApply_UsesExistingIndexCompareAndSwap()
    {
        var source = new Source(Family(Admit(Authoring())));
        var index = new ArticleRelationIndex(source, s_indexActor);
        await index.RebuildAsync(0);
        source.Generation = 2;
        source.Article = Family(Admit(Authoring(revision: 9), 2, 2)) with
        {
            SourceSequence = 2
        };
        var arrivals = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int count = 0;
        source.BeforeReadArticle = async () =>
        {
            if (Interlocked.Increment(ref count) == 2)
            {
                arrivals.SetResult();
            }
            await arrivals.Task;
        };
        Task<ArticleRelationIndexSnapshot>[] attempts = [index.ApplyAsync(Host, 1), index.ApplyAsync(Host, 1)];
        foreach (Task<ArticleRelationIndexSnapshot> attempt in attempts)
        {
            try
            {
                await attempt;
            }
            catch (ArticleRelationIndexException exception)
            {
                Assert.Equal("article_relation_index_generation_stale", exception.ReasonCode);
            }
        }
        Assert.Equal(1, attempts.Count(static attempt => attempt.IsCompletedSuccessfully));
        Assert.Equal(1, attempts.Count(static attempt => attempt.IsFaulted));
        Assert.Equal(2, index.ReadSnapshot(2).SourceGeneration);
    }

    [Fact]
    public async Task Cancellation_RefusesBridgeAndQueryWithoutCommit()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var input = Authoring();
        Assert.Throws<OperationCanceledException>(() => ArticleRelationIndexEmbedAdmission.FromAuthoring(
            1, 1, input.Requests, input.Snapshot, s_budgets, input.Pipeline.Projection, input.Pipeline.Graph,
            input.Pipeline.Relations, cancellation.Token));
        var index = new ArticleRelationIndex(new Source(Family(Admit(input))), s_indexActor);
        await index.RebuildAsync(0);
        Assert.Throws<OperationCanceledException>(() => index.InspectEmbedTarget(input.Requests[0].Target,
            ArticleEmbedEdgeScope.Authoring, 1, cancellation.Token));
        Assert.Throws<ArticleRelationIndexException>(() => index.InspectEmbedTarget(input.Requests[0].Target,
            (ArticleEmbedEdgeScope)255, 1));
    }

    private static ArticleRelationIndexArticle Family(params ArticleRelationIndexEmbedAdmission[] embeds)
        => new(Host, 1, [])
        {
            Embeds = embeds.ToImmutableArray()
        };

    private static ArticleRelationSet LinkSet(int count)
    {
        var source = new ArticleRelationSourceFacts(Host, "revision:30000000-0000-4000-8000-000000000001", 8,
            ArticleRelationRevisionKind.Current, ArticleRelationLifecycleState.Published,
            ArticleRelationPermissionState.Allowed, s_indexActor, DigestC);
        var target = new ArticleRelationTargetFacts(new(Target, ArticleRelationTargetKind.Block, null, "case-id-1"),
            "revision:30000000-0000-4000-8000-000000000002", 4, ArticleRelationRevisionKind.Published,
            ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed);
        ArticleRelationRecord[] records = Enumerable.Range(0, count).Select(offset =>
        {
            var range = new ArticleRelationSourceRange(offset * 6, offset * 6 + 6, "[link]");
            return ArticleRelationContractValidator.Seal(new ArticleRelationRecord(ArticleRelationSchemas.Relation, 1,
                string.Empty, 1, ArticleRelationKind.Outgoing, source, new("[link]", range, range, 1), target,
                new(s_indexActor, s_indexActor, ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, DigestA),
                ArticleRelationResolutionStatus.Resolved, new(1, 1, 1, 1, 1), string.Empty));
        }).ToArray();
        return ArticleRelationContractValidator.Seal(new ArticleRelationSet(ArticleRelationSchemas.RelationSet, 1,
            source, records, string.Empty));
    }

    private static ArticleRelationIndexEmbedAdmission Admit(AuthoringInput input, long sequence = 1, long generation = 1)
        => ArticleRelationIndexEmbedAdmission.FromAuthoring(sequence, generation, input.Requests, input.Snapshot,
            s_budgets, input.Pipeline.Projection, input.Pipeline.Graph, input.Pipeline.Relations);

    private static AuthoringInput Authoring(ArticleEmbedTargetKind kind = ArticleEmbedTargetKind.Article,
        string suffix = "", bool nested = false, long revision = 8)
    {
        ArticleEmbedProviderRequest[] requests = [Request(ArticleEmbedRequestedScope.Authoring, kind, suffix, revision)];
        ArticleEmbedDirectiveProjection[] children = nested
            ? [new(ArticleEmbedSchemas.ParserContract, NestedTarget, ArticleEmbedTargetKind.Article, new(10, 42))] : [];
        ArticleEmbedTargetFacts[] targets = [Facts(Target, 4, children), Facts(NestedTarget, 6, [])];
        var snapshot = ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot, ArticleEmbedAuthoringSchemas.Version, Host, s_document,
            revision, DigestC, 1, s_actor, s_runtime, "zh-CN", "light", targets, string.Empty));
        return new(requests, snapshot, ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, s_budgets));
    }

    private static ArticleEmbedTargetFacts Facts(string identity, long revision, ArticleEmbedDirectiveProjection[] children)
        => new(identity, s_actor.SiteIdentity, 1, revision, revision, revision, ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published, ArticleEmbedPermissionStatus.Allowed, DigestB, $"version:{revision}", 128,
            "Target display", s_projection, [new("heading:01991e72-c397-75a2-b61a-da6d7dbd8092", s_projection)], [new("case-id-1", s_projection)], children);

    private static ArticleEmbedProviderRequest Request(ArticleEmbedRequestedScope scope,
        ArticleEmbedTargetKind kind, string suffix, long revision)
    {
        string token = Target + suffix;
        Assert.True(ArticleEmbedTargetCodec.TryDecode(token, kind, out ArticleEmbedTargetIdentity? target).IsValid);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest, ArticleEmbedSchemas.Version, "request:host", Host, s_document, revision,
            new(ArticleEmbedSchemas.ParserContract, token, kind, new(0, 32)), target!, scope, s_actor, s_runtime,
            DigestC, string.Empty, s_signal));
    }

    private static ArticleRelationIndexEmbedAdmission Publication(long targetRevision = 4, long generation = 1)
    {
        var input = PublicationInput(targetRevision);
        return ArticleRelationIndexEmbedAdmission.FromPublication(1, generation, input.Requests, input.Authority,
            s_budgets, input.Plan, input.Relations);
    }

    private static PublicationFixture PublicationInput(long revision = 4,
        ArticleEmbedPermissionStatus permission = ArticleEmbedPermissionStatus.Allowed)
    {
        ArticleEmbedProviderRequest[] requests = [Request(ArticleEmbedRequestedScope.PublicationPlan, ArticleEmbedTargetKind.Block, "#case-id-1", 8)];
        var facts = new ArticleEmbedPublicationTargetFacts(Target, s_actor.SiteIdentity, 1, revision, revision,
            ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Published, permission, true, DigestB,
            $"version:{revision}", DigestA, 128, "Target display", s_projection, [], [new("case-id-1", s_projection)], []);
        var authority = ArticleEmbedPublicationContractValidator.Seal(new ArticleEmbedPublicationAuthority(
            ArticleEmbedPublicationSchemas.Authority, ArticleEmbedPublicationSchemas.Version, Host, s_document, 8,
            DigestC, "publication:request", 9, 1, s_actor, s_runtime, "zh-CN", "light", true, [facts], string.Empty));
        ArticleEmbedPublicationPlan plan = ArticleEmbedPublicationPlanner.Plan(requests, authority, s_budgets);
        return new(requests, authority, plan, ArticleEmbedRelationDeriver.DeriveFromPlan(requests, authority, s_budgets, plan));
    }

    private sealed record AuthoringInput(
        ArticleEmbedProviderRequest[] Requests,
        ArticleEmbedAuthoritySnapshot Snapshot,
        (ArticleEmbedAuthoringResolution Projection, ArticleEmbedAuthoringResolution Graph, ArticleEmbedRelationDerivation Relations) Pipeline);

    private sealed record PublicationFixture(ArticleEmbedProviderRequest[] Requests, ArticleEmbedPublicationAuthority Authority,
        ArticleEmbedPublicationPlan Plan, ArticleEmbedRelationDerivation Relations);

    private sealed class Source(ArticleRelationIndexArticle article) : IArticleRelationIndexSource, IArticleBlockRelationParsedSource
    {
        public ArticleRelationIndexArticle Article { get; set; } = article;
        public ArticleRelationActorContext Actor { get; set; } = s_indexActor;
        public long Generation { get; set; } = 1;
        public List<string> ArticleReads { get; } = [];
        public Func<Task>? BeforeReadArticle
        {
            get; set;
        }

        public Task<ArticleRelationIndexSourcePage> ReadAsync(ArticleRelationActorContext actor, string? afterArticleIdentity,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new ArticleRelationIndexSourcePage(Actor, Generation,
                afterArticleIdentity is null ? [Article] : [], false));
        }

        public async Task<ArticleRelationIndexArticleRead> ReadArticleAsync(ArticleRelationActorContext actor, string articleIdentity,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleReads.Add(articleIdentity);
            if (BeforeReadArticle is not null)
            {
                await BeforeReadArticle();
            }
            return new(Actor, Generation, Article);
        }

        async Task<ArticleBlockRelationParsedPage> IArticleBlockRelationParsedSource.ReadAsync(
            ArticleRelationActorContext actor, string? afterArticleIdentity, int pageSize,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            ArticleRelationIndexSourcePage page = await ReadAsync(actor, afterArticleIdentity, pageSize, expectedSourceGeneration, cancellationToken);
            return new(page.Actor, page.SourceGeneration, page.Articles.Select(static family =>
                new ArticleBlockRelationParsedArticle(family.ArticleIdentity, family.SourceSequence, [])
                {
                    Embeds = family.Embeds
                }).ToImmutableArray(), page.HasMore);
        }

        async Task<ArticleBlockRelationParsedArticleRead> IArticleBlockRelationParsedSource.ReadArticleAsync(
            ArticleRelationActorContext actor, string articleIdentity, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            ArticleRelationIndexArticleRead read = await ReadArticleAsync(actor, articleIdentity, expectedSourceGeneration, cancellationToken);
            return new(read.Actor, read.SourceGeneration, new(read.Article.ArticleIdentity, read.Article.SourceSequence, [])
            {
                Embeds = read.Article.Embeds
            });
        }
    }
}
