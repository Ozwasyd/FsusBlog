using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

using static FsusBlog.Shared.Contracts.ArticleEmbeds.ArticleEmbedContractDigest;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>
/// Prepares a bounded non-executing candidate from caller-observed host facts and the existing current
/// authoring pipeline. It owns no parser, reader, permission authority, cache, writer or publication.
/// </summary>
public static class ArticleEmbedRefreshPlanner
{
    /// <summary>
    /// Compares the exact selected old/desired coordinates through the existing refresh policy.
    /// Every rejection returns no plan. Caller facts and their digests do not establish live authority.
    /// The selected graph is not proof that the entire persisted host dependency graph can be committed.
    /// </summary>
    public static ArticleEmbedRefreshPlanningResult Prepare(
        ArticleEmbedRefreshPlanRequest? request,
        ArticleEmbedRefreshHostFacts? observedHost,
        ArticleEmbedAuthoritySnapshot? currentAuthority,
        TimeProvider? time = null)
    {
        if (request is null || !IsIdentity(request.RequestId)
            || request.Selections.IsDefaultOrEmpty
            || request.Selections.Length > ArticleEmbedRefreshPlanContract.MaxSelectedDirectives
            || !ArticleEmbedAuthoringContractValidator.ValidateBudgets(request.Budgets).IsValid
            || request.Selections.Length > request.Budgets.MaxExpandedNodes
            || !ValidHost(request.ExpectedHost)
            || !IsSha256(request.ExpectedHostFactsDigest)
            || !IsSha256(request.ExpectedAuthoritySnapshotDigest)
            || request.ExpectedAuthorityGeneration < 1)
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_request_invalid");
        }
        if (!TryComputeHostFactsDigest(observedHost, out string? hostDigest))
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_host_facts_unavailable");
        }
        if (observedHost!.Host != request.ExpectedHost || observedHost.Actor != request.Actor
            || hostDigest != request.ExpectedHostFactsDigest)
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Stale, "article_embed_refresh_host_facts_drift");
        }
        if (observedHost.EditPermission != ArticleEmbedPermissionStatus.Allowed)
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_host_edit_unavailable");
        }

        var dependencies = observedHost.Dependencies.ToDictionary(static item => item.DirectiveIdentity, StringComparer.Ordinal);
        var seenRequests = new HashSet<string>(StringComparer.Ordinal);
        var seenDirectives = new HashSet<string>(StringComparer.Ordinal);
        var requests = new List<ArticleEmbedProviderRequest>(request.Selections.Length);
        foreach (ArticleEmbedRefreshSelection selection in request.Selections)
        {
            if (selection is null || !IsIdentity(selection.DirectiveIdentity)
                || !ArticleEmbedContractValidator.Validate(selection.Request).IsValid
                || !ArticleEmbedContractValidator.Validate(selection.RecordedCoordinate).IsValid
                || !ArticleEmbedContractValidator.Validate(selection.DesiredCoordinate).IsValid
                || !seenDirectives.Add(selection.DirectiveIdentity)
                || !seenRequests.Add(selection.Request.RequestId)
                || selection.Request.RequestedScope != ArticleEmbedRequestedScope.Authoring
                || selection.RecordedCoordinate.Target != selection.Request.Target
                || selection.DesiredCoordinate.Target != selection.Request.Target)
            {
                return Failure(ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_selection_invalid");
            }
            if (selection.Request.AbortSignal.IsCancellationRequested)
            {
                return Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled");
            }
            if (!dependencies.TryGetValue(selection.DirectiveIdentity, out ArticleEmbedRefreshHostDependency? recorded)
                || recorded.Directive != selection.Request.Directive
                || recorded.RecordedCoordinate != selection.RecordedCoordinate
                || selection.Request.Actor != request.Actor
                || selection.Request.HostPortableArticleIdentity != request.ExpectedHost.PortableArticleIdentity
                || selection.Request.HostDocument != request.ExpectedHost.Document
                || selection.Request.SourceRevision != request.ExpectedHost.SourceRevision
                || selection.Request.ContentDigest != request.ExpectedHost.SourceDigest)
            {
                return Failure(ArticleEmbedRefreshPlanStatus.Stale, "article_embed_refresh_selection_host_drift");
            }
            requests.Add(selection.Request);
        }

        // Bound and copy collection-bearing facts before invoking any existing recursive verifier.
        if (!WithinSnapshotEnvelope(currentAuthority, request.Budgets))
        {
            return Failure(requests, ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_authority_unbounded_or_missing");
        }
        ArticleEmbedAuthoritySnapshot snapshot = Freeze(currentAuthority!);
        if (!ArticleEmbedAuthoringContractValidator.Validate(snapshot).IsValid)
        {
            return Failure(requests, ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_authority_invalid");
        }
        if (snapshot.AuthorityGeneration != request.ExpectedAuthorityGeneration
            || snapshot.SnapshotDigest != request.ExpectedAuthoritySnapshotDigest
            || snapshot.Actor != request.Actor
            || snapshot.HostPortableArticleIdentity != request.ExpectedHost.PortableArticleIdentity
            || snapshot.HostDocument != request.ExpectedHost.Document
            || snapshot.HostSourceRevision != request.ExpectedHost.SourceRevision
            || snapshot.HostSourceDigest != request.ExpectedHost.SourceDigest
            || requests.Any(item => item.Runtime != snapshot.Runtime))
        {
            return Failure(requests, ArticleEmbedRefreshPlanStatus.Stale, "article_embed_refresh_authority_drift");
        }

        var evaluated = ArticleEmbedAuthoringPipeline.Evaluate(requests, snapshot, request.Budgets, time);
        // Cancellation can invalidate an earlier completed stage before the next verifier observes it.
        if (requests.Any(static item => item.AbortSignal.IsCancellationRequested))
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled");
        }
        ArticleEmbedAuthoringResolution graph = evaluated.Graph;
        if (graph.Status != ArticleEmbedAuthoringResolutionStatus.Completed
            || !ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, request.Budgets, graph).Valid
            || !evaluated.Relations.Accepted || evaluated.Relations.EdgeSet is null)
        {
            return Failure(requests, ArticleEmbedRefreshPlanStatus.Blocked, "article_embed_refresh_graph_unavailable");
        }
        var items = ImmutableArray.CreateBuilder<ArticleEmbedRefreshPlanItem>(requests.Count);
        var nodes = ImmutableArray.CreateBuilder<ArticleEmbedRefreshGraphNode>();
        bool changed = false;
        for (int index = 0; index < requests.Count; index++)
        {
            ArticleEmbedRefreshSelection selection = request.Selections[index];
            if (requests.Any(static item => item.AbortSignal.IsCancellationRequested))
            {
                return Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled");
            }
            ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
                requests, snapshot, request.Budgets, graph, selection.Request.RequestId,
                selection.RecordedCoordinate, out bool updateAvailable);
            if (!comparison.IsValid)
            {
                return Failure(requests, HasStaleFailure(graph.Results[index])
                        ? ArticleEmbedRefreshPlanStatus.Stale : ArticleEmbedRefreshPlanStatus.Blocked,
                    "article_embed_refresh_selected_dependency_unavailable");
            }
            ArticleEmbedProviderResult current = graph.Results[index].Result;
            if (current.Coordinate != selection.DesiredCoordinate)
            {
                return Failure(requests, ArticleEmbedRefreshPlanStatus.Stale, "article_embed_refresh_desired_coordinate_drift");
            }
            ArticleEmbedTargetFacts facts = snapshot.Targets.Single(item =>
                item.PortableArticleIdentity == selection.Request.Target.PortableArticleIdentity);
            items.Add(new ArticleEmbedRefreshPlanItem(
                selection.DirectiveIdentity, selection.Request.RequestId, selection.Request.RequestDigest,
                selection.Request.Directive, selection.RecordedCoordinate, current.Coordinate!,
                facts.SourceRevision, facts.SourceDigest, current.Visibility, current.Lifecycle,
                current.Permission, updateAvailable));
            changed |= updateAvailable;
            AppendGraph(selection.Request, graph.Results[index], nodes);
        }
        if (requests.Any(static item => item.AbortSignal.IsCancellationRequested))
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled");
        }
        foreach (ArticleEmbedRefreshGraphNode node in nodes)
        {
            ArticleEmbedTargetFacts facts = snapshot.Targets.Single(item =>
                item.PortableArticleIdentity == node.Coordinate.Target.PortableArticleIdentity);
            if (facts.LatestObservedRevision != node.Coordinate.ResolvedRevision)
            {
                return Failure(requests, ArticleEmbedRefreshPlanStatus.Stale, "article_embed_refresh_target_observation_drift");
            }
        }

        var unsigned = new ArticleEmbedRefreshPlan(request, snapshot, graph.Receipt.Observed,
            graph.ResolutionDigest, evaluated.Relations.EdgeSet.SetDigest, items.ToImmutable(), nodes.ToImmutable(), string.Empty);
        var plan = new ArticleEmbedRefreshPlan(request, snapshot, unsigned.Observed, unsigned.GraphDigest,
            unsigned.RelationSetDigest, unsigned.Items, unsigned.SelectedGraph, ComputePlanDigest(unsigned));
        if (requests.Any(static item => item.AbortSignal.IsCancellationRequested))
        {
            return Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled");
        }
        return new ArticleEmbedRefreshPlanningResult(
            changed ? ArticleEmbedRefreshPlanStatus.Prepared : ArticleEmbedRefreshPlanStatus.NoChange, plan, null);
    }

    /// <summary>
    /// Computes the structural digest of a complete bounded host observation. This cannot read a draft,
    /// authenticate its actor, establish edit permission or prove the observer supplied every dependency.
    /// </summary>
    public static bool TryComputeHostFactsDigest(ArticleEmbedRefreshHostFacts? facts, out string? digest)
    {
        digest = null;
        if (facts is null || !ValidHost(facts.Host) || facts.Actor is null
            || !IsIdentity(facts.Actor.ActorIdentity) || !IsIdentity(facts.Actor.SiteIdentity)
            || !IsSha256(facts.Actor.PermissionContextDigest) || !Enum.IsDefined(facts.EditPermission)
            || facts.Dependencies.IsDefault
            || facts.Dependencies.Length > ArticleEmbedRefreshPlanContract.MaxHostDependencies)
        {
            return false;
        }
        var identities = new HashSet<string>(StringComparer.Ordinal);
        int previousEnd = -1;
        foreach (ArticleEmbedRefreshHostDependency dependency in facts.Dependencies)
        {
            if (dependency is null || !IsIdentity(dependency.DirectiveIdentity)
                || !identities.Add(dependency.DirectiveIdentity)
                || !ArticleEmbedContractValidator.Validate(dependency.RecordedCoordinate).IsValid
                || dependency.Directive is null || dependency.Directive.RawRange is null
                || dependency.Directive.ParserContract != ArticleEmbedSchemas.ParserContract
                || dependency.Directive.RawRange.Start < 0
                || dependency.Directive.RawRange.Start < previousEnd
                || dependency.Directive.RawRange.End <= dependency.Directive.RawRange.Start
                || dependency.Directive.Mode != dependency.RecordedCoordinate.Target.Kind
                || dependency.Directive.TargetToken != ArticleEmbedTargetCodec.Encode(dependency.RecordedCoordinate.Target))
            {
                return false;
            }
            previousEnd = dependency.Directive.RawRange.End;
        }
        digest = Compute(writer =>
        {
            writer.Add("fsusblog.article-embed-refresh-host-observation.v1");
            AddHost(writer, facts.Host);
            AddActor(writer, facts.Actor);
            writer.Add((byte)facts.EditPermission);
            writer.Add(facts.Dependencies.Length);
            foreach (ArticleEmbedRefreshHostDependency dependency in facts.Dependencies)
            {
                writer.Add(dependency.DirectiveIdentity);
                AddDirective(writer, dependency.Directive);
                writer.Add(dependency.RecordedCoordinate.DependencyDigest);
            }
        });
        return true;
    }

    /// <summary>Recomputes structural binding only; a matching digest is never an authority or execution admission.</summary>
    public static string ComputePlanDigest(ArticleEmbedRefreshPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return Compute(writer =>
        {
            writer.Add(plan.Schema);
            writer.Add(plan.SchemaVersion);
            writer.Add(plan.CanExecute);
            writer.Add(plan.RequestId);
            AddActor(writer, plan.Actor);
            AddHost(writer, plan.Host);
            writer.Add(plan.HostFactsDigest);
            writer.Add(plan.AuthorityGeneration);
            writer.Add(plan.AuthoritySnapshotDigest);
            writer.Add(plan.Runtime.ProviderId);
            writer.Add(plan.Runtime.ProviderVersion);
            writer.Add(plan.Runtime.RuntimeVersion);
            writer.Add(plan.Runtime.RuntimeDigest);
            writer.Add(plan.MaterialLocale);
            writer.Add(plan.MaterialTheme);
            writer.Add(plan.Budgets.MaxDepth);
            writer.Add(plan.Budgets.MaxExpandedNodes);
            writer.Add(plan.Budgets.MaxSourceBytes);
            writer.Add(plan.Budgets.MaxElapsedMilliseconds);
            writer.Add(plan.Budgets.MaxAuthorityMessages);
            writer.Add(plan.Observed.Depth);
            writer.Add(plan.Observed.Nodes);
            writer.Add(plan.Observed.Bytes);
            writer.Add(plan.Observed.ElapsedMilliseconds);
            writer.Add(plan.GraphDigest);
            writer.Add(plan.RelationSetDigest);
            writer.Add(plan.Items.Length);
            foreach (ArticleEmbedRefreshPlanItem item in plan.Items)
            {
                writer.Add(item.DirectiveIdentity);
                writer.Add(item.ProviderRequestId);
                writer.Add(item.ProviderRequestDigest);
                AddDirective(writer, item.Directive);
                writer.Add(item.OldCoordinate.DependencyDigest);
                writer.Add(item.NewCoordinate.DependencyDigest);
                writer.Add(item.TargetSourceRevision);
                writer.Add(item.TargetSourceDigest);
                writer.Add((byte)item.Visibility);
                writer.Add((byte)item.Lifecycle);
                writer.Add((byte)item.Permission);
                writer.Add(item.Changed);
            }
            writer.Add(plan.SelectedGraph.Length);
            foreach (ArticleEmbedRefreshGraphNode node in plan.SelectedGraph)
            {
                writer.Add(node.ProviderRequestId);
                writer.Add(node.ParentIndex);
                AddDirective(writer, node.Directive);
                writer.Add(node.Coordinate.DependencyDigest);
            }
        });
    }

    private static void AppendGraph(ArticleEmbedProviderRequest request, ArticleEmbedAuthoringEmbedResult result,
        ImmutableArray<ArticleEmbedRefreshGraphNode>.Builder nodes)
    {
        int rootIndex = nodes.Count;
        nodes.Add(new ArticleEmbedRefreshGraphNode(request.RequestId, -1, request.Directive, result.Result.Coordinate!));
        var pending = new Stack<(ArticleEmbedResolvedNode Node, int Parent)>();
        PushChildren(result.Children, rootIndex);
        while (pending.TryPop(out var entry))
        {
            int index = nodes.Count;
            nodes.Add(new ArticleEmbedRefreshGraphNode(request.RequestId, entry.Parent, entry.Node.Directive, entry.Node.Coordinate!));
            PushChildren(entry.Node.Children, index);
        }

        void PushChildren(IReadOnlyList<ArticleEmbedResolvedNode> children, int parent)
        {
            for (int index = children.Count - 1; index >= 0; index--)
            {
                pending.Push((children[index], parent));
            }
        }
    }

    private static bool WithinSnapshotEnvelope(ArticleEmbedAuthoritySnapshot? snapshot, ArticleEmbedResolutionBudgetLimits budgets)
    {
        if (snapshot?.Targets is null || snapshot.Targets.Count > budgets.MaxExpandedNodes
            || snapshot.HostDocument is null || !IsIdentity(snapshot.HostDocument.Id)
            || snapshot.Actor is null || !IsIdentity(snapshot.Actor.ActorIdentity) || !IsIdentity(snapshot.Actor.SiteIdentity)
            || snapshot.Runtime is null || !IsIdentity(snapshot.Runtime.ProviderId)
            || !IsOptionalIdentity(snapshot.MaterialLocale) || !IsOptionalIdentity(snapshot.MaterialTheme))
        {
            return false;
        }
        int remaining = ArticleEmbedResolutionBudgetLimits.AuthorityMessagesBound;
        foreach (ArticleEmbedTargetFacts facts in snapshot.Targets)
        {
            if (facts?.Headings is null || facts.Blocks is null || facts.NestedDirectives is null
                || !IsIdentity(facts.SiteIdentity) || facts.SourceByteCount < 0 || facts.SourceByteCount > budgets.MaxSourceBytes
                || !IsIdentity(facts.TargetVersionIdentity) || !ValidProjection(facts.BodyProjection))
            {
                return false;
            }
            long count = (long)facts.Headings.Count + facts.Blocks.Count + facts.NestedDirectives.Count + 1;
            if (count > remaining)
            {
                return false;
            }
            remaining -= (int)count;
            if (facts.Headings.Any(static item => item is null || !ValidProjection(item.SubtreeProjection))
                || facts.Blocks.Any(static item => item is null || !ValidProjection(item.BlockProjection))
                || facts.NestedDirectives.Any(static item => item is null || item.TargetToken is null || item.TargetToken.Length > 256))
            {
                return false;
            }
        }
        return true;
    }

    private static bool HasStaleFailure(ArticleEmbedAuthoringEmbedResult result)
    {
        if (IsStale(result.Result.Error?.Code))
        {
            return true;
        }
        var pending = new Stack<ArticleEmbedResolvedNode>(result.Children);
        while (pending.TryPop(out ArticleEmbedResolvedNode? node))
        {
            if (IsStale(node.Error?.Code))
            {
                return true;
            }
            foreach (ArticleEmbedResolvedNode child in node.Children)
            {
                pending.Push(child);
            }
        }
        return false;
    }

    private static bool IsStale(ArticleEmbedErrorCode? error)
        => error is ArticleEmbedErrorCode.StaleSource or ArticleEmbedErrorCode.StaleTarget or ArticleEmbedErrorCode.StaleRuntime;

    private static ArticleEmbedAuthoritySnapshot Freeze(ArticleEmbedAuthoritySnapshot snapshot)
        => snapshot with
        {
            Targets = snapshot.Targets.Select(static facts => facts with
            {
                Headings = facts.Headings.ToImmutableArray(),
                Blocks = facts.Blocks.ToImmutableArray(),
                NestedDirectives = facts.NestedDirectives.ToImmutableArray()
            }).ToImmutableArray()
        };

    private static bool ValidHost(ArticleEmbedRefreshHostCoordinate? host)
        => host is not null && ArticleEmbedTargetCodec.IsPortableArticleIdentity(host.PortableArticleIdentity)
            && IsIdentity(host.DraftKey, 96) && host.ServerRevision > 0
            && host.Document is not null && IsIdentity(host.Document.Id) && host.Document.Epoch > 0
            && host.SourceRevision > 0 && IsSha256(host.SourceDigest);

    private static bool ValidProjection(ArticleEmbedSafeProjectionReference? projection)
        => projection is not null && IsIdentity(projection.ProjectionIdentity) && IsSha256(projection.ContentDigest);

    private static bool IsOptionalIdentity(string? value) => value is null || IsIdentity(value);

    private static bool IsIdentity(string? value, int maximum = 160)
        => value is not null && value.Length > 0 && value.Length <= maximum
            && !value.Any(static character => char.IsWhiteSpace(character) || char.IsControl(character));

    private static void AddHost(CanonicalWriter writer, ArticleEmbedRefreshHostCoordinate host)
    {
        writer.Add(host.PortableArticleIdentity);
        writer.Add(host.DraftKey);
        writer.Add(host.ServerRevision);
        writer.Add(host.Document.Id);
        writer.Add(host.Document.Epoch);
        writer.Add(host.SourceRevision);
        writer.Add(host.SourceDigest);
    }

    private static void AddActor(CanonicalWriter writer, ArticleEmbedActorContext actor)
    {
        writer.Add(actor.ActorIdentity);
        writer.Add(actor.SiteIdentity);
        writer.Add(actor.PermissionContextDigest);
    }

    private static void AddDirective(CanonicalWriter writer, ArticleEmbedDirectiveProjection directive)
    {
        writer.Add(directive.ParserContract);
        writer.Add(directive.TargetToken);
        writer.Add((byte)directive.Mode);
        writer.Add(directive.RawRange.Start);
        writer.Add(directive.RawRange.End);
    }

    // Recheck after validation/comparison, which can observe cancellation after the preceding guard.
    private static ArticleEmbedRefreshPlanningResult Failure(
        IReadOnlyList<ArticleEmbedProviderRequest> requests, ArticleEmbedRefreshPlanStatus status, string reason)
        => requests.Any(static item => item.AbortSignal.IsCancellationRequested)
            ? Failure(ArticleEmbedRefreshPlanStatus.Cancelled, "article_embed_refresh_cancelled")
            : Failure(status, reason);

    private static ArticleEmbedRefreshPlanningResult Failure(ArticleEmbedRefreshPlanStatus status, string reason)
        => new(status, null, reason);
}
