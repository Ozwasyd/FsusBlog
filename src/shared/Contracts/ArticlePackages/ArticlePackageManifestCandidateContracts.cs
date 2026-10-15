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
/// to actual canonical inputs and bytes; syntax, assets, privacy and complete metadata are absent.
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

    public int SchemaVersion => ArticlePackageManifestVersionRegistry.Current.Versions.SchemaVersion;
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
