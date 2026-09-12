using static FsusBlog.Shared.Contracts.ArticleEmbeds.ArticleEmbedContractDigest;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Canonical digests for the authoring-resolution slice; serialization stays owned by the shared writer.</summary>
public static class ArticleEmbedAuthoringDigest
{
    public static string ComputeSnapshot(ArticleEmbedAuthoritySnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        return Compute(writer =>
        {
            writer.Add(snapshot.Schema);
            writer.Add(snapshot.SchemaVersion);
            writer.Add(snapshot.HostPortableArticleIdentity);
            writer.Add(snapshot.HostDocument.Id);
            writer.Add(snapshot.HostDocument.Epoch);
            writer.Add(snapshot.HostSourceRevision);
            writer.Add(snapshot.HostSourceDigest);
            writer.Add(snapshot.AuthorityGeneration);
            writer.Add(snapshot.Actor.ActorIdentity);
            writer.Add(snapshot.Actor.SiteIdentity);
            writer.Add(snapshot.Actor.PermissionContextDigest);
            writer.Add(snapshot.Runtime.ProviderId);
            writer.Add(snapshot.Runtime.ProviderVersion);
            writer.Add(snapshot.Runtime.RuntimeVersion);
            writer.Add(snapshot.Runtime.RuntimeDigest);
            writer.Add(snapshot.MaterialLocale);
            writer.Add(snapshot.MaterialTheme);
            writer.Add(snapshot.Targets.Count);
            foreach (ArticleEmbedTargetFacts target in snapshot.Targets)
            {
                AddFacts(writer, target);
            }
        });
    }

    public static string ComputeCacheKey(ArticleEmbedAuthoringCacheKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return Compute(writer =>
        {
            writer.Add(key.HostDocumentId);
            writer.Add(key.HostDocumentEpoch);
            writer.Add(key.HostSourceRevision);
            writer.Add(key.PortableArticleIdentity);
            writer.Add(key.ResolvedRevision);
            writer.Add((byte)key.Kind);
            writer.Add(key.HeadingIdentity);
            writer.Add(key.BlockAnchor);
            writer.Add(key.ProviderId);
            writer.Add(key.ProviderVersion);
            writer.Add(key.RuntimeDigest);
            writer.Add(key.PermissionContextDigest);
            writer.Add(key.SiteIdentity);
            writer.Add(key.MaterialLocale);
            writer.Add(key.MaterialTheme);
        });
    }

    public static string ComputeReceipt(ArticleEmbedAuthoringReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        return Compute(writer =>
        {
            writer.Add(receipt.Schema);
            writer.Add(receipt.SchemaVersion);
            writer.Add(receipt.HostPortableArticleIdentity);
            writer.Add(receipt.HostDocument.Id);
            writer.Add(receipt.HostDocument.Epoch);
            writer.Add(receipt.HostSourceRevision);
            writer.Add(receipt.AuthorityGeneration);
            writer.Add(receipt.SnapshotDigest);
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
            writer.Add(receipt.ResolvedCount);
            writer.Add(receipt.FailedCount);
            writer.Add(receipt.CacheHitCount);
            writer.Add(receipt.MaxObservedDepth);
            writer.Add(receipt.Items.Count);
            foreach (ArticleEmbedAuthoringReceiptItem item in receipt.Items)
            {
                writer.Add(item.RequestId);
                AddTarget(writer, item.Target);
                writer.Add((byte)item.Status);
                writer.Add(item.ErrorCode is null ? (byte)0 : (byte)item.ErrorCode.Value);
                writer.Add((byte)item.Visibility);
                writer.Add((byte)item.Lifecycle);
                writer.Add((byte)item.Permission);
                writer.Add(item.ResolvedRevision ?? -1L);
                writer.Add((byte)item.Eligibility);
                writer.Add(item.CacheHit);
                writer.Add(item.ChildCount);
                writer.Add(item.ResultDigest);
            }
        });
    }

    public static string ComputeResolution(ArticleEmbedAuthoringResolution resolution)
    {
        ArgumentNullException.ThrowIfNull(resolution);
        return Compute(writer =>
        {
            writer.Add(resolution.Schema);
            writer.Add(resolution.SchemaVersion);
            writer.Add((byte)resolution.Status);
            writer.Add(resolution.RejectedReasonCode);
            writer.Add(resolution.Results.Count);
            foreach (ArticleEmbedAuthoringEmbedResult result in resolution.Results)
            {
                AddEmbedResult(writer, result);
            }
            writer.Add(resolution.Receipt.ReceiptDigest);
        });
    }

    private static void AddEmbedResult(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedAuthoringEmbedResult result)
    {
        writer.Add(result.RequestId);
        writer.Add(result.Result.ResultDigest);
        writer.Add((byte)result.Eligibility);
        writer.Add(result.OpenSource is not null);
        if (result.OpenSource is not null)
        {
            writer.Add(result.OpenSource.IntentKind);
            AddTarget(writer, result.OpenSource.Target);
            writer.Add(result.OpenSource.ResolvedRevision);
        }
        writer.Add(result.UpdateAvailable);
        writer.Add(result.Children.Count);
        foreach (ArticleEmbedResolvedNode child in result.Children)
        {
            AddNode(writer, child);
        }
    }

    private static void AddNode(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedResolvedNode node)
    {
        writer.Add(node.Directive.ParserContract);
        writer.Add(node.Directive.TargetToken);
        writer.Add((byte)node.Directive.Mode);
        writer.Add(node.Directive.RawRange.Start);
        writer.Add(node.Directive.RawRange.End);
        AddTarget(writer, node.Target);
        writer.Add((byte)node.Status);
        writer.Add(node.Coordinate?.DependencyDigest);
        writer.Add(node.Error is not null);
        if (node.Error is not null)
        {
            writer.Add((byte)node.Error.Code);
            writer.Add(node.Error.SafeReasonCode);
        }
        writer.Add(node.Children.Count);
        foreach (ArticleEmbedResolvedNode child in node.Children)
        {
            AddNode(writer, child);
        }
    }

    private static void AddFacts(
        ArticleEmbedContractDigest.CanonicalWriter writer,
        ArticleEmbedTargetFacts facts)
    {
        writer.Add(facts.PortableArticleIdentity);
        writer.Add(facts.SiteIdentity);
        writer.Add(facts.AuthorityGeneration);
        writer.Add(facts.ResolvedRevision);
        writer.Add(facts.SourceRevision);
        writer.Add(facts.LatestObservedRevision);
        writer.Add((byte)facts.Visibility);
        writer.Add((byte)facts.Lifecycle);
        writer.Add((byte)facts.Permission);
        writer.Add(facts.SourceDigest);
        writer.Add(facts.TargetVersionIdentity);
        writer.Add(facts.SourceByteCount);
        writer.Add(facts.AttributionDisplayText);
        AddProjection(writer, facts.BodyProjection);
        writer.Add(facts.Headings.Count);
        foreach (ArticleEmbedHeadingFact heading in facts.Headings)
        {
            writer.Add(heading.HeadingIdentity);
            AddProjection(writer, heading.SubtreeProjection);
        }
        writer.Add(facts.Blocks.Count);
        foreach (ArticleEmbedBlockFact block in facts.Blocks)
        {
            writer.Add(block.BlockAnchor);
            AddProjection(writer, block.BlockProjection);
        }
        writer.Add(facts.NestedDirectives.Count);
        foreach (ArticleEmbedDirectiveProjection directive in facts.NestedDirectives)
        {
            writer.Add(directive.ParserContract);
            writer.Add(directive.TargetToken);
            writer.Add((byte)directive.Mode);
            writer.Add(directive.RawRange.Start);
            writer.Add(directive.RawRange.End);
        }
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
