namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Projection-local budgets applied before invoking the canonical article hash owner.</summary>
public static class ArticlePackageTitleSummaryLimits
{
    public const int MaxCanonicalTextCodeUnits = 1048576;
    public const int MaxTagIds = 1000;
}

/// <summary>Explicit revision and portable identity pairing; not an observation or permission receipt.</summary>
public sealed class ArticlePackageTitleSummaryBinding
{
    public ArticlePackageTitleSummaryBinding(
        int sourceArticleId,
        long sourceRevisionId,
        int sourceRevisionNo,
        string sourceCanonicalHash,
        ArticlePackageIdentity portableArticle)
    {
        SourceArticleId = sourceArticleId;
        SourceRevisionId = sourceRevisionId;
        SourceRevisionNo = sourceRevisionNo;
        SourceCanonicalHash = sourceCanonicalHash;
        PortableArticle = portableArticle;
    }

    public int SourceArticleId
    {
        get;
    }
    public long SourceRevisionId
    {
        get;
    }
    public int SourceRevisionNo
    {
        get;
    }
    public string SourceCanonicalHash
    {
        get;
    }
    public ArticlePackageIdentity PortableArticle
    {
        get;
    }
}

/// <summary>
/// Closed title/summary projection. Its exact-text digest is distinct from the normalized canonical
/// source hash. Construction alone does not validate the candidate or authorize package export.
/// </summary>
public sealed class ArticlePackageTitleSummaryCandidate
{
    public ArticlePackageTitleSummaryCandidate(
        int schemaVersion,
        int sourceArticleId,
        long sourceRevisionId,
        int sourceRevisionNo,
        string sourceCanonicalHash,
        ArticlePackageIdentity portableArticle,
        string title,
        string? summary,
        string mappingDigest)
    {
        SchemaVersion = schemaVersion;
        SourceArticleId = sourceArticleId;
        SourceRevisionId = sourceRevisionId;
        SourceRevisionNo = sourceRevisionNo;
        SourceCanonicalHash = sourceCanonicalHash;
        PortableArticle = portableArticle;
        Title = title;
        Summary = summary;
        MappingDigest = mappingDigest;
    }

    public int SchemaVersion
    {
        get;
    }
    public int SourceArticleId
    {
        get;
    }
    public long SourceRevisionId
    {
        get;
    }
    public int SourceRevisionNo
    {
        get;
    }
    public string SourceCanonicalHash
    {
        get;
    }
    public ArticlePackageIdentity PortableArticle
    {
        get;
    }
    public string Title
    {
        get;
    }
    public string? Summary
    {
        get;
    }
    public string MappingDigest
    {
        get;
    }
}
