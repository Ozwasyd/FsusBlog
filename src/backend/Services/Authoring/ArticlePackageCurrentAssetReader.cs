using System.Security.Claims;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Explicit portable mapping and frozen source assertions from the caller's article source producer.
/// The supplier re-observes current authorization and coordinates; this record grants no permission.
/// </summary>
public sealed record ArticlePackageCurrentAssetArticle(
    ArticlePackageIdentity PortableArticle,
    int ArticleId,
    RevisionCompareSourceKind SourceKind,
    long RevisionId,
    VaultSourceByteIdentity Source,
    string RevisionPackageSha256);

/// <summary>
/// One explicit ledger edge and its original upload access. Session credentials are read inputs only;
/// they must never enter a package, observation, receipt or log. Missing sessions have no fallback.
/// </summary>
public sealed record ArticlePackageCurrentAssetRequest(
    ArticlePackageCurrentAssetArticle Article,
    ArticlePackageIdentity PortableAsset,
    AssetId AssetId,
    string Sha256,
    UploadSessionAccess? Session);

/// <summary>Caller mapping bound to an actual supplier observation, without upload credentials.</summary>
public sealed record ArticlePackageCurrentAssetObservation(
    ArticlePackageCurrentAssetArticle Article,
    ArticlePackageIdentity PortableAsset,
    CurrentArticleUploadAssetObservation Observation);

/// <summary>
/// Original byte inputs and their finite collection projection. This does not enumerate a complete
/// revision ledger, admit export, or grant rights, reuse, accepted references or retention.
/// The planner remains responsible for selecting the complete frozen asset set and inventory.
/// </summary>
public sealed class ArticlePackageCurrentAssetInput
{
    internal ArticlePackageCurrentAssetInput(
        ArticlePackageManifestAssetCollectionCandidate collection,
        ArticlePackageAssetCollectionSource[] sources,
        ArticlePackageCurrentAssetObservation[] observations)
    {
        Collection = collection;
        Sources = Array.AsReadOnly(sources);
        Observations = Array.AsReadOnly(observations);
    }

    public ArticlePackageManifestAssetCollectionCandidate Collection
    {
        get;
    }
    public IReadOnlyList<ArticlePackageAssetCollectionSource> Sources
    {
        get;
    }
    public IReadOnlyList<ArticlePackageCurrentAssetObservation> Observations
    {
        get;
    }
}

public sealed class ArticlePackageCurrentAssetRejectedException(string reasonCode) : Exception(reasonCode)
{
    public string ReasonCode { get; } = reasonCode;
}

/// <summary>
/// The package adapter for the original current-revision upload supplier. It never opens files,
/// queries another ledger, parses Markdown, fetches URLs, or manufactures session or permission facts.
/// Historical/draft/publication sources and assets without original owned sessions are unsupported.
/// </summary>
public sealed class ArticlePackageCurrentAssetReader(CurrentArticleUploadAssetBindingReader assets)
{
    public async Task<ArticlePackageCurrentAssetInput> ReadCurrentRevisionInputAsync(
        IReadOnlyList<ArticlePackageCurrentAssetRequest> requests,
        ClaimsPrincipal principal,
        IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        CancellationToken cancellationToken = default,
        Action? requireCurrent = null)
    {
        ArgumentNullException.ThrowIfNull(principal);
        RequireCurrent();
        if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminId))
        {
            throw Rejected("input_invalid");
        }
        ArticlePackageCurrentAssetRequest[] heldRequests = Freeze(requests,
            ArticlePackageManifestCandidateCodec.MaxAssetCollectionReferences);
        ArticlePackageInventoryEntry[] heldInventory = Freeze(inventory, ArticlePackageInventory.MaxEntries);
        var inventoryResult = ArticlePackageInventory.Validate(heldInventory);
        if (!inventoryResult.IsValid)
        {
            throw new ArticlePackageCurrentAssetRejectedException(inventoryResult.ReasonCode!);
        }
        var articleLengths = heldInventory.ToDictionary(static entry => entry.Path,
            static entry => entry.UncompressedBytes, StringComparer.Ordinal);
        var articleMappings = new Dictionary<ArticlePackageIdentity, ArticlePackageCurrentAssetArticle>();
        var articleIds = new Dictionary<int, ArticlePackageIdentity>();
        var assetMappings = new Dictionary<ArticlePackageIdentity, (AssetId Id, string Sha256)>();
        var assetIds = new Dictionary<AssetId, ArticlePackageIdentity>();
        var edges = new HashSet<ArticlePackageManifestAssetReference>();
        foreach (ArticlePackageCurrentAssetRequest request in heldRequests)
        {
            RequireCurrent();
            ArticlePackageCurrentAssetArticle article = request.Article
                ?? throw Rejected("input_invalid");
            if (article.SourceKind != RevisionCompareSourceKind.CurrentRevision)
            {
                throw Rejected("source_unsupported");
            }
            if (request.Session is not { } session || string.IsNullOrWhiteSpace(session.UploadId)
                || string.IsNullOrWhiteSpace(session.UploadToken))
            {
                throw Rejected("upload_session_unsupported");
            }
            if (!Identity(article.PortableArticle, ArticlePackageIdentityKind.Article)
                || !Identity(request.PortableAsset, ArticlePackageIdentityKind.Asset)
                || article.ArticleId <= 0 || article.RevisionId <= 0 || article.Source is null
                || article.Source.ByteLength < 0 || !Digest(article.Source.Sha256)
                || !Digest(article.RevisionPackageSha256) || !Digest(request.Sha256)
                || request.AssetId.Value == Guid.Empty || session.OwnerAdminPrincipalId != adminId)
            {
                throw Rejected("input_invalid");
            }
            if (!articleLengths.TryGetValue("articles/" + article.PortableArticle.FileNameToken + ".md", out long sourceLength)
                || sourceLength != article.Source.ByteLength
                || articleMappings.TryGetValue(article.PortableArticle, out var priorArticle) && priorArticle != article
                || articleIds.TryGetValue(article.ArticleId, out var priorArticleId) && priorArticleId != article.PortableArticle
                || assetMappings.TryGetValue(request.PortableAsset, out var priorAsset) && priorAsset != (request.AssetId, request.Sha256)
                || assetIds.TryGetValue(request.AssetId, out var priorAssetId) && priorAssetId != request.PortableAsset)
            {
                throw Rejected("binding_mismatch");
            }
            if (!edges.Add(new(article.PortableArticle, request.PortableAsset)))
            {
                throw Rejected("duplicate_reference");
            }
            articleMappings.TryAdd(article.PortableArticle, article);
            articleIds.TryAdd(article.ArticleId, article.PortableArticle);
            assetMappings.TryAdd(request.PortableAsset, (request.AssetId, request.Sha256));
            assetIds.TryAdd(request.AssetId, request.PortableAsset);
        }
        if (assetMappings.Count > ArticlePackageInventory.MaxAssets)
        {
            throw Rejected("input_invalid");
        }
        Array.Sort(heldRequests, static (left, right) =>
        {
            int article = string.CompareOrdinal(left.Article.PortableArticle.Value, right.Article.PortableArticle.Value);
            return article != 0 ? article : string.CompareOrdinal(left.PortableAsset.Value, right.PortableAsset.Value);
        });
        var sources = new Dictionary<AssetId, ArticlePackageAssetCollectionSource>();
        var observedAssets = new Dictionary<AssetId, CurrentArticleUploadAssetObservation>();
        var observedArticles = new Dictionary<int, CurrentArticleUploadAssetObservation>();
        var observations = new ArticlePackageCurrentAssetObservation[heldRequests.Length];
        long totalBytes = 0;
        for (int index = 0; index < heldRequests.Length; index++)
        {
            ArticlePackageCurrentAssetRequest request = heldRequests[index];
            ArticlePackageCurrentAssetArticle article = request.Article;
            var reference = new CurrentArticleUploadAssetReference(article.ArticleId, article.RevisionId,
                article.Source.Sha256, request.AssetId);
            var input = await assets.ReadCurrentRevisionInputAsync(reference, principal, request.Session!.Value,
                request.Sha256, cancellationToken, requireCurrent).ConfigureAwait(false);
            RequireCurrent();
            CurrentArticleUploadAssetObservation observed = input.Observation;
            if (observed.Source != article.Source || observed.RevisionPackageSha256 != article.RevisionPackageSha256)
            {
                throw Rejected("source_binding_mismatch");
            }
            if (observedArticles.TryGetValue(article.ArticleId, out var previousArticle)
                && (previousArticle.ArticlePermissionSha256 != observed.ArticlePermissionSha256
                    || previousArticle.ArticlePermissionScope != observed.ArticlePermissionScope
                    || previousArticle.AdminPrincipalId != observed.AdminPrincipalId))
            {
                throw Rejected("current_facts_changed");
            }
            observedArticles.TryAdd(article.ArticleId, observed);
            if (observedAssets.TryGetValue(request.AssetId, out var previous))
            {
                if (previous.Asset != observed.Asset || previous.AssetVersionSha256 != observed.AssetVersionSha256
                    || previous.ReferenceLedgerSha256 != observed.ReferenceLedgerSha256)
                {
                    throw Rejected("current_facts_changed");
                }
            }
            else
            {
                if (input.Bytes.Length > ArticlePackageAssetCollectionMapper.MaxCandidateCollectionBytes - totalBytes)
                {
                    throw Rejected("byte_budget_exceeded");
                }
                totalBytes += input.Bytes.Length;
                sources.Add(request.AssetId, new(request.PortableAsset, observed.Asset, input.Bytes));
                observedAssets.Add(request.AssetId, observed);
            }
            observations[index] = new(article, request.PortableAsset, observed);
        }
        ArticlePackageAssetCollectionSource[] sourceInputs = sources.Values
            .OrderBy(static source => source.PortableAsset.Value, StringComparer.Ordinal).ToArray();
        RequireCurrent();
        ArticlePackageManifestCandidateResult result = ArticlePackageAssetCollectionMapper.TryMapCandidate(
            sourceInputs, edges.ToArray(), heldInventory, out var collection);
        RequireCurrent();
        if (!result.IsValid)
        {
            throw new ArticlePackageCurrentAssetRejectedException(result.ReasonCode!);
        }
        if (principal.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long currentAdminId) || currentAdminId != adminId)
        {
            throw Rejected("current_facts_changed");
        }
        return new(collection!, sourceInputs, observations);

        void RequireCurrent()
        {
            cancellationToken.ThrowIfCancellationRequested();
            requireCurrent?.Invoke();
        }
    }

    private static T[] Freeze<T>(IReadOnlyList<T>? values, int maximum) where T : class
    {
        if (values is null)
        {
            throw Rejected("input_invalid");
        }
        try
        {
            int count = values.Count;
            if (count < 0 || count > maximum)
            {
                throw Rejected("input_invalid");
            }
            var held = new T[count];
            for (int index = 0; index < count; index++)
            {
                held[index] = values[index] ?? throw Rejected("input_invalid");
            }
            return held;
        }
        catch (Exception exception) when (exception is ArgumentException or IndexOutOfRangeException)
        {
            throw Rejected("input_invalid");
        }
    }

    private static bool Identity(ArticlePackageIdentity identity, ArticlePackageIdentityKind kind)
        => identity.Kind == kind && ArticlePackageIdentity.TryCreate(kind, identity.Value, out _).IsValid;

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static ArticlePackageCurrentAssetRejectedException Rejected(string reason)
        => new("article_package_current_asset_" + reason);
}
