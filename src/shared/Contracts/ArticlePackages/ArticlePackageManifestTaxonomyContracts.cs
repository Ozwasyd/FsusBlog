namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Explicit portable/source taxonomy pair and exact public display fields; names never resolve identity.</summary>
public sealed record ArticlePackageManifestTaxonomyEntry(
    ArticlePackageIdentity PortableIdentity,
    int SourceId,
    string Name,
    string? Description);

/// <summary>Supplied source taxonomy coordinates; no persisted taxonomy version, existence or permission observation.</summary>
public sealed record ArticlePackageManifestTaxonomyInput(
    ArticlePackageManifestArticle Article,
    int SourceCategoryId,
    IReadOnlyList<int> SourceTagIds,
    ArticlePackageManifestTaxonomyEntry Category,
    IReadOnlyList<ArticlePackageManifestTaxonomyEntry> Tags);

/// <summary>Owned taxonomy component of the sole manifest codec; not a complete package or target resolution.</summary>
public sealed class ArticlePackageManifestTaxonomyCandidate
{
    internal ArticlePackageManifestTaxonomyCandidate(ArticlePackageManifestTaxonomyInput input, string componentDigest)
    {
        Input = input;
        ComponentDigest = componentDigest;
    }

    public ArticlePackageManifestTaxonomyInput Input
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    public ArticlePackageManifestCandidateResult RequireTaxonomyAuthority()
        => new(false, "article_package_manifest_taxonomy_source_authority_unavailable");
}

/// <summary>Frozen multi-article taxonomy projection with package-wide bijections; no store or permission authority.</summary>
public sealed class ArticlePackageManifestTaxonomySetCandidate
{
    internal ArticlePackageManifestTaxonomySetCandidate(ArticlePackageManifestTaxonomyCandidate[] articles, string componentDigest)
    {
        Articles = Array.AsReadOnly((ArticlePackageManifestTaxonomyCandidate[])articles.Clone());
        ComponentDigest = componentDigest;
    }

    public IReadOnlyList<ArticlePackageManifestTaxonomyCandidate> Articles
    {
        get;
    }
    public string ComponentDigest
    {
        get;
    }

    public ArticlePackageManifestCandidateResult RequireTaxonomyAuthority()
        => new(false, "article_package_manifest_taxonomy_source_authority_unavailable");
}
