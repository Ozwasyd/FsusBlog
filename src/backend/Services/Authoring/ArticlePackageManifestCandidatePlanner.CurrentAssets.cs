using System.Security.Claims;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleVault;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Finite plan and actual read observations; no session credentials or package-operation grant.</summary>
public sealed record ArticlePackageCurrentAssetPlanResult(
    bool IsValid,
    string? ReasonCode,
    ArticlePackageManifestCandidatePlan? Plan,
    IReadOnlyList<ArticlePackageCurrentAssetObservation>? Observations);

public static partial class ArticlePackageManifestCandidatePlanner
{
    /// <summary>
    /// Reads through the original current article and upload asset producers before projecting the
    /// sole candidate plan. Re-observes permissions, coordinates, ledger and bytes after projection.
    /// Supplied portable mappings and property snapshots remain candidates. This is not complete
    /// ledger enumeration, an atomic export fence, or export/reuse/retention authority.
    /// </summary>
    public static Task<ArticlePackageCurrentAssetPlanResult> ReadCurrentAssetsAndCreateCandidatePlanAsync(
        IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageCurrentAssetRequest> requests,
        ClaimsPrincipal principal,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        IAuthoringArticleCurrentSourceReader articles,
        ArticlePackageCurrentAssetReader assets,
        CancellationToken cancellationToken = default,
        Action? requireCurrent = null)
        => ReadCurrentAssetsAndPlanAsync(null, false, inputs, requests, principal, inventory,
            articles, assets, cancellationToken, requireCurrent);

    /// <summary>
    /// Binds a backend-owned plan and its full asset record snapshots after fresh current observations,
    /// followed by another original authorized read of the complete selected closure.
    /// Original producer refusals and cancellation propagate without exposing a partial result.
    /// </summary>
    public static Task<ArticlePackageCurrentAssetPlanResult> ReadCurrentAssetsAndBindCandidatePlanAsync(
        ArticlePackageManifestCandidatePlan expected,
        IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageCurrentAssetRequest> requests,
        ClaimsPrincipal principal,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        IAuthoringArticleCurrentSourceReader articles,
        ArticlePackageCurrentAssetReader assets,
        CancellationToken cancellationToken = default,
        Action? requireCurrent = null)
        => ReadCurrentAssetsAndPlanAsync(expected, true, inputs, requests, principal, inventory,
            articles, assets, cancellationToken, requireCurrent);

    private static async Task<ArticlePackageCurrentAssetPlanResult> ReadCurrentAssetsAndPlanAsync(
        ArticlePackageManifestCandidatePlan? expected,
        bool bind,
        IReadOnlyList<ArticlePackageManifestCandidateInput> inputs,
        IReadOnlyList<ArticlePackageCurrentAssetRequest> requests,
        ClaimsPrincipal principal,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        IAuthoringArticleCurrentSourceReader articles,
        ArticlePackageCurrentAssetReader assets,
        CancellationToken cancellationToken,
        Action? requireCurrent)
    {
        ArgumentNullException.ThrowIfNull(principal);
        ArgumentNullException.ThrowIfNull(articles);
        ArgumentNullException.ThrowIfNull(assets);
        Guard();
        if (bind && expected?.Assets is null)
        {
            return RefuseCurrentAssets("input_invalid");
        }
        if (!principal.TryGetAdminPrincipalId(out long adminId) || !CurrentPrincipal())
        {
            return RefuseCurrentAssets("principal_invalid");
        }
        ArticlePackageManifestCandidateInput[] heldInputs;
        ArticlePackageCurrentAssetRequest[] heldRequests;
        ArticlePackageInventoryEntry[] heldInventory;
        try
        {
            if (!FreezeAssetInputs(inputs, ArticlePackageManifestCandidateCodec.MaxArticles, cancellationToken, out heldInputs)
                || !FreezeAssetInputs(requests, ArticlePackageManifestCandidateCodec.MaxAssetCollectionReferences, cancellationToken, out heldRequests)
                || !FreezeAssetInputs(inventory, ArticlePackageInventory.MaxEntries, cancellationToken, out heldInventory))
            {
                return RefuseCurrentAssets("input_invalid");
            }
        }
        catch (Exception exception) when (exception is ArgumentException or IndexOutOfRangeException)
        {
            return RefuseCurrentAssets("input_invalid");
        }
        var preflight = TryCreateCandidatePlan(heldInputs, out var articlePlan);
        if (!preflight.IsValid)
        {
            return new(false, preflight.ReasonCode, null, null);
        }
        try
        {
            for (int index = 0; index < heldInputs.Length; index++)
            {
                Guard();
                ArticlePackageManifestCandidateInput input = heldInputs[index];
                int count = input.Article.TagIds.Count;
                if (count < 0 || count > ArticlePackageTitleSummaryLimits.MaxTagIds)
                {
                    return RefuseCurrentAssets("input_invalid");
                }
                var tags = new int[count];
                for (int tag = 0; tag < count; tag++)
                {
                    tags[tag] = input.Article.TagIds[tag];
                }
                heldInputs[index] = new(input.Article with
                {
                    TagIds = tags
                }, input.TitleBinding,
                    input.PropertySnapshot, input.PropertyBindings, input.SourceBytes);
            }
        }
        catch (Exception exception) when (exception is ArgumentException or IndexOutOfRangeException)
        {
            return RefuseCurrentAssets("input_invalid");
        }
        var inventoryResult = ArticlePackageInventory.Validate(heldInventory);
        if (!inventoryResult.IsValid)
        {
            return new(false, inventoryResult.ReasonCode, null, null);
        }
        var byPortable = heldInputs.ToDictionary(static input => input.TitleBinding.PortableArticle);
        var before = new Dictionary<int, AuthoringArticleCurrentSource>();
        foreach (ArticlePackageManifestCandidateInput input in heldInputs)
        {
            AuthoringArticleCurrentSource? source = await ReadArticleAsync(input).ConfigureAwait(false);
            if (source is null)
            {
                return RefuseCurrentAssets("source_mismatch");
            }
            before.Add(input.Article.ArticleId, source);
        }
        foreach (ArticlePackageCurrentAssetRequest request in heldRequests)
        {
            Guard();
            if (request.Article is not { } coordinate
                || !byPortable.TryGetValue(coordinate.PortableArticle, out var input)
                || coordinate.ArticleId != input.Article.ArticleId
                || coordinate.SourceKind != RevisionCompareSourceKind.CurrentRevision
                || coordinate.RevisionId != input.Article.ArticleRevisionId
                || coordinate.Source != ArticleVaultManifestCodec.CaptureSourceBytes(input.SourceBytes)
                || coordinate.RevisionPackageSha256 != before[input.Article.ArticleId].Package.PackageDigest)
            {
                return RefuseCurrentAssets("coordinate_mismatch");
            }
        }
        Guard();
        ArticlePackageCurrentAssetInput observed = await assets.ReadCurrentRevisionInputAsync(
            heldRequests, principal, heldInventory, cancellationToken, Guard).ConfigureAwait(false);
        Guard();
        if (!CurrentPrincipal() || !ObservationsMatch(observed))
        {
            return RefuseCurrentAssets("observation_mismatch");
        }
        ArticlePackageManifestCandidateResult projected = bind
            ? TryBindCandidatePlanToSnapshot(expected!, heldInputs, observed.Sources, observed.Collection.References,
                heldInventory, out var plan, cancellationToken)
            : TryCreateCandidatePlan(heldInputs, observed.Sources, observed.Collection.References,
                heldInventory, out plan, cancellationToken);
        if (!projected.IsValid)
        {
            return new(false, projected.ReasonCode, null, null);
        }
        Guard();
        ArticlePackageCurrentAssetInput rechecked = await assets.ReadCurrentRevisionInputAsync(
            heldRequests, principal, heldInventory, cancellationToken, Guard).ConfigureAwait(false);
        Guard();
        if (!CurrentPrincipal() || !ObservationsMatch(rechecked)
            || !observed.Observations.SequenceEqual(rechecked.Observations))
        {
            return RefuseCurrentAssets("observation_changed");
        }
        foreach (ArticlePackageManifestCandidateInput input in heldInputs)
        {
            AuthoringArticleCurrentSource? source = await ReadArticleAsync(input).ConfigureAwait(false);
            AuthoringArticleCurrentSource previous = before[input.Article.ArticleId];
            if (source is null || source.Authority != previous.Authority
                || source.Package.PackageDigest != previous.Package.PackageDigest)
            {
                return RefuseCurrentAssets("source_changed");
            }
        }
        // Rebind all bytes and components after the final authorized observations. Caller-owned
        // property/tag changes during awaits must fail rather than becoming a newly frozen plan.
        var unchanged = TryBindCandidatePlan(articlePlan!.Manifest, heldInputs, out _);
        if (!unchanged.IsValid)
        {
            return new(false, unchanged.ReasonCode, null, null);
        }
        var rebound = TryBindCandidatePlanToSnapshot(plan!, heldInputs, rechecked.Sources,
            rechecked.Collection.References, heldInventory, out var finalPlan, cancellationToken);
        if (!rebound.IsValid)
        {
            return new(false, rebound.ReasonCode, null, null);
        }
        Guard();
        if (!CurrentPrincipal())
        {
            return RefuseCurrentAssets("principal_changed");
        }
        return new(true, null, finalPlan, Array.AsReadOnly(rechecked.Observations.ToArray()));

        bool CurrentPrincipal()
            => principal.Identity?.IsAuthenticated == true && principal.IsAdminPrincipal()
                && principal.TryGetAdminPrincipalId(out long current) && current == adminId;

        void Guard()
        {
            cancellationToken.ThrowIfCancellationRequested();
            requireCurrent?.Invoke();
            cancellationToken.ThrowIfCancellationRequested();
        }

        async Task<AuthoringArticleCurrentSource?> ReadArticleAsync(ArticlePackageManifestCandidateInput input)
        {
            Guard();
            if (!CurrentPrincipal() || input.PropertySnapshot.Coordinates.DefinitionOwnerUserId != adminId)
            {
                return null;
            }
            var owner = new AuthoringCanvasOwner(adminId, input.PropertySnapshot.Coordinates.SiteScope);
            Guid requestId = Guid.CreateVersion7();
            var read = await articles.ReadCurrentAuthorizedAsync(owner, input.Article.ArticleId,
                requestId, cancellationToken).ConfigureAwait(false);
            Guard();
            if (!CurrentPrincipal() || read.Status != RevisionComparePackageReadStatus.Available
                || read.Source is not { } source || source.Owner != owner || source.RequestId != requestId
                || !source.Authority.Authorized || !RevisionComparePackageSeal.Verify(source.Package)
                || source.Article.ArticleId != input.Article.ArticleId
                || source.Article.CurrentRevision != input.Article.ArticleRevisionId
                || source.Package.ArticleId != input.Article.ArticleId
                || source.Package.SourceKind != RevisionCompareSourceKind.CurrentRevision
                || source.Package.RevisionId != input.Article.ArticleRevisionId
                || source.Package.RevisionNo != input.Article.RevisionNo
                || !source.Package.RawMarkdown.AsSpan().SequenceEqual(input.SourceBytes)
                || !CurrentMetadataMatches(input, source.Package))
            {
                return null;
            }
            return source;
        }

        bool ObservationsMatch(ArticlePackageCurrentAssetInput value)
        {
            if (value.Observations.Count != heldRequests.Length)
            {
                return false;
            }
            var requestsByEdge = heldRequests.ToDictionary(static request => new ArticlePackageManifestAssetReference(
                request.Article.PortableArticle, request.PortableAsset));
            foreach (ArticlePackageCurrentAssetObservation observation in value.Observations)
            {
                var edge = new ArticlePackageManifestAssetReference(observation.Article.PortableArticle, observation.PortableAsset);
                if (!requestsByEdge.Remove(edge, out var request) || observation.Article != request.Article
                    || observation.Observation.AdminPrincipalId != adminId
                    || observation.Observation.ArticlePermissionScope != byPortable[edge.PortableArticle].PropertySnapshot.Coordinates.SiteScope
                    || observation.Observation.Reference.ArticleId != request.Article.ArticleId
                    || observation.Observation.Reference.SourceRevision != request.Article.RevisionId
                    || observation.Observation.Reference.SourceSha256 != request.Article.Source.Sha256
                    || observation.Observation.Reference.AssetId != request.AssetId
                    || observation.Observation.Source != request.Article.Source
                    || observation.Observation.RevisionPackageSha256 != request.Article.RevisionPackageSha256
                    || observation.Observation.Asset.Sha256 != request.Sha256)
                {
                    return false;
                }
            }
            return requestsByEdge.Count == 0 && ArticlePackageAssetCollectionMapper.ValidateCandidate(
                value.Collection, value.Sources, value.Collection.References, heldInventory).IsValid;
        }
    }

    private static bool CurrentMetadataMatches(ArticlePackageManifestCandidateInput input, RevisionComparePackage package)
    {
        RevisionCompareMetadataValue[] expected =
        [
            RevisionCompareMetadataRegistry.String("title", input.Article.Title),
            RevisionCompareMetadataRegistry.NullableString("summary", input.Article.Summary),
            RevisionCompareMetadataRegistry.NullableString("cover-image-url", input.Article.CoverImageUrl),
            RevisionCompareMetadataRegistry.Int32("category-id", input.Article.CategoryId),
            RevisionCompareMetadataRegistry.Int32List("tag-ids", input.Article.TagIds)
        ];
        return expected.OrderBy(static row => row.FieldId, StringComparer.Ordinal)
            .SequenceEqual(package.Metadata.OrderBy(static row => row.FieldId, StringComparer.Ordinal));
    }

    private static ArticlePackageCurrentAssetPlanResult RefuseCurrentAssets(string reason)
        => new(false, "article_package_manifest_current_asset_" + reason, null, null);
}
