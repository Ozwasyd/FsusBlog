namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed record PublicFastPathRouteMetadata(
    string PolicyId,
    bool RequiresVisibilityEvidence,
    bool RequiresSecurityGate,
    bool RequiresRateLimit,
    bool RequiresTraceCorrelation,
    bool RequiresReleaseHeaders,
    bool RequiresAnonymousRequest,
    bool RequiresSafeMethod,
    bool DefersCorsRequestsToEndpointPipeline);

internal readonly record struct PublicHotReadRoutePolicy(
    PublicHotReadRouteKind Kind,
    string PolicyId,
    PublicHotReadArtifactMediaKind MediaKind,
    bool RequiresVisibilityEvidence,
    bool RequiresSecurityGate,
    bool RequiresRateLimit,
    bool RequiresTraceCorrelation,
    bool RequiresReleaseHeaders,
    bool RequiresAnonymousRequest,
    bool RequiresSafeMethod,
    bool DefersCorsRequestsToEndpointPipeline,
    string ProbePath)
{
    internal PublicFastPathRouteMetadata ToEndpointMetadata()
        => new(
            PolicyId,
            RequiresVisibilityEvidence,
            RequiresSecurityGate,
            RequiresRateLimit,
            RequiresTraceCorrelation,
            RequiresReleaseHeaders,
            RequiresAnonymousRequest,
            RequiresSafeMethod,
            DefersCorsRequestsToEndpointPipeline);
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
        RequiresReleaseHeaders: false,
        RequiresAnonymousRequest: false,
        RequiresSafeMethod: false,
        DefersCorsRequestsToEndpointPipeline: false,
        ProbePath: string.Empty);

    private static readonly PublicHotReadRoutePolicy[] Policies =
    [
        Create(PublicHotReadRouteKind.Category, "taxonomy-category", PublicHotReadArtifactMediaKind.Binary, "/api/binary/category.aeds"),
        Create(PublicHotReadRouteKind.Tag, "taxonomy-tag", PublicHotReadArtifactMediaKind.Binary, "/api/binary/tag.aeds"),
        Create(PublicHotReadRouteKind.ArticleDetail, "article-detail", PublicHotReadArtifactMediaKind.Binary, "/api/binary/article/42.aeds"),
        Create(PublicHotReadRouteKind.ArticleList, "article-list", PublicHotReadArtifactMediaKind.Binary, "/api/binary/article/list/home/1/10.aeds"),
        Create(PublicHotReadRouteKind.ArticleHot, "article-hot", PublicHotReadArtifactMediaKind.Binary, "/api/binary/article/hot/10.aeds"),
        Create(PublicHotReadRouteKind.ArticleFeatured, "article-featured", PublicHotReadArtifactMediaKind.Binary, "/api/binary/article/featured/4.aeds"),
        Create(PublicHotReadRouteKind.ArticleHtml, "article-html-diagnostic", PublicHotReadArtifactMediaKind.Html, "/api/binary/article/html/home.html"),
        Create(PublicHotReadRouteKind.PublicHtml, "public-html", PublicHotReadArtifactMediaKind.Html, "/")
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
        => ValidateOrThrow(Policies);

    internal static void ValidateOrThrow(IReadOnlyList<PublicHotReadRoutePolicy> policies)
    {
        PublicHotReadRouteKind[] expected = Enum.GetValues<PublicHotReadRouteKind>()
            .Where(static kind => kind != PublicHotReadRouteKind.None)
            .ToArray();
        if (policies.Count != expected.Length
            || policies.Select(static policy => policy.Kind).Distinct().Count() != expected.Length
            || expected.Any(kind => !policies.Any(policy => policy.Kind == kind))
            || policies.Any(static policy => string.IsNullOrWhiteSpace(policy.PolicyId)
                || string.IsNullOrWhiteSpace(policy.ProbePath)
                || !policy.RequiresVisibilityEvidence
                || !policy.RequiresSecurityGate
                || !policy.RequiresRateLimit
                || !policy.RequiresTraceCorrelation
                || !policy.RequiresReleaseHeaders
                || !policy.RequiresAnonymousRequest
                || !policy.RequiresSafeMethod
                || !policy.DefersCorsRequestsToEndpointPipeline))
        {
            throw new InvalidOperationException("public hot-read route security catalog is incomplete");
        }
    }

    private static PublicHotReadRoutePolicy Create(
        PublicHotReadRouteKind kind,
        string policyId,
        PublicHotReadArtifactMediaKind mediaKind,
        string probePath)
        => new(
            kind,
            policyId,
            mediaKind,
            RequiresVisibilityEvidence: true,
            RequiresSecurityGate: true,
            RequiresRateLimit: true,
            RequiresTraceCorrelation: true,
            RequiresReleaseHeaders: true,
            RequiresAnonymousRequest: true,
            RequiresSafeMethod: true,
            DefersCorsRequestsToEndpointPipeline: true,
            ProbePath: probePath);
}

public readonly record struct PublicHotReadPublicationEvidence(
    string VisibilityPolicy,
    string SourceVisibility,
    long SourceVersion,
    DateTimeOffset? VisibilityCutoffUtc,
    bool PublishedOnly,
    bool DeletedExcluded,
    bool FuturePublicationExcluded)
{
    public const string CurrentVisibilityPolicy = "published-visible-at-cutoff-v1";
    public const string PublicSourceVisibility = "public";

    internal static PublicHotReadPublicationEvidence Empty => default;

    internal static PublicHotReadPublicationEvidence CreateVerified(
        long sourceVersion,
        DateTimeOffset visibilityCutoffUtc)
        => new(
            CurrentVisibilityPolicy,
            PublicSourceVisibility,
            sourceVersion,
            visibilityCutoffUtc,
            PublishedOnly: true,
            DeletedExcluded: true,
            FuturePublicationExcluded: true);

    internal PublicHotReadPublicationEvidence WithSourceVersion(long sourceVersion)
        => this with
        {
            SourceVersion = sourceVersion
        };

    internal bool IsVerifiedFor(long snapshotVersion)
        => snapshotVersion > 0
            && SourceVersion == snapshotVersion
            && VisibilityCutoffUtc.HasValue
            && string.Equals(VisibilityPolicy, CurrentVisibilityPolicy, StringComparison.Ordinal)
            && string.Equals(SourceVisibility, PublicSourceVisibility, StringComparison.Ordinal)
            && PublishedOnly
            && DeletedExcluded
            && FuturePublicationExcluded;
}
