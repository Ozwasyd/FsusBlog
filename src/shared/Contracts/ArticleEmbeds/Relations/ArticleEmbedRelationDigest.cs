using static FsusBlog.Shared.Contracts.ArticleEmbeds.ArticleEmbedContractDigest;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>Canonical digests for the relation-edge slice; serialization stays owned by the shared writer.</summary>
public static class ArticleEmbedRelationDigest
{
    /// <summary>Revision-independent dedup identity: same scope, owner, source range and target.</summary>
    public static string ComputeEdgeIdentity(
        ArticleEmbedEdgeScope scope,
        string ownerPortableArticleIdentity,
        ArticleEmbedDirectiveProjection directive,
        ArticleEmbedTargetIdentity target)
        => Compute(writer =>
        {
            writer.Add((byte)scope);
            writer.Add(ownerPortableArticleIdentity);
            writer.Add(directive.RawRange.Start);
            writer.Add(directive.RawRange.End);
            writer.Add(directive.TargetToken);
            writer.Add((byte)directive.Mode);
            AddTarget(writer, target);
        });

    public static string ComputeEdge(ArticleEmbedRelationEdge edge)
    {
        ArgumentNullException.ThrowIfNull(edge);
        return Compute(writer =>
        {
            writer.Add(edge.Schema);
            writer.Add(edge.SchemaVersion);
            writer.Add(edge.EdgeIdentity);
            writer.Add((byte)edge.Scope);
            writer.Add((byte)edge.Status);
            writer.Add(edge.OwnerPortableArticleIdentity);
            writer.Add(edge.OwnerRevision);
            AddDirective(writer, edge.Directive);
            AddTarget(writer, edge.Target);
            writer.Add(edge.ResolvedRevision);
            writer.Add(edge.LatestObservedRevision);
            writer.Add((byte)edge.Visibility);
            writer.Add((byte)edge.Lifecycle);
            writer.Add((byte)edge.Permission);
            writer.Add(edge.DependencyDigest);
        });
    }

    public static string ComputeEdgeSet(ArticleEmbedRelationEdgeSet edgeSet)
    {
        ArgumentNullException.ThrowIfNull(edgeSet);
        return Compute(writer =>
        {
            writer.Add(edgeSet.Schema);
            writer.Add(edgeSet.SchemaVersion);
            writer.Add(edgeSet.HostPortableArticleIdentity);
            writer.Add(edgeSet.HostDocument.Id);
            writer.Add(edgeSet.HostDocument.Epoch);
            writer.Add(edgeSet.HostSourceRevision);
            writer.Add((byte)edgeSet.Scope);
            writer.Add(edgeSet.AuthorityGeneration);
            writer.Add(edgeSet.Actor.ActorIdentity);
            writer.Add(edgeSet.Actor.SiteIdentity);
            writer.Add(edgeSet.Actor.PermissionContextDigest);
            writer.Add(edgeSet.Runtime.ProviderId);
            writer.Add(edgeSet.Runtime.ProviderVersion);
            writer.Add(edgeSet.Runtime.RuntimeVersion);
            writer.Add(edgeSet.Runtime.RuntimeDigest);
            writer.Add(edgeSet.MaterialLocale);
            writer.Add(edgeSet.MaterialTheme);
            writer.Add(edgeSet.SourceArtifactDigest);
            writer.Add(edgeSet.Edges.Count);
            foreach (ArticleEmbedRelationEdge edge in edgeSet.Edges)
            {
                writer.Add(edge.EdgeDigest);
            }
        });
    }

    public static string ComputeDependencyReceipt(ArticleEmbedDependencyReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        return Compute(writer =>
        {
            writer.Add(receipt.Schema);
            writer.Add(receipt.SchemaVersion);
            writer.Add(receipt.EdgeIdentity);
            writer.Add(receipt.PlanDigest);
            writer.Add(receipt.PublicationEdgeDigest);
            AddTarget(writer, receipt.Coordinate.Target);
            writer.Add(receipt.Coordinate.ResolvedRevision);
            writer.Add(receipt.Coordinate.TargetVersionIdentity);
            writer.Add(receipt.Coordinate.ProjectionIdentity);
            writer.Add(receipt.Coordinate.ProjectionDigest);
            writer.Add(receipt.Coordinate.DependencyDigest);
        });
    }

    public static string ComputeInvalidationTicket(ArticleEmbedInvalidationTicket ticket)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        return Compute(writer =>
        {
            writer.Add(ticket.Schema);
            writer.Add(ticket.SchemaVersion);
            writer.Add(ticket.EdgeIdentity);
            writer.Add((byte)ticket.FromStatus);
            writer.Add((byte)ticket.ToStatus);
            writer.Add((byte)ticket.Reason);
            writer.Add(ticket.CacheKeyDigest);
            writer.Add(ticket.ReconcileGeneration);
        });
    }

    public static string ComputeCacheKey(ArticleEmbedRelationCacheKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return Compute(writer =>
        {
            writer.Add(key.HostDocumentId);
            writer.Add(key.HostDocumentEpoch);
            writer.Add(key.HostSourceRevision);
            writer.Add((byte)key.Scope);
            writer.Add(key.ProviderId);
            writer.Add(key.ProviderVersion);
            writer.Add(key.RuntimeDigest);
            writer.Add(key.PermissionContextDigest);
            writer.Add(key.SiteIdentity);
            writer.Add(key.MaterialLocale);
            writer.Add(key.MaterialTheme);
        });
    }

    public static string ComputeQueryReceipt(ArticleEmbedRelationQueryReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        return Compute(writer =>
        {
            writer.Add(receipt.Schema);
            writer.Add(receipt.SchemaVersion);
            writer.Add((byte)receipt.Kind);
            writer.Add(receipt.SetDigest);
            writer.Add(receipt.HostPortableArticleIdentity);
            writer.Add(receipt.HostDocument.Id);
            writer.Add(receipt.HostDocument.Epoch);
            writer.Add(receipt.HostSourceRevision);
            writer.Add(receipt.Actor.ActorIdentity);
            writer.Add(receipt.Actor.SiteIdentity);
            writer.Add(receipt.Actor.PermissionContextDigest);
            writer.Add(receipt.Runtime.ProviderId);
            writer.Add(receipt.Runtime.ProviderVersion);
            writer.Add(receipt.Runtime.RuntimeVersion);
            writer.Add(receipt.Runtime.RuntimeDigest);
            writer.Add(receipt.EdgeCount);
            foreach (ArticleEmbedRelationQueryItem item in receipt.Items)
            {
                writer.Add(item.EdgeIdentity);
                writer.Add(item.OwnerPortableArticleIdentity);
                writer.Add(item.OwnerRevision);
                AddTarget(writer, item.Target);
                writer.Add(item.ResolvedRevision);
                writer.Add(item.LatestObservedRevision);
                writer.Add((byte)item.Status);
                writer.Add(item.DependencyDigest);
                writer.Add(item.EdgeDigest);
            }
        });
    }

    private static void AddDirective(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedDirectiveProjection directive)
    {
        writer.Add(directive.ParserContract);
        writer.Add(directive.TargetToken);
        writer.Add((byte)directive.Mode);
        writer.Add(directive.RawRange.Start);
        writer.Add(directive.RawRange.End);
    }

    private static void AddTarget(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedTargetIdentity target)
    {
        writer.Add(target.PortableArticleIdentity);
        writer.Add((byte)target.Kind);
        writer.Add(target.HeadingIdentity);
        writer.Add(target.BlockAnchor);
    }
}
