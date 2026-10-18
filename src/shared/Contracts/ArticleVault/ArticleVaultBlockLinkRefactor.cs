using System.Globalization;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// One explicit current-draft route projection change, consumed after canonical relation
/// resolution. CurrentRelations must be supplied by the canonical relation authority,
/// not reconstructed from caller ranges, routes or graph membership. A seal is not authorization.
/// </summary>
public sealed record ArticleVaultBlockLinkRefactorInput(
    ArticleVaultArticleManifest Manifest,
    PortableDependencyManifest Graph,
    IReadOnlyList<VaultDependencyNode> CurrentAuthorityNodes,
    IReadOnlyList<VaultDependencyEdge> CurrentAuthorityEdges,
    string CurrentRelationSha256,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleRelationSourceRange SourceRange,
    ArticleBlockRouteProjection Before,
    ArticleBlockRouteProjection After,
    long ExpectedRevision,
    ArticleRelationSet? CurrentRelations = null);

/// <summary>
/// An ephemeral expected-text replacement for a later canonical transaction. No source
/// mutation or relation write occurs here; blocked results contain no target facts.
/// </summary>
public sealed record ArticleVaultBlockLinkRewriteCandidate(
    bool Permitted,
    string? ReasonCode,
    ArticleBlockTarget? Target,
    int? Start,
    int? End,
    string? ExpectedText,
    string? Replacement,
    string? InputSha256,
    string ContentSha256);

/// <summary>Projects stable canonical block targets into explicit current-draft refactor candidates.</summary>
public static class ArticleVaultBlockLinkRefactor
{
    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);

    public static ArticleVaultBlockLinkRewriteCandidate Propose(
        ArticleVaultBlockLinkRefactorInput input,
        ReadOnlySpan<byte> sourceBytes)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (input.Graph is null || input.Before is null || input.After is null
            || !ArticleVaultManifestValidator.Validate(input.Manifest).IsValid
            || !ArticleRelationContractValidator.Validate(input.SourceRange).IsValid
            || !BlockAnchorContractValidator.Validate(input.Before.Target).IsValid
            || !BlockAnchorContractValidator.Validate(input.After.Target).IsValid)
        {
            return Reject("vault_block_link_input_invalid");
        }

        ArticleVaultArticleManifest manifest = input.Manifest;
        VaultArticleCoordinate server = manifest.Coordinates.Server;
        if (input.ExpectedRevision < 1
            || server.ServerRevision != input.ExpectedRevision
            || server.Lifecycle != "draft"
            || !server.Present || server.Deleted
            || input.Before.Target != input.After.Target
            || input.Graph.SourceSide != VaultDependencySourceSide.Server)
        {
            return Reject("vault_block_link_binding_mismatch");
        }

        if (!ArticleVaultManifestValidator.ValidateSourceBytes(server.Source!, sourceBytes).IsValid)
        {
            return Reject("vault_block_link_source_mismatch");
        }
        if (!PortableDependencyVerifier.VerifyCurrent(input.Graph, manifest, sourceBytes,
                input.CurrentAuthorityNodes, input.CurrentAuthorityEdges,
                input.CurrentRelationSha256, input.Budgets).IsValid)
        {
            return Reject("vault_block_link_target_unavailable");
        }
        VaultLinkDependency[] matches = input.Graph.Nodes.OfType<VaultLinkDependency>()
            .Where(node => node.Target.Kind == ArticleEmbedTargetKind.Block
                && node.Target.PortableArticleIdentity == input.Before.Target.ArticleIdentity
                && node.Target.BlockAnchor == input.Before.Target.AnchorId.Value).ToArray();
        if (matches.Length != 1)
        {
            return Reject("vault_block_link_target_unavailable");
        }

        ArticleRelationSet? relations = input.CurrentRelations;
        if (!ArticleRelationContractValidator.Validate(relations).IsValid
            || relations!.SetDigest != input.CurrentRelationSha256
            || relations.Source.ArticleIdentity != manifest.PortableArticleIdentity
            || relations.Source.RevisionNumber != input.ExpectedRevision
            || relations.Source.ContentDigest != server.Source!.Sha256
            || relations.Source.RevisionKind is not (ArticleRelationRevisionKind.Draft or ArticleRelationRevisionKind.Current)
            || relations.Source.Lifecycle != ArticleRelationLifecycleState.Draft
            || relations.Source.Permission != ArticleRelationPermissionState.Allowed
            || relations.Source.SourceActor.SiteIdentity != manifest.SiteIdentity)
        {
            return Reject("vault_block_link_occurrence_authority_unavailable");
        }

        ArticleRelationRecord[] occurrences = relations.Relations
            .Where(record => record.Kind == ArticleRelationKind.Outgoing
                && (record.Occurrence.First == input.SourceRange || record.Occurrence.Last == input.SourceRange))
            .ToArray();
        if (occurrences.Length != 1)
        {
            return Reject("vault_block_link_occurrence_authority_mismatch");
        }
        ArticleRelationRecord occurrence = occurrences[0];
        ArticleRelationTargetIdentity? target = occurrence.Target.TargetIdentity;
        if (occurrence.Resolution != ArticleRelationResolutionStatus.Resolved
            || occurrence.Target.Permission != ArticleRelationPermissionState.Allowed
            || occurrence.Visibility.QueryScope != ArticleRelationQueryScope.Authoring
            || occurrence.Visibility.PublicContext != ArticleRelationPublicContext.AuthoringActor
            || occurrence.Visibility.QueryActor.SiteIdentity != manifest.SiteIdentity
            || target is null || target.Kind != ArticleRelationTargetKind.Block
            || target.ArticleIdentity != input.Before.Target.ArticleIdentity
            || target.BlockAnchorIdentity != input.Before.Target.AnchorId.Value)
        {
            return Reject("vault_block_link_occurrence_authority_mismatch");
        }
        string source;
        try
        {
            source = s_strictUtf8.GetString(sourceBytes);
        }
        catch (DecoderFallbackException)
        {
            return Reject("vault_block_link_source_mismatch");
        }

        ArticleRelationSourceRange range = input.SourceRange;
        if (range.End > source.Length
            || source[range.Start..range.End] != range.MatchedText
            || !BlockAnchorMarkdownParser.TryParse(range.MatchedText, out BlockAnchorMarkdownLink? link).IsValid)
        {
            return Reject("vault_block_link_occurrence_ambiguous");
        }
        if (!BlockAnchorMarkdownBuilder.TryBuild(link!.DisplayText, input.Before.CanonicalSlug,
                input.Before.Target, out string? expectedText).IsValid
            || expectedText != range.MatchedText
            || !BlockAnchorMarkdownBuilder.TryBuild(link.DisplayText, input.After.CanonicalSlug,
                input.After.Target, out string? replacement).IsValid)
        {
            return Reject("vault_block_link_projection_mismatch");
        }

        string inputSha256 = BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(manifest.ContentSha256);
            writer.Add(input.Graph.ContentSha256);
            writer.Add(relations.SetDigest);
            writer.Add(occurrence.RecordDigest);
            writer.Add(input.ExpectedRevision.ToString(CultureInfo.InvariantCulture));
            writer.Add(input.Before.CanonicalSlug);
            writer.Add(input.After.CanonicalSlug);
        });
        var candidate = new ArticleVaultBlockLinkRewriteCandidate(
            true, null, input.Before.Target, range.Start, range.End, expectedText, replacement,
            inputSha256, string.Empty);
        return candidate with
        {
            ContentSha256 = ComputeCandidateSha256(candidate)
        };
    }

    /// <summary>Rechecks exact source and authority inputs before comparing every proposed transaction field.</summary>
    public static bool Verify(
        ArticleVaultBlockLinkRefactorInput input,
        ReadOnlySpan<byte> sourceBytes,
        ArticleVaultBlockLinkRewriteCandidate candidate)
        => candidate is { Permitted: true } && Propose(input, sourceBytes) == candidate;

    private static ArticleVaultBlockLinkRewriteCandidate Reject(string reasonCode)
    {
        var candidate = new ArticleVaultBlockLinkRewriteCandidate(
            false, reasonCode, null, null, null, null, null, null, string.Empty);
        return candidate with
        {
            ContentSha256 = ComputeCandidateSha256(candidate)
        };
    }

    private static string ComputeCandidateSha256(ArticleVaultBlockLinkRewriteCandidate candidate)
        => BlockAnchorContractDigest.Compute(writer =>
        {
            writer.Add(candidate.Permitted ? 1 : 0);
            writer.Add(candidate.ReasonCode);
            writer.Add(candidate.Target?.ArticleIdentity);
            writer.Add(candidate.Target?.AnchorId.Value);
            writer.Add(candidate.Start ?? -1);
            writer.Add(candidate.End ?? -1);
            writer.Add(candidate.ExpectedText);
            writer.Add(candidate.Replacement);
            writer.Add(candidate.InputSha256);
        });
}
