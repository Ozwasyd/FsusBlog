using static FsusBlog.Shared.Contracts.ArticleEmbeds.ArticleEmbedContractDigest;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

/// <summary>Canonical digests for the publication-planning slice; serialization stays owned by the shared writer.</summary>
public static class ArticleEmbedPublicationDigest
{
    public static string ComputeAuthority(ArticleEmbedPublicationAuthority authority)
    {
        ArgumentNullException.ThrowIfNull(authority);
        return Compute(writer =>
        {
            writer.Add(authority.Schema);
            writer.Add(authority.SchemaVersion);
            writer.Add(authority.HostPortableArticleIdentity);
            writer.Add(authority.HostDocument.Id);
            writer.Add(authority.HostDocument.Epoch);
            writer.Add(authority.HostCurrentRevision);
            writer.Add(authority.HostSourceDigest);
            writer.Add(authority.PublicationRequestId);
            writer.Add(authority.ExpectedRevision);
            writer.Add(authority.AuthorityGeneration);
            writer.Add(authority.Actor.ActorIdentity);
            writer.Add(authority.Actor.SiteIdentity);
            writer.Add(authority.Actor.PermissionContextDigest);
            writer.Add(authority.Runtime.ProviderId);
            writer.Add(authority.Runtime.ProviderVersion);
            writer.Add(authority.Runtime.RuntimeVersion);
            writer.Add(authority.Runtime.RuntimeDigest);
            writer.Add(authority.MaterialLocale);
            writer.Add(authority.MaterialTheme);
            writer.Add(authority.FrozenArtifactRetention);
            writer.Add(authority.Targets.Count);
            foreach (ArticleEmbedPublicationTargetFacts target in authority.Targets)
            {
                AddFacts(writer, target);
            }
        });
    }

    public static string ComputeEdge(ArticleEmbedPublicationEdge edge)
    {
        ArgumentNullException.ThrowIfNull(edge);
        return Compute(writer =>
        {
            writer.Add(edge.Schema);
            writer.Add(edge.SchemaVersion);
            writer.Add(edge.OwnerPortableArticleIdentity);
            writer.Add(edge.OwnerRevision);
            AddDirective(writer, edge.Directive);
            AddTarget(writer, edge.Target);
            writer.Add((byte)edge.Status);
            writer.Add(edge.Coordinate?.DependencyDigest);
            writer.Add(edge.Error is not null);
            if (edge.Error is not null)
            {
                writer.Add((byte)edge.Error.Code);
                writer.Add(edge.Error.SafeReasonCode);
            }
            writer.Add(edge.Depth);
            writer.Add(edge.LatestObservedRevision);
        });
    }

    /// <summary>One digest over the ordered edge list so any graph tamper is observable.</summary>
    public static string ComputeGraph(IReadOnlyList<ArticleEmbedPublicationEdge> edges)
    {
        ArgumentNullException.ThrowIfNull(edges);
        return Compute(writer =>
        {
            writer.Add(edges.Count);
            foreach (ArticleEmbedPublicationEdge edge in edges)
            {
                writer.Add(edge.EdgeDigest);
            }
        });
    }

    public static string ComputeReceipt(ArticleEmbedPublicationReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        return Compute(writer =>
        {
            writer.Add(receipt.Schema);
            writer.Add(receipt.SchemaVersion);
            writer.Add(receipt.HostPortableArticleIdentity);
            writer.Add(receipt.HostDocument.Id);
            writer.Add(receipt.HostDocument.Epoch);
            writer.Add(receipt.HostCurrentRevision);
            writer.Add(receipt.HostSourceDigest);
            writer.Add(receipt.PublicationRequestId);
            writer.Add(receipt.ExpectedRevision);
            writer.Add(receipt.AuthorityGeneration);
            writer.Add(receipt.AuthorityDigest);
            writer.Add(receipt.Actor.ActorIdentity);
            writer.Add(receipt.Actor.SiteIdentity);
            writer.Add(receipt.Actor.PermissionContextDigest);
            writer.Add(receipt.Runtime.ProviderId);
            writer.Add(receipt.Runtime.ProviderVersion);
            writer.Add(receipt.Runtime.RuntimeVersion);
            writer.Add(receipt.Runtime.RuntimeDigest);
            writer.Add(receipt.MaterialLocale);
            writer.Add(receipt.MaterialTheme);
            writer.Add(receipt.Budgets.MaxDepth);
            writer.Add(receipt.Budgets.MaxExpandedNodes);
            writer.Add(receipt.Budgets.MaxSourceBytes);
            writer.Add(receipt.Budgets.MaxElapsedMilliseconds);
            writer.Add(receipt.Budgets.MaxAuthorityMessages);
            writer.Add(receipt.Observed.Depth);
            writer.Add(receipt.Observed.Nodes);
            writer.Add(receipt.Observed.Bytes);
            writer.Add(receipt.Observed.ElapsedMilliseconds);
            writer.Add(receipt.RequestCount);
            writer.Add(receipt.FrozenEdgeCount);
            writer.Add(receipt.BlockedEdgeCount);
            writer.Add(receipt.MaxObservedDepth);
            writer.Add(receipt.GraphDigest);
            writer.Add(receipt.Items.Count);
            foreach (ArticleEmbedPublicationReceiptItem item in receipt.Items)
            {
                writer.Add(item.RequestId);
                AddTarget(writer, item.Target);
                writer.Add((byte)item.Status);
                writer.Add(item.ErrorCode is null ? (byte)0 : (byte)item.ErrorCode.Value);
                writer.Add(item.ResolvedRevision ?? -1L);
                writer.Add(item.DescendantEdgeCount);
                writer.Add(item.BlockedDescendantCount);
                writer.Add(item.EdgeDigest);
            }
        });
    }

    public static string ComputePlan(ArticleEmbedPublicationPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return Compute(writer =>
        {
            writer.Add(plan.Schema);
            writer.Add(plan.SchemaVersion);
            writer.Add((byte)plan.Status);
            writer.Add(plan.BlockedReasonCode);
            writer.Add(plan.Edges.Count);
            foreach (ArticleEmbedPublicationEdge edge in plan.Edges)
            {
                writer.Add(edge.EdgeDigest);
            }
            writer.Add(plan.Receipt.ReceiptDigest);
        });
    }

    private static void AddFacts(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedPublicationTargetFacts facts)
    {
        writer.Add(facts.PortableArticleIdentity);
        writer.Add(facts.SiteIdentity);
        writer.Add(facts.AuthorityGeneration);
        writer.Add(facts.ResolvedPublicRevision);
        writer.Add(facts.LatestObservedRevision);
        writer.Add((byte)facts.Visibility);
        writer.Add((byte)facts.Lifecycle);
        writer.Add((byte)facts.Permission);
        writer.Add(facts.RevisionPackageComplete);
        writer.Add(facts.PublicSourceDigest);
        writer.Add(facts.TargetVersionIdentity);
        writer.Add(facts.RightsDigest);
        writer.Add(facts.SourceByteCount);
        writer.Add(facts.AttributionDisplayText);
        AddProjection(writer, facts.BodyProjection);
        writer.Add(facts.Headings.Count);
        foreach (ArticleEmbedPublicationHeadingFact heading in facts.Headings)
        {
            writer.Add(heading.HeadingIdentity);
            AddProjection(writer, heading.SubtreeProjection);
        }
        writer.Add(facts.Blocks.Count);
        foreach (ArticleEmbedPublicationBlockFact block in facts.Blocks)
        {
            writer.Add(block.BlockAnchor);
            AddProjection(writer, block.BlockProjection);
        }
        writer.Add(facts.NestedDirectives.Count);
        foreach (ArticleEmbedDirectiveProjection directive in facts.NestedDirectives)
        {
            AddDirective(writer, directive);
        }
    }

    private static void AddDirective(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedDirectiveProjection? directive)
    {
        writer.Add(directive is not null);
        if (directive is null)
        {
            return;
        }
        writer.Add(directive.ParserContract);
        writer.Add(directive.TargetToken);
        writer.Add((byte)directive.Mode);
        writer.Add(directive.RawRange.Start);
        writer.Add(directive.RawRange.End);
    }

    private static void AddProjection(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedSafeProjectionReference projection)
    {
        writer.Add((byte)projection.Kind);
        writer.Add(projection.ProjectionIdentity);
        writer.Add(projection.ContentDigest);
    }

    private static void AddTarget(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedTargetIdentity? target)
    {
        writer.Add(target is not null);
        if (target is null)
        {
            return;
        }
        writer.Add(target.PortableArticleIdentity);
        writer.Add((byte)target.Kind);
        writer.Add(target.HeadingIdentity);
        writer.Add(target.BlockAnchor);
    }
}
