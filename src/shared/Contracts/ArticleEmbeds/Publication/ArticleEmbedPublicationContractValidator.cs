using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

/// <summary>Fail-closed validation and sealing for the publication authority, edges, plan and receipt.</summary>
public static class ArticleEmbedPublicationContractValidator
{
    public static ArticleEmbedPublicationAuthority Seal(ArticleEmbedPublicationAuthority authority)
    {
        ArgumentNullException.ThrowIfNull(authority);
        ArticleEmbedPublicationAuthority unsigned = authority with
        {
            AuthorityDigest = string.Empty
        };
        return unsigned with
        {
            AuthorityDigest = ArticleEmbedPublicationDigest.ComputeAuthority(unsigned)
        };
    }

    public static ArticleEmbedPublicationEdge Seal(ArticleEmbedPublicationEdge edge)
    {
        ArgumentNullException.ThrowIfNull(edge);
        ArticleEmbedPublicationEdge unsigned = edge with
        {
            EdgeDigest = string.Empty
        };
        return unsigned with
        {
            EdgeDigest = ArticleEmbedPublicationDigest.ComputeEdge(unsigned)
        };
    }

    /// <summary>
    /// The publication-writer gate: a plan feeds business writes only when it is structurally valid, sealed, and
    /// still bound to the current authority generation and digest. Blocked, malformed or drifted plans are invalid
    /// and the writer must emit zero writes.
    /// </summary>
    public static ArticleEmbedValidationResult ValidateForCommit(
        ArticleEmbedPublicationPlan? plan,
        ArticleEmbedPublicationAuthority? currentAuthority)
    {
        ArticleEmbedValidationResult structure = Validate(plan);
        if (!structure.IsValid)
        {
            return structure;
        }
        if (plan!.Status != ArticleEmbedPublicationPlanStatus.Sealed)
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_publication_plan_blocked");
        }
        ArticleEmbedValidationResult authority = Validate(currentAuthority);
        if (!authority.IsValid)
        {
            return authority;
        }
        if (plan.Receipt.AuthorityGeneration != currentAuthority!.AuthorityGeneration
            || !DigestEquals(plan.Receipt.AuthorityDigest, currentAuthority.AuthorityDigest))
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_publication_plan_stale");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedPublicationAuthority? authority)
    {
        if (authority is null)
        {
            return Invalid("article_embed_publication_authority_missing");
        }
        if (authority.Schema != ArticleEmbedPublicationSchemas.Authority
            || authority.SchemaVersion != ArticleEmbedPublicationSchemas.Version)
        {
            return Invalid("article_embed_publication_authority_schema_unknown");
        }
        if (!ArticleEmbedTargetCodec.IsPortableArticleIdentity(authority.HostPortableArticleIdentity)
            || authority.HostDocument is null
            || authority.HostDocument.Id is null or ""
            || authority.HostDocument.Epoch < 1
            || authority.HostCurrentRevision < 1
            || !ArticleEmbedContractDigest.IsSha256(authority.HostSourceDigest)
            || authority.PublicationRequestId is null or ""
            || authority.ExpectedRevision < authority.HostCurrentRevision
            || authority.AuthorityGeneration < 1)
        {
            return Invalid("article_embed_publication_host_coordinate_invalid");
        }
        if (authority.Actor is null
            || authority.Actor.ActorIdentity is null or ""
            || authority.Actor.SiteIdentity is null or ""
            || !ArticleEmbedContractDigest.IsSha256(authority.Actor.PermissionContextDigest))
        {
            return Invalid("article_embed_publication_actor_invalid");
        }
        if (authority.Runtime is null
            || authority.Runtime.ProviderId is null or ""
            || authority.Runtime.ProviderVersion < 1
            || authority.Runtime.RuntimeVersion != ArticleEmbedSchemas.ProviderRuntime
            || !ArticleEmbedContractDigest.IsSha256(authority.Runtime.RuntimeDigest))
        {
            return Invalid("article_embed_publication_runtime_invalid");
        }
        if (authority.Targets is null)
        {
            return Invalid("article_embed_publication_targets_missing");
        }
        foreach (ArticleEmbedPublicationTargetFacts facts in authority.Targets)
        {
            ArticleEmbedValidationResult target = ValidateFacts(facts);
            if (!target.IsValid)
            {
                return target;
            }
        }
        if (!DigestEquals(authority.AuthorityDigest, ArticleEmbedPublicationDigest.ComputeAuthority(authority)))
        {
            return Invalid("article_embed_publication_authority_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedPublicationPlan? plan)
    {
        if (plan is null)
        {
            return Invalid("article_embed_publication_plan_missing");
        }
        if (plan.Schema != ArticleEmbedPublicationSchemas.Plan
            || plan.SchemaVersion != ArticleEmbedPublicationSchemas.Version
            || !Enum.IsDefined(plan.Status)
            || plan.Receipt is null
            || plan.Edges is null)
        {
            return Invalid("article_embed_publication_plan_invalid");
        }
        if (plan.Status == ArticleEmbedPublicationPlanStatus.Blocked
            ? plan.BlockedReasonCode is null
            : plan.BlockedReasonCode is not null)
        {
            return Invalid("article_embed_publication_plan_invalid");
        }
        foreach (ArticleEmbedPublicationEdge edge in plan.Edges)
        {
            ArticleEmbedValidationResult edgeCheck = Validate(edge);
            if (!edgeCheck.IsValid)
            {
                return edgeCheck;
            }
        }
        if (!DigestEquals(plan.Receipt.ReceiptDigest, ArticleEmbedPublicationDigest.ComputeReceipt(plan.Receipt))
            || !DigestEquals(plan.PlanDigest, ArticleEmbedPublicationDigest.ComputePlan(plan)))
        {
            return Invalid("article_embed_publication_plan_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedPublicationEdge? edge)
    {
        if (edge is null
            || edge.Schema != ArticleEmbedPublicationSchemas.Edge
            || edge.SchemaVersion != ArticleEmbedPublicationSchemas.Version
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(edge.OwnerPortableArticleIdentity)
            || edge.OwnerRevision < 1
            || !Enum.IsDefined(edge.Status)
            || edge.Depth < 1
            || edge.LatestObservedRevision < 0)
        {
            return Invalid("article_embed_publication_edge_invalid");
        }
        if (edge.Status == ArticleEmbedPublicationEdgeStatus.Frozen)
        {
            if (edge.Directive is null || edge.Target is null || edge.Coordinate is null || edge.Error is not null)
            {
                return Invalid("article_embed_publication_edge_invalid");
            }
        }
        else if (edge.Coordinate is not null || edge.Error is null)
        {
            return Invalid("article_embed_publication_edge_invalid");
        }
        if (!DigestEquals(edge.EdgeDigest, ArticleEmbedPublicationDigest.ComputeEdge(edge)))
        {
            return Invalid("article_embed_publication_edge_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static ArticleEmbedValidationResult ValidateFacts(ArticleEmbedPublicationTargetFacts? facts)
    {
        if (facts is null
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(facts.PortableArticleIdentity)
            || facts.SiteIdentity is null or ""
            || facts.AuthorityGeneration < 1
            || facts.ResolvedPublicRevision < 1
            || facts.LatestObservedRevision < facts.ResolvedPublicRevision
            || !Enum.IsDefined(facts.Visibility)
            || !Enum.IsDefined(facts.Lifecycle)
            || !Enum.IsDefined(facts.Permission)
            || !ArticleEmbedContractDigest.IsSha256(facts.PublicSourceDigest)
            || facts.TargetVersionIdentity is null or ""
            || !ArticleEmbedContractDigest.IsSha256(facts.RightsDigest)
            || facts.SourceByteCount < 0
            || facts.AttributionDisplayText is null
            || facts.AttributionDisplayText.Length > 512
            || !ValidateProjection(facts.BodyProjection)
            || facts.Headings is null
            || facts.Blocks is null
            || facts.NestedDirectives is null)
        {
            return Invalid("article_embed_publication_target_facts_invalid");
        }
        foreach (ArticleEmbedPublicationHeadingFact heading in facts.Headings)
        {
            if (heading is null
                || !ArticleEmbedTargetCodec.IsCanonicalHeadingIdentity(heading.HeadingIdentity)
                || !ValidateProjection(heading.SubtreeProjection))
            {
                return Invalid("article_embed_publication_heading_facts_invalid");
            }
        }
        foreach (ArticleEmbedPublicationBlockFact block in facts.Blocks)
        {
            if (block is null
                || !ArticleEmbedTargetCodec.IsCanonicalBlockAnchor(block.BlockAnchor)
                || !ValidateProjection(block.BlockProjection))
            {
                return Invalid("article_embed_publication_block_facts_invalid");
            }
        }
        foreach (ArticleEmbedDirectiveProjection directive in facts.NestedDirectives)
        {
            if (directive is null
                || directive.ParserContract != ArticleEmbedSchemas.ParserContract
                || directive.RawRange is null
                || directive.RawRange.Start < 0
                || directive.RawRange.End <= directive.RawRange.Start
                || !Enum.IsDefined(directive.Mode))
            {
                return Invalid("article_embed_publication_nested_directive_invalid");
            }
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static bool ValidateProjection(ArticleEmbedSafeProjectionReference? projection)
        => projection is not null
            && Enum.IsDefined(projection.Kind)
            && projection.ProjectionIdentity is not (null or "")
            && projection.ProjectionIdentity.Length <= 160
            && ArticleEmbedContractDigest.IsSha256(projection.ContentDigest);

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
