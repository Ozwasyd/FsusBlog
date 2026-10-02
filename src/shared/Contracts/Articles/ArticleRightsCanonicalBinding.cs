namespace FsusBlog.Contracts.Articles;

/// <summary>Current revision content and policy canonical bindings; not persisted snapshot evidence.</summary>
public sealed record ArticleRightsCanonicalBinding(
    ArticleCanonicalInput Article,
    ArticleRightsCanonicalInput Rights,
    string ContentCanonicalHash,
    string PolicyHash)
{
    /// <summary>Builds the existing current-writer association from explicit metadata and normalized rights.</summary>
    /// <remarks>The rights payload requires positive revision coordinates. This performs no storage or publication admission.</remarks>
    public static ArticleRightsCanonicalBinding Build(
        ArticleCanonicalInput article,
        ArticleRightsNormalizedModel rights,
        string? canonicalUrl = null)
    {
        ArgumentNullException.ThrowIfNull(article);
        ArgumentNullException.ThrowIfNull(rights);

        string contentCanonicalHash = "sha256:" + ArticleCanonicalHashV1.ComputeHashHex(article);
        var rightsInput = new ArticleRightsCanonicalInput(
            ArticleId: article.ArticleId,
            ArticleRevisionId: article.ArticleRevisionId
                ?? throw new ArgumentException("Revision coordinates are required.", nameof(article)),
            RevisionNo: article.RevisionNo
                ?? throw new ArgumentException("Revision coordinates are required.", nameof(article)),
            LicenseType: rights.LicenseType,
            CopyrightHolder: rights.CopyrightHolder,
            CopyrightYear: rights.CopyrightYear,
            RightsStatement: rights.RightsStatement,
            AttributionTemplate: rights.AttributionTemplate,
            CopyPolicy: rights.CopyPolicy,
            MaxExcerptChars: rights.MaxExcerptChars,
            AllowCodeCopy: rights.AllowCodeCopy,
            ShowPublicBadge: rights.ShowPublicBadge,
            CanonicalUrl: canonicalUrl,
            ContentCanonicalHash: contentCanonicalHash);
        string policyHash = ArticleRightsCanonicalHashV1.ComputeHashHex(rightsInput);

        return new ArticleRightsCanonicalBinding(article, rightsInput, contentCanonicalHash, policyHash);
    }
}
