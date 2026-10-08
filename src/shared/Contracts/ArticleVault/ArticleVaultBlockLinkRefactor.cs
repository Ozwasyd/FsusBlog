using System.Globalization;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// One explicit current-draft route projection change, consumed after canonical relation
/// resolution. The target is supplied by #1808/#1868 and is never inferred from a slug.
/// </summary>
public sealed record ArticleVaultBlockLinkRefactorInput(
    ArticleVaultArticleManifest Manifest,
    ArticleRelationRecord Relation,
    ArticleBlockRouteProjection Before,
    ArticleBlockRouteProjection After,
    long ExpectedRevision);

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
        if (!ArticleVaultManifestValidator.Validate(input.Manifest).IsValid
            || !ArticleRelationContractValidator.Validate(input.Relation).IsValid
            || !BlockAnchorContractValidator.Validate(input.Before.Target).IsValid
            || !BlockAnchorContractValidator.Validate(input.After.Target).IsValid)
        {
            return Reject("vault_block_link_input_invalid");
        }

        ArticleVaultArticleManifest manifest = input.Manifest;
        ArticleRelationRecord relation = input.Relation;
        VaultArticleCoordinate server = manifest.Coordinates.Server;
        ArticleRelationTargetIdentity? target = relation.Target.TargetIdentity;
        if (relation.Kind != ArticleRelationKind.Outgoing
            || relation.Resolution != ArticleRelationResolutionStatus.Resolved
            || relation.Source.Permission != ArticleRelationPermissionState.Allowed
            || relation.Target.Permission != ArticleRelationPermissionState.Allowed
            || relation.Visibility.QueryScope != ArticleRelationQueryScope.Authoring)
        {
            return Reject("vault_block_link_target_unavailable");
        }

        if (input.ExpectedRevision < 1
            || server.ServerRevision != input.ExpectedRevision
            || server.Lifecycle != "draft"
            || !server.Present || server.Deleted
            || relation.Source.ArticleIdentity != manifest.PortableArticleIdentity
            || relation.Source.RevisionNumber != input.ExpectedRevision
            || relation.Source.RevisionKind != ArticleRelationRevisionKind.Draft
            || relation.Source.ContentDigest != server.Source?.Sha256
            || relation.Source.SourceActor.SiteIdentity != manifest.SiteIdentity
            || relation.Visibility.QueryActor.SiteIdentity != manifest.SiteIdentity
            || input.Before.Target != input.After.Target
            || target?.Kind != ArticleRelationTargetKind.Block
            || target.ArticleIdentity != input.Before.Target.ArticleIdentity
            || target.BlockAnchorIdentity != input.Before.Target.AnchorId.Value)
        {
            return Reject("vault_block_link_binding_mismatch");
        }

        if (!ArticleVaultManifestValidator.ValidateSourceBytes(server.Source!, sourceBytes).IsValid)
        {
            return Reject("vault_block_link_source_mismatch");
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

        ArticleRelationOccurrence occurrence = relation.Occurrence;
        ArticleRelationSourceRange range = occurrence.First;
        if (occurrence.Count != 1 || occurrence.First != occurrence.Last
            || range.End > source.Length
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
            writer.Add(relation.RecordDigest);
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
        => Propose(input, sourceBytes) == candidate;

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
