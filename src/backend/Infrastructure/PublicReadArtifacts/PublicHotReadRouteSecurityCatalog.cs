namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed record PublicFastPathRouteMetadata(
    string PolicyId,
    bool RequiresVisibilityEvidence,
    bool RequiresSecurityGate,
    bool RequiresRateLimit,
    bool RequiresTraceCorrelation,
    bool RequiresReleaseHeaders);

internal readonly record struct PublicHotReadRoutePolicy(
    PublicHotReadRouteKind Kind,
    string PolicyId,
    PublicHotReadArtifactMediaKind MediaKind,
    bool RequiresVisibilityEvidence,
    bool RequiresSecurityGate,
    bool RequiresRateLimit,
    bool RequiresTraceCorrelation,
    bool RequiresReleaseHeaders)
{
    internal PublicFastPathRouteMetadata ToEndpointMetadata()
        => new(
            PolicyId,
            RequiresVisibilityEvidence,
            RequiresSecurityGate,
            RequiresRateLimit,
            RequiresTraceCorrelation,
            RequiresReleaseHeaders);
}

internal static class PublicHotReadRouteSecurityCatalog
{
    internal static readonly PublicHotReadRoutePolicy RejectedCandidate = new(
        PublicHotReadRouteKind.None,
        "rejected-candidate",
        PublicHotReadArtifactMediaKind.Binary,
        RequiresVisibilityEvidence: false,
        RequiresSecurityGate: false,
        RequiresRateLimit: false,
        RequiresTraceCorrelation: false,
        RequiresReleaseHeaders: false);

    private static readonly PublicHotReadRoutePolicy[] Policies =
    [
        Create(PublicHotReadRouteKind.Category, "taxonomy-category", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.Tag, "taxonomy-tag", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.ArticleDetail, "article-detail", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.ArticleList, "article-list", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.ArticleHot, "article-hot", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.ArticleFeatured, "article-featured", PublicHotReadArtifactMediaKind.Binary),
        Create(PublicHotReadRouteKind.ArticleHtml, "article-html-diagnostic", PublicHotReadArtifactMediaKind.Html),
        Create(PublicHotReadRouteKind.PublicHtml, "public-html", PublicHotReadArtifactMediaKind.Html)
    ];

    internal static IReadOnlyList<PublicHotReadRoutePolicy> All => Policies;

    internal static bool TryGet(PublicHotReadRouteKind kind, out PublicHotReadRoutePolicy policy)
    {
        int index = (int)kind - 1;
        if ((uint)index < (uint)Policies.Length && Policies[index].Kind == kind)
        {
            policy = Policies[index];
            return true;
        }

        policy = default;
        return false;
    }

    internal static void ValidateOrThrow()
    {
        PublicHotReadRouteKind[] expected = Enum.GetValues<PublicHotReadRouteKind>()
            .Where(static kind => kind != PublicHotReadRouteKind.None)
            .ToArray();
        if (Policies.Length != expected.Length
            || Policies.Select(static policy => policy.Kind).Distinct().Count() != expected.Length
            || expected.Any(static kind => !TryGet(kind, out _))
            || Policies.Any(static policy => string.IsNullOrWhiteSpace(policy.PolicyId)
                || !policy.RequiresVisibilityEvidence
                || !policy.RequiresSecurityGate
                || !policy.RequiresRateLimit
                || !policy.RequiresTraceCorrelation
                || !policy.RequiresReleaseHeaders))
        {
            throw new InvalidOperationException("public hot-read route security catalog is incomplete");
        }
    }

    private static PublicHotReadRoutePolicy Create(
        PublicHotReadRouteKind kind,
        string policyId,
        PublicHotReadArtifactMediaKind mediaKind)
        => new(
            kind,
            policyId,
            mediaKind,
            RequiresVisibilityEvidence: true,
            RequiresSecurityGate: true,
            RequiresRateLimit: true,
            RequiresTraceCorrelation: true,
            RequiresReleaseHeaders: true);
}

public readonly record struct PublicHotReadPublicationEvidence(
    string VisibilityPolicy,
    long SourceVersion,
    DateTimeOffset? VisibilityCutoffUtc,
    bool PublishedOnly,
    bool DeletedExcluded,
    bool FuturePublicationExcluded)
{
    public const string CurrentVisibilityPolicy = "published-visible-at-cutoff-v1";

    internal static PublicHotReadPublicationEvidence Empty => default;

    internal static PublicHotReadPublicationEvidence CreateVerified(
        long sourceVersion,
        DateTimeOffset visibilityCutoffUtc)
        => new(
            CurrentVisibilityPolicy,
            sourceVersion,
            visibilityCutoffUtc,
            PublishedOnly: true,
            DeletedExcluded: true,
            FuturePublicationExcluded: true);

    internal PublicHotReadPublicationEvidence WithSourceVersion(long sourceVersion)
        => this with { SourceVersion = sourceVersion };

    internal bool IsVerifiedFor(long snapshotVersion)
        => snapshotVersion > 0
            && SourceVersion == snapshotVersion
            && VisibilityCutoffUtc.HasValue
            && string.Equals(VisibilityPolicy, CurrentVisibilityPolicy, StringComparison.Ordinal)
            && PublishedOnly
            && DeletedExcluded
            && FuturePublicationExcluded;
}
