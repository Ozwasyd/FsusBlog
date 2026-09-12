using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Fail-closed validation and sealing for the authoring authority snapshot and resolution artifacts.</summary>
public static class ArticleEmbedAuthoringContractValidator
{
    public static ArticleEmbedAuthoritySnapshot Seal(ArticleEmbedAuthoritySnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArticleEmbedAuthoritySnapshot unsigned = snapshot with
        {
            SnapshotDigest = string.Empty
        };
        return unsigned with
        {
            SnapshotDigest = ArticleEmbedAuthoringDigest.ComputeSnapshot(unsigned)
        };
    }

    public static ArticleEmbedValidationResult ValidateBudgets(ArticleEmbedResolutionBudgetLimits? budgets)
    {
        if (budgets is null
            || budgets.MaxDepth < 1
            || budgets.MaxDepth > ArticleEmbedResolutionBudgetLimits.DepthBound
            || budgets.MaxExpandedNodes < 1
            || budgets.MaxExpandedNodes > ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound
            || budgets.MaxSourceBytes < 1
            || budgets.MaxSourceBytes > ArticleEmbedResolutionBudgetLimits.SourceBytesBound
            || budgets.MaxElapsedMilliseconds < 1
            || budgets.MaxElapsedMilliseconds > ArticleEmbedResolutionBudgetLimits.ElapsedMillisecondsBound
            || budgets.MaxAuthorityMessages < 1
            || budgets.MaxAuthorityMessages > ArticleEmbedResolutionBudgetLimits.AuthorityMessagesBound)
        {
            return ArticleEmbedValidationResult.Invalid("article_embed_authoring_budgets_out_of_bounds");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedAuthoritySnapshot? snapshot)
    {
        if (snapshot is null)
        {
            return Invalid("article_embed_authority_snapshot_missing");
        }
        if (snapshot.Schema != ArticleEmbedAuthoringSchemas.AuthoritySnapshot
            || snapshot.SchemaVersion != ArticleEmbedAuthoringSchemas.Version)
        {
            return Invalid("article_embed_authority_snapshot_schema_unknown");
        }
        if (!ArticleEmbedTargetCodec.IsPortableArticleIdentity(snapshot.HostPortableArticleIdentity)
            || snapshot.HostDocument is null
            || snapshot.HostDocument.Id is null or ""
            || snapshot.HostDocument.Epoch < 1
            || snapshot.HostSourceRevision < 1
            || !ArticleEmbedContractDigest.IsSha256(snapshot.HostSourceDigest)
            || snapshot.AuthorityGeneration < 1)
        {
            return Invalid("article_embed_authority_host_coordinate_invalid");
        }
        if (snapshot.Actor is null
            || snapshot.Actor.ActorIdentity is null or ""
            || snapshot.Actor.SiteIdentity is null or ""
            || !ArticleEmbedContractDigest.IsSha256(snapshot.Actor.PermissionContextDigest))
        {
            return Invalid("article_embed_authority_actor_invalid");
        }
        if (snapshot.Runtime is null
            || snapshot.Runtime.ProviderId is null or ""
            || snapshot.Runtime.ProviderVersion < 1
            || snapshot.Runtime.RuntimeVersion != ArticleEmbedSchemas.ProviderRuntime
            || !ArticleEmbedContractDigest.IsSha256(snapshot.Runtime.RuntimeDigest))
        {
            return Invalid("article_embed_authority_runtime_invalid");
        }
        if (snapshot.Targets is null)
        {
            return Invalid("article_embed_authority_targets_missing");
        }
        foreach (ArticleEmbedTargetFacts facts in snapshot.Targets)
        {
            ArticleEmbedValidationResult target = ValidateFacts(facts);
            if (!target.IsValid)
            {
                return target;
            }
        }
        if (!DigestEquals(snapshot.SnapshotDigest, ArticleEmbedAuthoringDigest.ComputeSnapshot(snapshot)))
        {
            return Invalid("article_embed_authority_snapshot_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedAuthoringResolution? resolution)
    {
        if (resolution is null)
        {
            return Invalid("article_embed_authoring_resolution_missing");
        }
        if (resolution.Schema != ArticleEmbedAuthoringSchemas.Resolution
            || resolution.SchemaVersion != ArticleEmbedAuthoringSchemas.Version
            || !Enum.IsDefined(resolution.Status)
            || resolution.Receipt is null
            || resolution.Results is null)
        {
            return Invalid("article_embed_authoring_resolution_invalid");
        }
        if (resolution.Status == ArticleEmbedAuthoringResolutionStatus.Rejected)
        {
            if (resolution.RejectedReasonCode is null || resolution.Results.Count != 0)
            {
                return Invalid("article_embed_authoring_resolution_invalid");
            }
        }
        else if (resolution.RejectedReasonCode is not null)
        {
            return Invalid("article_embed_authoring_resolution_invalid");
        }
        if (!DigestEquals(resolution.Receipt.ReceiptDigest, ArticleEmbedAuthoringDigest.ComputeReceipt(resolution.Receipt))
            || !DigestEquals(resolution.ResolutionDigest, ArticleEmbedAuthoringDigest.ComputeResolution(resolution)))
        {
            return Invalid("article_embed_authoring_resolution_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static ArticleEmbedValidationResult ValidateFacts(ArticleEmbedTargetFacts? facts)
    {
        if (facts is null
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(facts.PortableArticleIdentity)
            || facts.SiteIdentity is null or ""
            || facts.AuthorityGeneration < 1
            || facts.ResolvedRevision < 1
            || facts.SourceRevision < 1
            || facts.LatestObservedRevision < facts.ResolvedRevision
            || !Enum.IsDefined(facts.Visibility)
            || !Enum.IsDefined(facts.Lifecycle)
            || !Enum.IsDefined(facts.Permission)
            || !ArticleEmbedContractDigest.IsSha256(facts.SourceDigest)
            || facts.TargetVersionIdentity is null or ""
            || facts.SourceByteCount < 0
            || facts.AttributionDisplayText is null
            || facts.AttributionDisplayText.Length > 512
            || !ValidateProjection(facts.BodyProjection)
            || facts.Headings is null
            || facts.Blocks is null
            || facts.NestedDirectives is null)
        {
            return Invalid("article_embed_authority_target_facts_invalid");
        }
        foreach (ArticleEmbedHeadingFact heading in facts.Headings)
        {
            if (heading is null
                || !ArticleEmbedTargetCodec.IsCanonicalHeadingIdentity(heading.HeadingIdentity)
                || !ValidateProjection(heading.SubtreeProjection))
            {
                return Invalid("article_embed_authority_heading_facts_invalid");
            }
        }
        foreach (ArticleEmbedBlockFact block in facts.Blocks)
        {
            if (block is null
                || !ArticleEmbedTargetCodec.IsCanonicalBlockAnchor(block.BlockAnchor)
                || !ValidateProjection(block.BlockProjection))
            {
                return Invalid("article_embed_authority_block_facts_invalid");
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
                return Invalid("article_embed_authority_nested_directive_invalid");
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
