using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>Fail-closed validation and sealing for relation edges, edge sets, tickets and receipts.</summary>
public static class ArticleEmbedRelationContractValidator
{
    public static ArticleEmbedRelationEdge Seal(ArticleEmbedRelationEdge edge)
    {
        ArgumentNullException.ThrowIfNull(edge);
        ArticleEmbedRelationEdge unsigned = edge with
        {
            EdgeDigest = string.Empty
        };
        return unsigned with
        {
            EdgeDigest = ArticleEmbedRelationDigest.ComputeEdge(unsigned)
        };
    }

    public static ArticleEmbedRelationEdgeSet Seal(ArticleEmbedRelationEdgeSet edgeSet)
    {
        ArgumentNullException.ThrowIfNull(edgeSet);
        ArticleEmbedRelationEdgeSet unsigned = edgeSet with
        {
            SetDigest = string.Empty
        };
        return unsigned with
        {
            SetDigest = ArticleEmbedRelationDigest.ComputeEdgeSet(unsigned)
        };
    }

    public static ArticleEmbedDependencyReceipt Seal(ArticleEmbedDependencyReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ArticleEmbedDependencyReceipt unsigned = receipt with
        {
            ReceiptDigest = string.Empty
        };
        return unsigned with
        {
            ReceiptDigest = ArticleEmbedRelationDigest.ComputeDependencyReceipt(unsigned)
        };
    }

    public static ArticleEmbedInvalidationTicket Seal(ArticleEmbedInvalidationTicket ticket)
    {
        ArgumentNullException.ThrowIfNull(ticket);
        ArticleEmbedInvalidationTicket unsigned = ticket with
        {
            TicketDigest = string.Empty
        };
        return unsigned with
        {
            TicketDigest = ArticleEmbedRelationDigest.ComputeInvalidationTicket(unsigned)
        };
    }

    public static ArticleEmbedRelationQueryReceipt Seal(ArticleEmbedRelationQueryReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ArticleEmbedRelationQueryReceipt unsigned = receipt with
        {
            ReceiptDigest = string.Empty
        };
        return unsigned with
        {
            ReceiptDigest = ArticleEmbedRelationDigest.ComputeQueryReceipt(unsigned)
        };
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedRelationEdge? edge)
    {
        if (edge is null
            || edge.Schema != ArticleEmbedRelationSchemas.Edge
            || edge.SchemaVersion != ArticleEmbedRelationSchemas.Version
            || !ArticleEmbedContractDigest.IsSha256(edge.EdgeIdentity)
            || !Enum.IsDefined(edge.Scope)
            || !Enum.IsDefined(edge.Status)
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(edge.OwnerPortableArticleIdentity)
            || edge.OwnerRevision < 1
            || edge.Directive is null
            || edge.Directive.ParserContract != ArticleEmbedSchemas.ParserContract
            || edge.Directive.RawRange is null
            || edge.Directive.RawRange.Start < 0
            || edge.Directive.RawRange.End <= edge.Directive.RawRange.Start
            || !Enum.IsDefined(edge.Directive.Mode)
            || edge.Target is null
            || !ArticleEmbedTargetCodec.Validate(edge.Target).IsValid
            || edge.ResolvedRevision < 1
            || edge.LatestObservedRevision < edge.ResolvedRevision
            || !Enum.IsDefined(edge.Visibility)
            || !Enum.IsDefined(edge.Lifecycle)
            || !Enum.IsDefined(edge.Permission)
            || !ArticleEmbedContractDigest.IsSha256(edge.DependencyDigest))
        {
            return Invalid("article_embed_relation_edge_invalid");
        }
        if (edge.Scope == ArticleEmbedEdgeScope.FrozenPublication
                && edge.Status != ArticleEmbedEdgeStatus.Frozen
            || edge.Scope == ArticleEmbedEdgeScope.Authoring
                && edge.Status == ArticleEmbedEdgeStatus.Frozen)
        {
            return Invalid("article_embed_relation_edge_scope_status_mismatch");
        }
        string expectedIdentity = ArticleEmbedRelationDigest.ComputeEdgeIdentity(
            edge.Scope,
            edge.OwnerPortableArticleIdentity,
            edge.Directive,
            edge.Target);
        if (!DigestEquals(edge.EdgeIdentity, expectedIdentity))
        {
            return Invalid("article_embed_relation_edge_identity_mismatch");
        }
        if (!DigestEquals(edge.EdgeDigest, ArticleEmbedRelationDigest.ComputeEdge(edge)))
        {
            return Invalid("article_embed_relation_edge_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedRelationEdgeSet? edgeSet)
    {
        if (edgeSet is null
            || edgeSet.Schema != ArticleEmbedRelationSchemas.EdgeSet
            || edgeSet.SchemaVersion != ArticleEmbedRelationSchemas.Version
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(edgeSet.HostPortableArticleIdentity)
            || edgeSet.HostDocument is null
            || edgeSet.HostDocument.Id is null or ""
            || edgeSet.HostDocument.Epoch < 1
            || edgeSet.HostSourceRevision < 1
            || !Enum.IsDefined(edgeSet.Scope)
            || edgeSet.AuthorityGeneration < 1
            || edgeSet.Actor is null
            || edgeSet.Actor.ActorIdentity is null or ""
            || edgeSet.Actor.SiteIdentity is null or ""
            || !ArticleEmbedContractDigest.IsSha256(edgeSet.Actor.PermissionContextDigest)
            || edgeSet.Runtime is null
            || edgeSet.Runtime.ProviderId is null or ""
            || edgeSet.Runtime.ProviderVersion < 1
            || edgeSet.Runtime.RuntimeVersion != ArticleEmbedSchemas.ProviderRuntime
            || !ArticleEmbedContractDigest.IsSha256(edgeSet.Runtime.RuntimeDigest)
            || !ArticleEmbedContractDigest.IsSha256(edgeSet.SourceArtifactDigest)
            || edgeSet.Edges is null
            || edgeSet.Edges.Count > ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound)
        {
            return Invalid("article_embed_relation_edge_set_invalid");
        }
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleEmbedRelationEdge edge in edgeSet.Edges)
        {
            ArticleEmbedValidationResult edgeCheck = Validate(edge);
            if (!edgeCheck.IsValid)
            {
                return edgeCheck;
            }
            if (edge.Scope != edgeSet.Scope || !identities.Add(edge.EdgeIdentity))
            {
                return Invalid("article_embed_relation_edge_duplicate_or_scope_mismatch");
            }
        }
        if (!DigestEquals(edgeSet.SetDigest, ArticleEmbedRelationDigest.ComputeEdgeSet(edgeSet)))
        {
            return Invalid("article_embed_relation_edge_set_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedDependencyReceipt? receipt)
    {
        if (receipt is null
            || receipt.Schema != ArticleEmbedRelationSchemas.DependencyReceipt
            || receipt.SchemaVersion != ArticleEmbedRelationSchemas.Version
            || !ArticleEmbedContractDigest.IsSha256(receipt.EdgeIdentity)
            || !ArticleEmbedContractDigest.IsSha256(receipt.PlanDigest)
            || !ArticleEmbedContractDigest.IsSha256(receipt.PublicationEdgeDigest)
            || receipt.Coordinate is null
            || !ArticleEmbedContractValidator.Validate(receipt.Coordinate).IsValid)
        {
            return Invalid("article_embed_dependency_receipt_invalid");
        }
        if (!DigestEquals(receipt.ReceiptDigest, ArticleEmbedRelationDigest.ComputeDependencyReceipt(receipt)))
        {
            return Invalid("article_embed_dependency_receipt_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedInvalidationTicket? ticket)
    {
        if (ticket is null
            || ticket.Schema != ArticleEmbedRelationSchemas.InvalidationTicket
            || ticket.SchemaVersion != ArticleEmbedRelationSchemas.Version
            || !ArticleEmbedContractDigest.IsSha256(ticket.EdgeIdentity)
            || !Enum.IsDefined(ticket.FromStatus)
            || !Enum.IsDefined(ticket.ToStatus)
            || ticket.FromStatus == ticket.ToStatus
            || ticket.FromStatus == ArticleEmbedEdgeStatus.Frozen
            || ticket.ToStatus == ArticleEmbedEdgeStatus.Frozen
            || !Enum.IsDefined(ticket.Reason)
            || !ArticleEmbedContractDigest.IsSha256(ticket.CacheKeyDigest)
            || ticket.ReconcileGeneration < 1)
        {
            return Invalid("article_embed_invalidation_ticket_invalid");
        }
        if (!DigestEquals(ticket.TicketDigest, ArticleEmbedRelationDigest.ComputeInvalidationTicket(ticket)))
        {
            return Invalid("article_embed_invalidation_ticket_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedRelationCacheKey? key)
    {
        if (key is null
            || key.HostDocumentId is null or ""
            || key.HostDocumentEpoch < 1
            || key.HostSourceRevision < 1
            || !Enum.IsDefined(key.Scope)
            || key.ProviderId is null or ""
            || key.ProviderVersion < 1
            || !ArticleEmbedContractDigest.IsSha256(key.RuntimeDigest)
            || !ArticleEmbedContractDigest.IsSha256(key.PermissionContextDigest)
            || key.SiteIdentity is null or "")
        {
            return Invalid("article_embed_relation_cache_key_invalid");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedRelationQueryReceipt? receipt)
    {
        if (receipt is null
            || receipt.Schema != ArticleEmbedRelationSchemas.QueryReceipt
            || receipt.SchemaVersion != ArticleEmbedRelationSchemas.Version
            || !Enum.IsDefined(receipt.Kind)
            || !ArticleEmbedContractDigest.IsSha256(receipt.SetDigest)
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(receipt.HostPortableArticleIdentity)
            || receipt.HostDocument is null
            || receipt.HostDocument.Id is null or ""
            || receipt.HostDocument.Epoch < 1
            || receipt.HostSourceRevision < 1
            || receipt.Actor is null
            || receipt.Actor.ActorIdentity is null or ""
            || receipt.Actor.SiteIdentity is null or ""
            || !ArticleEmbedContractDigest.IsSha256(receipt.Actor.PermissionContextDigest)
            || receipt.Runtime is null
            || receipt.Runtime.ProviderId is null or ""
            || receipt.Runtime.ProviderVersion < 1
            || receipt.Runtime.RuntimeVersion != ArticleEmbedSchemas.ProviderRuntime
            || !ArticleEmbedContractDigest.IsSha256(receipt.Runtime.RuntimeDigest)
            || receipt.Items is null
            || receipt.EdgeCount != receipt.Items.Count)
        {
            return Invalid("article_embed_relation_query_receipt_invalid");
        }
        foreach (ArticleEmbedRelationQueryItem item in receipt.Items)
        {
            if (item is null
                || !ArticleEmbedContractDigest.IsSha256(item.EdgeIdentity)
                || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(item.OwnerPortableArticleIdentity)
                || item.OwnerRevision < 1
                || item.Target is null
                || !ArticleEmbedTargetCodec.Validate(item.Target).IsValid
                || item.ResolvedRevision < 1
                || item.LatestObservedRevision < item.ResolvedRevision
                || !Enum.IsDefined(item.Status)
                || receipt.Kind == ArticleEmbedRelationQueryKind.PublicDelivery
                    && item.Status != ArticleEmbedEdgeStatus.Frozen
                || receipt.Kind == ArticleEmbedRelationQueryKind.AuthoringCurrent
                    && item.Status == ArticleEmbedEdgeStatus.Frozen
                || !ArticleEmbedContractDigest.IsSha256(item.DependencyDigest)
                || !ArticleEmbedContractDigest.IsSha256(item.EdgeDigest))
            {
                return Invalid("article_embed_relation_query_item_invalid");
            }
        }
        if (!DigestEquals(receipt.ReceiptDigest, ArticleEmbedRelationDigest.ComputeQueryReceipt(receipt)))
        {
            return Invalid("article_embed_relation_query_receipt_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static bool DigestEquals(string? supplied, string expected)
    {
        if (!ArticleEmbedContractDigest.IsSha256(supplied))
        {
            return false;
        }
        return CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(supplied!),
            Convert.FromHexString(expected));
    }

    private static ArticleEmbedValidationResult Invalid(string reasonCode)
        => ArticleEmbedValidationResult.Invalid(reasonCode);
}
