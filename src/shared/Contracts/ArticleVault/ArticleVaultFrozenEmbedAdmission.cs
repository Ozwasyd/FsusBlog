using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Ephemeral three-way input for one already parsed embed occurrence. The canonical
/// manifest and #1869 resolution remain the identity, permission and budget authorities.
/// This is not a graph schema, resolver, writer or publication command.
/// </summary>
public sealed record ArticleVaultFrozenEmbedInput(
    ArticleVaultArticleManifest Manifest,
    ArticleEmbedProviderRequest Request,
    ArticleEmbedAuthoritySnapshot Authority,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleEmbedAuthoringResolution Resolution,
    ArticleEmbedDependencyCoordinate Base,
    ArticleEmbedDependencyCoordinate Local,
    ArticleEmbedDependencyCoordinate Server,
    bool ExplicitDraftRefresh);

/// <summary>
/// Coordinate-only candidate. It deliberately carries no target source, title, HTML
/// or cached projection. Rejected outcomes carry no target coordinate or input digest.
/// A permitted candidate still needs the #2124 plan and #2128 expected-revision writer.
/// </summary>
public sealed record ArticleVaultFrozenEmbedCandidate(
    bool Permitted,
    string? ReasonCode,
    ArticleEmbedDependencyCoordinate? Before,
    ArticleEmbedDependencyCoordinate? After,
    string? InputSha256,
    string ContentSha256,
    ArticleVaultFrozenEmbedProvenance? Provenance = null);

/// <summary>
/// Keeps the canonical parsed occurrence and authority/budget results with the coordinate proposal.
/// It carries no target body, title or projection cache and grants no writer admission.
/// </summary>
public sealed record ArticleVaultFrozenEmbedProvenance(
    string SiteIdentity,
    string VaultIdentity,
    string HostPortableArticleIdentity,
    long ExpectedSourceRevision,
    string SourceSha256,
    ArticleEmbedSourceRange SourceRange,
    string RequestSha256,
    string AuthoritySha256,
    string ResolutionSha256,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleEmbedBudgetObservation Observed);

/// <summary>
/// Compares canonical frozen coordinates without parsing source or resolving latest.
/// Public/current published host coordinates are immutable in this admission path.
/// </summary>
public static class ArticleVaultFrozenEmbedAdmission
{
    public static ArticleVaultFrozenEmbedCandidate Compare(ArticleVaultFrozenEmbedInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (!ArticleVaultManifestValidator.Validate(input.Manifest).IsValid
            || !ArticleEmbedContractValidator.Validate(input.Request).IsValid
            || !ArticleEmbedContractValidator.Validate(input.Base).IsValid
            || !ArticleEmbedContractValidator.Validate(input.Local).IsValid
            || !ArticleEmbedContractValidator.Validate(input.Server).IsValid)
        {
            return Reject("vault_embed_input_invalid");
        }

        ArticleVaultArticleManifest manifest = input.Manifest;
        VaultArticleCoordinate server = manifest.Coordinates.Server;
        if (!manifest.Coordinates.Base.Present
            || !manifest.Coordinates.Local.Present
            || !server.Present
            || manifest.Coordinates.Base.Deleted
            || manifest.Coordinates.Local.Deleted
            || server.Deleted
            || input.Request.HostPortableArticleIdentity != manifest.PortableArticleIdentity
            || input.Request.Actor.SiteIdentity != manifest.SiteIdentity
            || input.Request.SourceRevision != server.ServerRevision
            || input.Request.ContentDigest != server.Source?.Sha256
            || input.Base.Target != input.Request.Target
            || input.Local.Target != input.Request.Target
            || input.Server.Target != input.Request.Target)
        {
            return Reject("vault_embed_source_binding_mismatch");
        }

        ArticleEmbedAuthoringVerification verification = ArticleEmbedAuthoringVerifier.Verify(
            [input.Request], input.Authority, input.Budgets, input.Resolution);
        if (!verification.Valid
            || input.Resolution.Status != ArticleEmbedAuthoringResolutionStatus.Completed
            || input.Resolution.Results.Count != 1)
        {
            return Reject("vault_embed_authority_invalid");
        }

        ArticleEmbedAuthoringEmbedResult resolved = input.Resolution.Results[0];
        if (resolved.Result.Status != ArticleEmbedProviderResultStatus.Resolved
            || resolved.Result.Permission != ArticleEmbedPermissionStatus.Allowed
            || resolved.Result.Visibility != ArticleEmbedVisibilityStatus.Public
            || resolved.Result.Lifecycle != ArticleEmbedLifecycleStatus.Published
            || resolved.Eligibility != ArticleEmbedPublicationEligibility.PublicationEligible)
        {
            return Reject("vault_embed_target_unavailable");
        }

        ArticleEmbedDependencyCoordinate selected;
        if (server.Lifecycle == "published")
        {
            if (input.ExplicitDraftRefresh || input.Local != input.Base || input.Server != input.Base)
            {
                return Reject("vault_embed_published_coordinate_drift");
            }
            selected = input.Base;
        }
        else if (server.Lifecycle == "draft")
        {
            if (input.Local == input.Base)
            {
                selected = input.Server;
            }
            else if (input.Server == input.Base || input.Local == input.Server)
            {
                selected = input.Local;
            }
            else
            {
                return Reject("vault_embed_coordinate_overlap");
            }
            if (selected != input.Base && !input.ExplicitDraftRefresh)
            {
                return Reject("vault_embed_explicit_refresh_required");
            }
        }
        else
        {
            return Reject("vault_embed_host_not_editable");
        }

        if (resolved.Result.Coordinate != selected)
        {
            return Reject("vault_embed_exact_coordinate_unavailable");
        }

        string inputSha256 = ComputeInputSha256(input);
        var provenance = new ArticleVaultFrozenEmbedProvenance(manifest.SiteIdentity, manifest.VaultIdentity,
            manifest.PortableArticleIdentity, input.Request.SourceRevision, input.Request.ContentDigest,
            input.Request.Directive.RawRange, input.Request.RequestDigest, input.Authority.SnapshotDigest,
            input.Resolution.ResolutionDigest, input.Budgets, input.Resolution.Receipt.Observed);
        var candidate = new ArticleVaultFrozenEmbedCandidate(
            true, null, input.Base, selected, inputSha256, string.Empty, provenance);
        return candidate with
        {
            ContentSha256 = ComputeCandidateSha256(candidate)
        };
    }

    /// <summary>
    /// Re-admits current authority and all three inputs before comparing every candidate
    /// field. This local check supplements, rather than replaces, canonical syntax/graph verification.
    /// </summary>
    public static bool Verify(ArticleVaultFrozenEmbedInput input, ArticleVaultFrozenEmbedCandidate candidate)
        => candidate is { Permitted: true } && Compare(input) == candidate;

    /// <summary>
    /// Binds an admitted current-source coordinate to the real #2124 graph and freshly
    /// supplied authority projections. Different revisions remain different dependencies.
    /// This check is read-only and cannot refresh a publication or materialize a target.
    /// </summary>
    public static ArticleVaultValidationResult VerifyGraph(
        ArticleVaultFrozenEmbedInput input,
        ArticleVaultFrozenEmbedCandidate candidate,
        PortableDependencyManifest graph,
        ReadOnlySpan<byte> sourceBytes,
        IReadOnlyList<VaultDependencyNode> currentAuthorityNodes,
        IReadOnlyList<VaultDependencyEdge> currentAuthorityEdges,
        string currentRelationSha256)
    {
        if (graph is null || candidate is null || !candidate.Permitted || !Verify(input, candidate)
            || !PortableDependencyVerifier.VerifyCurrent(graph, input.Manifest, sourceBytes,
                currentAuthorityNodes, currentAuthorityEdges, currentRelationSha256, input.Budgets).IsValid
            || graph.SourceSide != VaultDependencySourceSide.Server
            || graph.Source.Sha256 != input.Request.ContentDigest)
        {
            return ArticleVaultValidationResult.Invalid("vault_embed_graph_unavailable");
        }
        int matches = graph.Nodes.OfType<VaultFrozenEmbedDependency>()
            .Count(node => node.Coordinate == candidate.After);
        return matches == 1
            ? ArticleVaultValidationResult.Valid()
            : ArticleVaultValidationResult.Invalid("vault_embed_graph_exact_coordinate_missing");
    }

    private static ArticleVaultFrozenEmbedCandidate Reject(string reasonCode)
    {
        var candidate = new ArticleVaultFrozenEmbedCandidate(false, reasonCode, null, null, null, string.Empty);
        return candidate with
        {
            ContentSha256 = ComputeCandidateSha256(candidate)
        };
    }

    private static string ComputeInputSha256(ArticleVaultFrozenEmbedInput input)
        => ArticleEmbedContractDigest.Compute(writer =>
        {
            writer.Add(input.Manifest.ContentSha256);
            writer.Add(input.Request.RequestDigest);
            writer.Add(input.Authority.SnapshotDigest);
            writer.Add(input.Resolution.ResolutionDigest);
            writer.Add(input.Base.DependencyDigest);
            writer.Add(input.Local.DependencyDigest);
            writer.Add(input.Server.DependencyDigest);
            writer.Add(input.ExplicitDraftRefresh);
            writer.Add(input.Budgets.MaxDepth);
            writer.Add(input.Budgets.MaxExpandedNodes);
            writer.Add(input.Budgets.MaxSourceBytes);
            writer.Add(input.Budgets.MaxElapsedMilliseconds);
            writer.Add(input.Budgets.MaxAuthorityMessages);
        });

    private static string ComputeCandidateSha256(ArticleVaultFrozenEmbedCandidate candidate)
        => ArticleEmbedContractDigest.Compute(writer =>
        {
            writer.Add(candidate.Permitted);
            writer.Add(candidate.ReasonCode);
            writer.Add(candidate.Before?.DependencyDigest);
            writer.Add(candidate.After?.DependencyDigest);
            writer.Add(candidate.InputSha256);
            writer.Add(candidate.Provenance is null ? null : ArticleVaultManifestCodec.ComputeSha256(
                ArticleVaultManifestCodec.SerializeCanonical(candidate.Provenance)));
        });
}
