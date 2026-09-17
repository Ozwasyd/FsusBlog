using System.Globalization;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed record DistributedInvalidationAotTarget(
    string CacheKey,
    PublicPageId PageId,
    string RouteKey,
    bool IsPrefix = false);

public readonly record struct DistributedArticleViewProjectionTarget(
    int ArticleId,
    int Views,
    long Version);

public readonly record struct DistributedBanStateProjectionTarget(
    string AccountSubjectHash,
    BanStateProjectionStatus Status,
    string? ReasonCode,
    long Generation);

public sealed record DistributedInvalidationTargetPlan(
    IReadOnlyList<CacheKeyIdentity> CacheKeys,
    IReadOnlyList<DistributedInvalidationAotTarget> AotTargets,
    IReadOnlyList<string> HotReadFragments,
    IReadOnlyList<DistributedArticleViewProjectionTarget> ArticleViewProjections,
    IReadOnlyList<DistributedBanStateProjectionTarget> BanStateProjections,
    int ParsedTargetCount,
    bool RequiresFullReconcile,
    string? FullReconcileReason)
{
    public bool IsExact => !RequiresFullReconcile;
}

/// <summary>
/// Resolves the canonical event envelope into one owner per local target.
/// The resolver is deliberately pure: no cache, file, snapshot, or durable
/// state is touched until the complete plan has been produced and validated.
/// </summary>
public static class DistributedInvalidationTargetResolver
{
    public static DistributedInvalidationTargetPlan Resolve(DistributedInvalidationEvent invalidation)
    {
        ArgumentNullException.ThrowIfNull(invalidation);
        invalidation.Validate();

        var cacheKeys = new HashSet<CacheKeyIdentity>();
        var aotTargets = new HashSet<DistributedInvalidationAotTarget>();
        var hotFragments = new HashSet<string>(StringComparer.Ordinal);
        var articleViewProjections = new HashSet<DistributedArticleViewProjectionTarget>();
        var banStateProjections = new HashSet<DistributedBanStateProjectionTarget>();
        int parsedTargets = 0;
        string? failure = null;

        foreach (string target in invalidation.CacheTags)
        {
            parsedTargets++;
            if (!TryResolveCacheTarget(target, invalidation.Kind, cacheKeys, aotTargets, hotFragments))
            {
                failure ??= $"cache-target:{target}";
            }
        }

        foreach (string routeKey in invalidation.RouteKeys)
        {
            parsedTargets++;
            if (!TryResolveRouteTarget(routeKey, invalidation.Kind, cacheKeys, aotTargets, hotFragments))
            {
                failure ??= $"route-target:{routeKey}";
            }
        }

        foreach (string artifactKey in invalidation.ArtifactKeys)
        {
            parsedTargets++;
            if (!TryResolveArtifactTarget(
                    artifactKey,
                    invalidation.Kind,
                    cacheKeys,
                    aotTargets,
                    hotFragments,
                    articleViewProjections,
                    banStateProjections))
            {
                failure ??= $"artifact-target:{artifactKey}";
            }
        }

        if (invalidation.Kind is DistributedInvalidationEventKinds.SeoMutation
            or DistributedInvalidationEventKinds.ComplianceMutation)
        {
            ResolvePublicShellTargets(aotTargets, hotFragments);
        }

        if (invalidation.ArtifactKeys.Contains("public-aot", StringComparer.Ordinal)
            && aotTargets.Count == 0)
        {
            failure ??= "artifact-target:public-aot-without-route";
        }

        if (invalidation.ArtifactKeys.Contains("public-hot-read", StringComparer.Ordinal)
            && hotFragments.Count == 0)
        {
            failure ??= "artifact-target:public-hot-read-without-route";
        }

        if (parsedTargets == 0)
        {
            failure ??= "no-targets";
        }

        return new(
            cacheKeys.OrderBy(static value => value.PolicyId).ThenBy(static value => value.Identity, StringComparer.Ordinal).ToArray(),
            aotTargets.OrderBy(static value => value.PageId).ThenBy(static value => value.RouteKey, StringComparer.Ordinal).ToArray(),
            hotFragments.Order(StringComparer.Ordinal).ToArray(),
            articleViewProjections.OrderBy(static value => value.ArticleId).ToArray(),
            banStateProjections.OrderBy(static value => value.AccountSubjectHash, StringComparer.Ordinal).ToArray(),
            parsedTargets,
            failure is not null,
            failure);
    }

    public static bool TryParseArticleFragment(string fragment, out int articleId, out bool commentsOnly)
    {
        articleId = 0;
        commentsOnly = false;
        if (string.IsNullOrWhiteSpace(fragment)
            || !fragment.StartsWith("article:", StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> value = fragment.AsSpan("article:".Length);
        int separator = value.IndexOf(':');
        ReadOnlySpan<char> id = separator < 0 ? value : value[..separator];
        if (!int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out articleId)
            || articleId <= 0)
        {
            articleId = 0;
            return false;
        }

        if (separator < 0)
        {
            return true;
        }

        if (value[(separator + 1)..].Equals("comments", StringComparison.Ordinal))
        {
            commentsOnly = true;
            return true;
        }

        articleId = 0;
        return false;
    }

    public static bool IsAllArticlesFragment(string fragment)
        => fragment.Equals("article:*", StringComparison.Ordinal);

    public static bool IsTaxonomyFragment(string fragment)
        => fragment.Equals("taxonomy:category", StringComparison.Ordinal)
            || fragment.Equals("taxonomy:tag", StringComparison.Ordinal)
            || fragment.StartsWith("taxonomy:category:", StringComparison.Ordinal)
            || fragment.StartsWith("taxonomy:tag:", StringComparison.Ordinal);

    private static bool TryResolveCacheTarget(
        string target,
        string kind,
        ISet<CacheKeyIdentity> cacheKeys,
        ISet<DistributedInvalidationAotTarget> aotTargets,
        ISet<string> hotFragments)
    {
        if (target.StartsWith("l1:", StringComparison.Ordinal))
        {
            ReadOnlySpan<char> value = target.AsSpan(3);
            int separator = value.IndexOf(':');
            if (separator <= 0
                || !TryParsePolicy(value[..separator], out CachePolicyId policyId))
            {
                return false;
            }

            string identity = value[(separator + 1)..].ToString();
            if (string.IsNullOrWhiteSpace(identity))
            {
                return false;
            }

            cacheKeys.Add(new CacheKeyIdentity(policyId, identity));
            return true;
        }

        switch (target)
        {
            case "article":
                return true;
            case "taxonomy":
                AddCategoryTagTargets(cacheKeys);
                AddArticleListTargets(cacheKeys, hotFragments);
                if (kind == DistributedInvalidationEventKinds.TaxonomyMutation)
                {
                    AddTaxonomyAotTargets(aotTargets);
                }
                hotFragments.Add("taxonomy:category");
                hotFragments.Add("taxonomy:tag");
                return true;
            case "article-list":
                AddArticleListTargets(cacheKeys, hotFragments);
                return true;
            case "hot-articles":
                AddHotArticleTargets(cacheKeys, hotFragments);
                return true;
            case "stats":
                AddStatsTargets(cacheKeys);
                return true;
            case "comments":
                cacheKeys.Add(new(CachePolicyId.CommentCursorVersion, "global"));
                cacheKeys.Add(new(CachePolicyId.UserCommentCursorVersion, "global"));
                return true;
            case "comment-policy":
                cacheKeys.Add(new(CachePolicyId.AnonymousCommentPolicyVersion, "main"));
                return true;
            case "category":
                cacheKeys.Add(new(CachePolicyId.CategoryFrame, "all"));
                cacheKeys.Add(new(CachePolicyId.TaxonomyFrameVersion, "main"));
                if (kind == DistributedInvalidationEventKinds.TaxonomyMutation)
                {
                    AddAotPrefixTarget(aotTargets, "category:", "category:*");
                }
                hotFragments.Add("taxonomy:category");
                hotFragments.Add("list:category");
                return true;
            case "tag":
                cacheKeys.Add(new(CachePolicyId.TagFrame, "all"));
                cacheKeys.Add(new(CachePolicyId.TaxonomyFrameVersion, "main"));
                if (kind == DistributedInvalidationEventKinds.TaxonomyMutation)
                {
                    AddAotPrefixTarget(aotTargets, "tag:", "tag:*");
                    AddAotPrefixTarget(aotTargets, "tag-name:", "tag-name:*");
                }
                hotFragments.Add("taxonomy:tag");
                hotFragments.Add("list:tag");
                return true;
            case "seo":
                cacheKeys.Add(new(CachePolicyId.SystemSeo, "main"));
                if (kind == DistributedInvalidationEventKinds.ComplianceMutation)
                {
                    cacheKeys.Add(new(CachePolicyId.SystemCompliance, "main"));
                }

                return true;
            case "system-page":
                return true;
            default:
                return false;
        }
    }

    private static bool TryResolveRouteTarget(
        string routeKey,
        string kind,
        ISet<CacheKeyIdentity> cacheKeys,
        ISet<DistributedInvalidationAotTarget> aotTargets,
        ISet<string> hotFragments)
    {
        if (routeKey.Equals("taxonomy:*", StringComparison.Ordinal)
            || routeKey is "category" or "tag")
        {
            if (kind != DistributedInvalidationEventKinds.TaxonomyMutation)
            {
                return false;
            }

            hotFragments.Add("taxonomy:category");
            hotFragments.Add("taxonomy:tag");
            hotFragments.Add("list:category");
            hotFragments.Add("list:tag");
            AddTaxonomyAotTargets(aotTargets);
            return true;
        }

        if (routeKey is "system:seo" or "system:compliance")
        {
            return kind is DistributedInvalidationEventKinds.SeoMutation
                or DistributedInvalidationEventKinds.ComplianceMutation;
        }

        if (routeKey.Equals("article:hot", StringComparison.Ordinal))
        {
            AddHotArticleTargets(cacheKeys, hotFragments);
            return true;
        }

        if (routeKey.Equals("article:*", StringComparison.Ordinal))
        {
            if (kind != DistributedInvalidationEventKinds.ArticleMutation)
            {
                return false;
            }

            AddAllArticleFragments(hotFragments);
            return true;
        }

        if (routeKey.Equals("comments:*", StringComparison.Ordinal))
        {
            if (kind != DistributedInvalidationEventKinds.CommentMutation)
            {
                return false;
            }

            cacheKeys.Add(new(CachePolicyId.CommentCursorVersion, "global"));
            cacheKeys.Add(new(CachePolicyId.UserCommentCursorVersion, "global"));
            hotFragments.Add("comments:*");
            return true;
        }

        if (routeKey.Equals("comment-policy:anonymous", StringComparison.Ordinal))
        {
            if (kind != DistributedInvalidationEventKinds.CommentMutation)
            {
                return false;
            }

            cacheKeys.Add(new(CachePolicyId.AnonymousCommentPolicyVersion, "main"));
            hotFragments.Add("comment-policy:anonymous");
            return true;
        }

        if (routeKey.StartsWith("article:", StringComparison.Ordinal))
        {
            return TryResolveArticleRoute(routeKey, kind, cacheKeys, aotTargets, hotFragments);
        }

        if (routeKey.StartsWith("category:", StringComparison.Ordinal)
            || routeKey.StartsWith("tag:", StringComparison.Ordinal))
        {
            string[] parts = routeKey.Split(':', 2);
            if (parts.Length != 2
                || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out int id)
                || id <= 0
                || kind != DistributedInvalidationEventKinds.TaxonomyMutation)
            {
                return false;
            }

            string normalized = $"{parts[0]}:{id}";
            hotFragments.Add($"taxonomy:{parts[0]}:{id}");
            hotFragments.Add($"list:{parts[0]}");
            AddAotTarget(aotTargets, PublicPageId.Filter, normalized);
            return true;
        }

        if (routeKey.StartsWith("system-page:", StringComparison.Ordinal))
        {
            string slug = routeKey["system-page:".Length..].Trim();
            if (string.IsNullOrWhiteSpace(slug)
                || !TryResolveStaticAotTarget(slug, out PublicAotPageDescriptor descriptor))
            {
                return false;
            }

            if (kind != DistributedInvalidationEventKinds.SystemPageMutation)
            {
                return false;
            }

            string route = descriptor.FixedRouteKey ?? slug;
            AddAotTarget(aotTargets, descriptor.PageId, route);
            hotFragments.Add($"html:{route}");
            return true;
        }

        return false;
    }

    private static bool TryResolveArticleRoute(
        string routeKey,
        string kind,
        ISet<CacheKeyIdentity> cacheKeys,
        ISet<DistributedInvalidationAotTarget> aotTargets,
        ISet<string> hotFragments)
    {
        if (!TryParseArticleFragment(routeKey, out int articleId, out bool commentsOnly))
        {
            return false;
        }

        if (kind == DistributedInvalidationEventKinds.CommentMutation || commentsOnly)
        {
            cacheKeys.Add(new(CachePolicyId.CommentCursorVersion, $"article:{articleId}"));
            cacheKeys.Add(new(CachePolicyId.CommentCursorFrame, $"article:{articleId}"));
            hotFragments.Add($"article:{articleId}:comments");
            return true;
        }

        if (kind is not DistributedInvalidationEventKinds.ArticleMutation
            and not DistributedInvalidationEventKinds.PublicAotArtifactUpdated
            and not DistributedInvalidationEventKinds.PublicHotReadVersionPublished)
        {
            return false;
        }

        AddArticleTargets(cacheKeys, articleId);
        hotFragments.Add($"article:{articleId}");
        hotFragments.Add($"html:article:{articleId}");
        AddAotTarget(aotTargets, PublicPageId.ArticleDetail, $"article:{articleId}");
        return true;
    }

    private static bool TryResolveArtifactTarget(
        string artifactKey,
        string kind,
        ISet<CacheKeyIdentity> cacheKeys,
        ISet<DistributedInvalidationAotTarget> aotTargets,
        ISet<string> hotFragments,
        ISet<DistributedArticleViewProjectionTarget> articleViewProjections,
        ISet<DistributedBanStateProjectionTarget> banStateProjections)
    {
        if (kind == DistributedInvalidationEventKinds.BanStateProjection)
        {
            if (!TryParseBanStateProjectionTarget(artifactKey, out DistributedBanStateProjectionTarget target))
            {
                return false;
            }

            banStateProjections.Add(target);
            return true;
        }

        if (kind == DistributedInvalidationEventKinds.ArticleViewProjection)
        {
            if (!TryParseArticleViewProjectionTarget(artifactKey, out DistributedArticleViewProjectionTarget target))
            {
                return false;
            }

            articleViewProjections.Add(target);
            hotFragments.Add($"article:{target.ArticleId}");
            hotFragments.Add("list:hot");
            hotFragments.Add("list:featured");
            return true;
        }

        if (artifactKey.Equals("public-aot", StringComparison.Ordinal)
            || artifactKey.Equals("public-hot-read", StringComparison.Ordinal))
        {
            return true;
        }

        if (artifactKey.StartsWith("article-detail:", StringComparison.Ordinal))
        {
            string rest = artifactKey["article-detail:".Length..];
            if (rest.Equals("*", StringComparison.Ordinal))
            {
                if (kind != DistributedInvalidationEventKinds.ArticleMutation)
                {
                    return false;
                }

                AddAllArticleFragments(hotFragments);
                return true;
            }

            if (!int.TryParse(rest, NumberStyles.None, CultureInfo.InvariantCulture, out int articleId)
                || articleId <= 0)
            {
                return false;
            }

            AddArticleTargets(cacheKeys, articleId);
            AddAotTarget(aotTargets, PublicPageId.ArticleDetail, $"article:{articleId}");
            hotFragments.Add($"article:{articleId}");
            hotFragments.Add($"html:article:{articleId}");
            return true;
        }

        if (artifactKey.StartsWith("aot:", StringComparison.Ordinal))
        {
            string route = artifactKey[4..];
            if (TryParseAotCacheKey(route, out PublicPageId pageId, out string routeKey))
            {
                AddAotTarget(aotTargets, pageId, routeKey);
                return true;
            }

            return false;
        }

        if (artifactKey.StartsWith("hot:", StringComparison.Ordinal))
        {
            string fragment = artifactKey[4..].Trim();
            if (string.IsNullOrWhiteSpace(fragment) || !IsKnownHotFragment(fragment))
            {
                return false;
            }

            hotFragments.Add(fragment);
            return true;
        }

        if (kind == DistributedInvalidationEventKinds.PublicHotReadVersionPublished
            && TryParsePublicHotReadVersion(artifactKey, out _))
        {
            hotFragments.Add(artifactKey);
            return true;
        }

        return false;
    }

    public static string FormatArticleViewProjectionTarget(int articleId, int views, long version)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"article-view:{articleId}:views:{views}:version:{version}");

    public static string FormatBanStateProjectionTarget(BanStateProjectionUpdate update)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"ban-state:{update.AccountSubjectHash}:status:{(int)update.Status}:reason:{update.ReasonCode ?? "none"}:generation:{update.Generation}");

    public static bool TryParseBanStateProjectionTarget(
        string value,
        out DistributedBanStateProjectionTarget target)
    {
        target = default;
        string[] parts = value.Split(':', StringSplitOptions.None);
        if (parts.Length != 8
            || !parts[0].Equals("ban-state", StringComparison.Ordinal)
            || !parts[2].Equals("status", StringComparison.Ordinal)
            || !parts[4].Equals("reason", StringComparison.Ordinal)
            || !parts[6].Equals("generation", StringComparison.Ordinal)
            || !AccountSubjectHashRequirement.TryResolve(parts[1], out string subjectHash)
            || !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out int statusValue)
            || !Enum.IsDefined(typeof(BanStateProjectionStatus), statusValue)
            || (BanStateProjectionStatus)statusValue is BanStateProjectionStatus.Unknown
            || !long.TryParse(parts[7], NumberStyles.None, CultureInfo.InvariantCulture, out long generation)
            || generation <= 0)
        {
            return false;
        }

        BanStateProjectionStatus status = (BanStateProjectionStatus)statusValue;
        string? reasonCode = parts[5].Equals("none", StringComparison.Ordinal) ? null : parts[5];
        if ((status == BanStateProjectionStatus.Banned
                && !string.Equals(reasonCode, BanStateProjectionFacts.ManualReasonCode, StringComparison.Ordinal))
            || (status != BanStateProjectionStatus.Banned && reasonCode is not null))
        {
            return false;
        }

        target = new DistributedBanStateProjectionTarget(subjectHash, status, reasonCode, generation);
        return true;
    }

    public static bool TryParsePublicHotReadVersion(string value, out long version)
    {
        version = 0;
        const string Prefix = "public-hot-read:v";
        return value.StartsWith(Prefix, StringComparison.Ordinal)
            && long.TryParse(value.AsSpan(Prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out version)
            && version >= 0;
    }

    public static bool TryParseArticleViewProjectionTarget(
        string value,
        out DistributedArticleViewProjectionTarget target)
    {
        target = default;
        string[] parts = value.Split(':', StringSplitOptions.None);
        if (parts.Length != 6
            || !parts[0].Equals("article-view", StringComparison.Ordinal)
            || !parts[2].Equals("views", StringComparison.Ordinal)
            || !parts[4].Equals("version", StringComparison.Ordinal)
            || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out int articleId)
            || !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out int views)
            || !long.TryParse(parts[5], NumberStyles.None, CultureInfo.InvariantCulture, out long version)
            || articleId <= 0
            || views < 0
            || version <= 0)
        {
            return false;
        }

        target = new DistributedArticleViewProjectionTarget(articleId, views, version);
        return true;
    }

    private static bool IsKnownHotFragment(string fragment)
        => fragment.StartsWith("article:", StringComparison.Ordinal)
            || fragment.StartsWith("html:", StringComparison.Ordinal)
            || fragment.StartsWith("list:", StringComparison.Ordinal)
            || fragment.StartsWith("comment-policy", StringComparison.Ordinal)
            || fragment.Equals("comments:*", StringComparison.Ordinal)
            || fragment.Equals("taxonomy:category", StringComparison.Ordinal)
            || fragment.Equals("taxonomy:tag", StringComparison.Ordinal)
            || fragment.StartsWith("taxonomy:category:", StringComparison.Ordinal)
            || fragment.StartsWith("taxonomy:tag:", StringComparison.Ordinal)
            || fragment.StartsWith("public-hot-read:v", StringComparison.Ordinal);

    private static void AddArticleTargets(ISet<CacheKeyIdentity> cacheKeys, int articleId)
    {
        string value = articleId.ToString(CultureInfo.InvariantCulture);
        cacheKeys.Add(new(CachePolicyId.ArticleDetail, value));
        cacheKeys.Add(new(CachePolicyId.ArticleDetail, $"core:v2:{value}"));
        cacheKeys.Add(new(CachePolicyId.ArticleDetail, $"core:v3:{value}"));
        cacheKeys.Add(new(CachePolicyId.ArticleDetailFrame, $"core:v3:{value}"));
    }

    private static void AddArticleListTargets(ISet<CacheKeyIdentity> cacheKeys, ISet<string> hotFragments)
    {
        cacheKeys.Add(new(CachePolicyId.ArticleList, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleListCount, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleSearch, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleRss, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleListVersion, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleSearchVersion, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleListFrame, "main"));
        hotFragments.Add("list:home");
        hotFragments.Add("list:archive");
    }

    private static void AddHotArticleTargets(ISet<CacheKeyIdentity> cacheKeys, ISet<string> hotFragments)
    {
        cacheKeys.Add(new(CachePolicyId.ArticleHot, "main"));
        cacheKeys.Add(new(CachePolicyId.TopArticles, "main"));
        cacheKeys.Add(new(CachePolicyId.ArticleHotFrame, "main"));
        cacheKeys.Add(new(CachePolicyId.TopArticlesFrame, "main"));
        hotFragments.Add("list:hot");
        hotFragments.Add("list:featured");
    }

    private static void AddStatsTargets(ISet<CacheKeyIdentity> cacheKeys)
    {
        cacheKeys.Add(new(CachePolicyId.AdminStats, "main"));
        cacheKeys.Add(new(CachePolicyId.AdminStats, "core:main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsOverview, "main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsRecentComments, "main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsRecentComments, "core:main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsRegions, "main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsRegions, "core:main"));
        cacheKeys.Add(new(CachePolicyId.AdminStatsFrame, "core:main"));
        cacheKeys.Add(new(CachePolicyId.CommentCursorFrame, "global"));
        cacheKeys.Add(new(CachePolicyId.UserCommentCursorFrame, "global"));
    }

    private static void AddCategoryTagTargets(ISet<CacheKeyIdentity> cacheKeys)
    {
        cacheKeys.Add(new(CachePolicyId.CategoryFrame, "all"));
        cacheKeys.Add(new(CachePolicyId.TagFrame, "all"));
        cacheKeys.Add(new(CachePolicyId.TaxonomyFrameVersion, "main"));
    }

    private static void AddTaxonomyAotTargets(ISet<DistributedInvalidationAotTarget> targets)
    {
        AddAotPrefixTarget(targets, "category:", "category:*");
        AddAotPrefixTarget(targets, "tag:", "tag:*");
        AddAotPrefixTarget(targets, "tag-name:", "tag-name:*");
    }

    private static void AddAllArticleFragments(ISet<string> hotFragments)
    {
        hotFragments.Add("article:*");
        hotFragments.Add("list:home");
        hotFragments.Add("list:archive");
        hotFragments.Add("list:hot");
        hotFragments.Add("list:featured");
    }

    private static void ResolvePublicShellTargets(
        ISet<DistributedInvalidationAotTarget> aotTargets,
        ISet<string> hotFragments)
    {
        foreach (PublicAotPageDescriptor descriptor in PublicAotPageCatalog.s_all)
        {
            if (descriptor.Kind is PublicPageKind.ArticleDetail or PublicPageKind.Filter or PublicPageKind.Account)
            {
                continue;
            }

            string routeKey = descriptor.FixedRouteKey ?? PublicAotPageIdentity.GetCanonicalSlug(descriptor.Kind);
            AddAotTarget(aotTargets, descriptor.PageId, routeKey);
            hotFragments.Add($"html:{routeKey}");
        }
    }

    private static bool TryResolveStaticAotTarget(string slug, out PublicAotPageDescriptor descriptor)
    {
        foreach (PublicAotPageDescriptor candidate in PublicAotPageCatalog.s_all)
        {
            if (string.Equals(candidate.FixedRouteKey, slug, StringComparison.Ordinal)
                || string.Equals(PublicAotPageIdentity.GetCanonicalSlug(candidate.Kind), slug, StringComparison.Ordinal))
            {
                descriptor = candidate;
                return true;
            }
        }

        descriptor = null!;
        return false;
    }

    private static void AddAotTarget(
        ISet<DistributedInvalidationAotTarget> targets,
        PublicPageId pageId,
        string routeKey)
        => targets.Add(new(
            CacheKeyBuilder.PublicAotDocument(pageId, routeKey),
            pageId,
            routeKey));

    private static void AddAotPrefixTarget(
        ISet<DistributedInvalidationAotTarget> targets,
        string routePrefix,
        string receiptRouteKey)
        => targets.Add(new(
            CacheKeyBuilder.PublicAotDocument(PublicPageId.Filter, routePrefix),
            PublicPageId.Filter,
            receiptRouteKey,
            IsPrefix: true));

    private static bool TryParseAotCacheKey(
        string value,
        out PublicPageId pageId,
        out string routeKey)
    {
        pageId = default;
        routeKey = string.Empty;
        const string Prefix = "public:aot:v2:doc:";
        if (!value.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return false;
        }

        ReadOnlySpan<char> remainder = value.AsSpan(Prefix.Length);
        int separator = remainder.IndexOf(':');
        return separator > 0
            && int.TryParse(remainder[..separator], NumberStyles.None, CultureInfo.InvariantCulture, out int rawPageId)
            && Enum.IsDefined(typeof(PublicPageId), rawPageId)
            && (pageId = (PublicPageId)rawPageId) != 0
            && !string.IsNullOrWhiteSpace(routeKey = remainder[(separator + 1)..].ToString());
    }

    private static bool TryParsePolicy(ReadOnlySpan<char> value, out CachePolicyId policyId)
    {
        if (Enum.TryParse(value, ignoreCase: false, out policyId)
            && policyId != CachePolicyId.None)
        {
            return true;
        }

        if (int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int raw)
            && Enum.IsDefined(typeof(CachePolicyId), raw)
            && raw != (int)CachePolicyId.None)
        {
            policyId = (CachePolicyId)raw;
            return true;
        }

        policyId = CachePolicyId.None;
        return false;
    }
}
