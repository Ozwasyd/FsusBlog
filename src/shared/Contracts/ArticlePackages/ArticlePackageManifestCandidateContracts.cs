namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Supplied source coordinates only; these fields do not prove a stored revision exists.</summary>
public sealed record ArticlePackageManifestSource(
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    string CanonicalHash,
    string SiteScope,
    long PropertyRevision,
    long? DraftId,
    long? DraftServerRevision,
    long? PublicationId);

/// <summary>Historical source lifecycle facts; this projection is never an article write target.</summary>
public sealed record ArticlePackageManifestLifecycle(
    int Status,
    DateTime? PublishedAt,
    DateTime? ScheduledPublishAt);

/// <summary>
/// Finite manifest-candidate fields. Digest-shaped coordinates and byte metadata must still be bound
/// to actual canonical inputs and bytes; syntax, privacy and complete metadata authorities are absent.
/// </summary>
public sealed record ArticlePackageManifestArticle(
    ArticlePackageIdentity PortableArticle,
    ArticlePackageManifestSource Source,
    string Title,
    string? Summary,
    string TitleSummaryDigest,
    string PropertySnapshotDigest,
    string PropertyMappingDigest,
    ArticlePackageByteMetadata SourceBytes,
    ArticlePackageManifestLifecycle Lifecycle);

/// <summary>Fixed, content-free candidate-codec result; success is not full package admission.</summary>
public readonly record struct ArticlePackageManifestCandidateResult(bool IsValid, string? ReasonCode);

/// <summary>
/// Owned immutable article-set candidate. Its digest covers only this finite schema, not a complete
/// accepted package, persisted observation, permission receipt or executable import plan.
/// </summary>
public sealed class ArticlePackageManifestCandidate
{
    internal ArticlePackageManifestCandidate(ArticlePackageManifestArticle[] articles, string semanticDigest)
    {
        Articles = Array.AsReadOnly((ArticlePackageManifestArticle[])articles.Clone());
        SemanticDigest = semanticDigest;
    }

    internal static ArticlePackageManifestCandidate WithAssets(
        ArticlePackageManifestArticle[] articles,
        string semanticDigest,
        ArticlePackageManifestAssetCollectionCandidate assets)
        => new(articles, semanticDigest) { Assets = assets };

    /// <summary>Null means the legacy article-only format, never an implicitly empty collection.</summary>
    public ArticlePackageManifestAssetCollectionCandidate? Assets { get; private init; }

    public int SchemaVersion => Assets is null
        ? ArticlePackageManifestVersionRegistry.Current.Versions.SchemaVersion
        : ArticlePackageManifestVersionRegistry.AssetCollection.Versions.SchemaVersion;
    public int CanonicalHashVersion => ArticlePackageManifestVersionRegistry.Current.Versions.CanonicalHashVersion;
    public int PropertySchemaVersion => ArticlePackageManifestVersionRegistry.Current.Versions.PropertySchemaVersion;

    public IReadOnlyList<ArticlePackageManifestArticle> Articles
    {
        get;
    }
    public string SemanticDigest
    {
        get;
    }
}
