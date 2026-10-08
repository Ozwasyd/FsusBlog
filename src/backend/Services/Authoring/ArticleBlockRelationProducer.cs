using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Produces canonical block-link source sets from original parsed nodes and target inventories.
/// It reuses the only codec/validator/sealer, never scans raw source or infers article identity from
/// a route, and never turns asserted permission facts into response or transaction admission.
/// Rejected inventories yield no partial source set, so the sole index cannot commit partial edges.
/// </summary>
public static class ArticleBlockRelationProducer
{
    public const int MaxLinks = ArticleRelationIndex.MaxRelations;
    public const int MaxTargets = ArticleRelationIndex.MaxArticles;
    public const int MaxAnchors = 100_000;

    /// <summary>Derives the complete source set or one content-free refusal; never a partial or admitted response.</summary>
    public static ArticleBlockRelationProduction Produce(
        ArticleBlockRelationProductionInput? input,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (input is null
            || !ArticleRelationContractValidator.Validate(input.Source).IsValid
            || !ArticleRelationContractValidator.Validate(input.Visibility).IsValid
            || input.Source.Permission != ArticleRelationPermissionState.Allowed
            || input.Visibility.SourceActor != input.Source.SourceActor
            || input.Visibility.QueryActor.SiteIdentity != input.Source.SourceActor.SiteIdentity
            || input.SourceGeneration < 1
            || string.IsNullOrWhiteSpace(input.ParserContract) || input.ParserContract.Length > 256
            || input.ParsedSourceDigest != input.Source.ContentDigest
            || input.SourceUtf16Length is < 0 or > ArticleRelationIndex.MaxStoredTextCharacters
            || input.AnchorContractVersion != BlockAnchorSchemas.Version
            || input.AnchorContractDigest != BlockAnchorSchemas.ContractDigest
            || input.Links.IsDefault || input.Links.Length > MaxLinks
            || input.Links.Any(static node => node is null || node.SourceRange is null)
            || input.Targets.IsDefault || input.Targets.Length > MaxTargets)
        {
            return Rejected("article_block_relation_source_unavailable");
        }

        var targets = new Dictionary<string, TargetInventory>(StringComparer.Ordinal);
        int anchorCount = 0;
        foreach (ArticleBlockRelationTargetInventory inventory in input.Targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (inventory is null || inventory.Actor != input.Visibility.QueryActor
                || inventory.SourceGeneration != input.SourceGeneration
                || !ArticleRelationContractValidator.Validate(inventory.ArticleFacts).IsValid
                || inventory.ArticleFacts.TargetIdentity is not { Kind: ArticleRelationTargetKind.Article } identity
                || !ArticleRelationDigest.IsSha256(inventory.ContentDigest)
                || inventory.Anchors.IsDefault || inventory.Anchors.Length > MaxAnchors
                || inventory.Diagnostic != BlockTargetInventoryDiagnostic.None)
            {
                return Rejected("article_block_relation_inventory_unavailable");
            }
            anchorCount += inventory.Anchors.Length;
            if (anchorCount > MaxAnchors)
            {
                return Rejected("article_block_relation_inventory_budget_exceeded");
            }
            if (inventory.ArticleFacts.Permission != ArticleRelationPermissionState.Allowed
                && (inventory.CanonicalSlug is not null || !inventory.Anchors.IsEmpty))
            {
                return Rejected("article_block_relation_denied_inventory_has_content");
            }
            var anchors = new HashSet<BlockAnchorId>();
            foreach (BlockAnchorId anchor in inventory.Anchors)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!BlockAnchorContractValidator.Validate(anchor).IsValid || !anchors.Add(anchor))
                {
                    return Rejected("article_block_relation_inventory_ambiguous");
                }
            }
            if (!targets.TryAdd(identity.ArticleIdentity, new(inventory, anchors)))
            {
                return Rejected("article_block_relation_target_ambiguous");
            }
        }

        var nodes = new HashSet<string>(StringComparer.Ordinal);
        var usedTargets = new HashSet<string>(StringComparer.Ordinal);
        var records = ImmutableArray.CreateBuilder<ArticleRelationRecord>();
        int previousEnd = 0;
        long textCharacters = 0;
        foreach (ArticleBlockRelationParsedLink node in input.Links.OrderBy(static link => link.SourceRange.Start))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(node.NodeIdentity) || node.NodeIdentity.Length > 256 || !nodes.Add(node.NodeIdentity)
                || node.Kind != ArticleBlockRelationParsedKind.Link
                || !ArticleRelationContractValidator.Validate(node.SourceRange).IsValid
                || node.SourceRange.End > input.SourceUtf16Length
                || node.SourceRange.End - node.SourceRange.Start != node.SourceRange.MatchedText.Length
                || node.SourceRange.Start < previousEnd
                || !BlockAnchorContractValidator.Validate(node.Target).IsValid
                || !BlockAnchorMarkdownParser.TryParse(node.SourceRange.MatchedText, out BlockAnchorMarkdownLink? parsed).IsValid
                || parsed!.AnchorId != node.Target.AnchorId)
            {
                return Rejected("article_block_relation_parse_projection_invalid");
            }
            previousEnd = node.SourceRange.End;
            textCharacters += (long)node.SourceRange.MatchedText.Length * 3;
            if (textCharacters > ArticleRelationIndex.MaxStoredTextCharacters)
            {
                return Rejected("article_block_relation_source_budget_exceeded");
            }
            if (!targets.TryGetValue(node.Target.ArticleIdentity, out TargetInventory? target))
            {
                // The current shared missing-target schema cannot retain this known stable block
                // identity. Refuse instead of erasing it or deriving a replacement from the route.
                return Rejected("article_block_relation_target_unavailable");
            }
            usedTargets.Add(node.Target.ArticleIdentity);
            ArticleRelationResolutionStatus? status = Resolve(target, node, parsed!);
            if (!status.HasValue)
            {
                return Rejected("article_block_relation_target_unavailable");
            }
            ArticleRelationKind kind = status.Value switch
            {
                ArticleRelationResolutionStatus.Resolved => ArticleRelationKind.Outgoing,
                ArticleRelationResolutionStatus.Draft or ArticleRelationResolutionStatus.Private => ArticleRelationKind.VisibilityRisk,
                _ => ArticleRelationKind.Broken
            };
            ArticleRelationRecord record = ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
                ArticleRelationSchemas.Relation,
                ArticleRelationSchemas.Version,
                string.Empty,
                1,
                kind,
                input.Source,
                new(node.SourceRange.MatchedText, node.SourceRange, node.SourceRange, 1),
                target.Inventory.ArticleFacts with
                {
                    TargetIdentity = new(node.Target.ArticleIdentity, ArticleRelationTargetKind.Block, null, node.Target.AnchorId.Value)
                },
                input.Visibility,
                status.Value,
                new(ArticleRelationSchemas.Version, ArticleRelationSchemas.KindCatalogVersion, ArticleRelationSchemas.ResolutionCatalogVersion,
                    ArticleRelationSchemas.VisibilityCatalogVersion, ArticleRelationSchemas.LifecycleCatalogVersion),
                string.Empty));
            if (!ArticleRelationContractValidator.Validate(record).IsValid)
            {
                return Rejected("article_block_relation_scope_unavailable");
            }
            records.Add(record);
        }
        if (usedTargets.Count != targets.Count)
        {
            return Rejected("article_block_relation_inventory_orphan");
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticleRelationSet set = ArticleRelationContractValidator.Seal(new ArticleRelationSet(
            ArticleRelationSchemas.RelationSet, ArticleRelationSchemas.Version, input.Source,
            records.OrderBy(static record => record.RelationIdentity, StringComparer.Ordinal).ToImmutableArray(), string.Empty));
        return ArticleRelationContractValidator.Validate(set).IsValid
            ? new(true, null, set)
            : Rejected("article_block_relation_set_invalid");
    }

    private static ArticleRelationResolutionStatus? Resolve(
        TargetInventory target,
        ArticleBlockRelationParsedLink node,
        BlockAnchorMarkdownLink parsed)
    {
        ArticleRelationTargetFacts facts = target.Inventory.ArticleFacts;
        if (facts.Permission == ArticleRelationPermissionState.Unknown)
        {
            return null;
        }
        if (facts.Permission == ArticleRelationPermissionState.Denied)
        {
            return ArticleRelationResolutionStatus.Unauthorized;
        }
        if (facts.Lifecycle == ArticleRelationLifecycleState.Deleted)
        {
            return ArticleRelationResolutionStatus.Deleted;
        }
        if (facts.Lifecycle == ArticleRelationLifecycleState.Archived)
        {
            return ArticleRelationResolutionStatus.Archived;
        }
        if (facts.Lifecycle == ArticleRelationLifecycleState.Draft)
        {
            return ArticleRelationResolutionStatus.Draft;
        }
        if (facts.Lifecycle == ArticleRelationLifecycleState.Scheduled)
        {
            return ArticleRelationResolutionStatus.Private;
        }
        if (!target.Anchors.Contains(node.Target.AnchorId))
        {
            return ArticleRelationResolutionStatus.MissingAnchor;
        }
        if (!BlockAnchorMarkdownBuilder.TryBuild(parsed.DisplayText, target.Inventory.CanonicalSlug, node.Target, out string? current).IsValid)
        {
            return null;
        }
        return current == node.SourceRange.MatchedText
            ? ArticleRelationResolutionStatus.Resolved
            : ArticleRelationResolutionStatus.Stale;
    }

    private static ArticleBlockRelationProduction Rejected(string reasonCode) => new(false, reasonCode, null);

    private sealed record TargetInventory(ArticleBlockRelationTargetInventory Inventory, HashSet<BlockAnchorId> Anchors);
}
