using System.Collections.Frozen;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CachePolicyRegistry : ICachePolicyRegistry
{
    private static readonly FrozenDictionary<CachePolicyId, CachePolicy> Policies =
        new Dictionary<CachePolicyId, CachePolicy>
        {
            [CachePolicyId.ArticleList] = new(CachePolicyId.ArticleList, "blog", "article-list", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.ArticleList, CacheTag.Category], false, 0.10d),
            [CachePolicyId.ArticleDetail] = new(CachePolicyId.ArticleDetail, "blog", "article-detail", TimeSpan.FromMinutes(5), TimeSpan.FromHours(1), TimeSpan.FromMinutes(5), [CacheTag.ArticleList], false, 0.10d),
            [CachePolicyId.ArticleHot] = new(CachePolicyId.ArticleHot, "blog", "article-hot", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.HotArticles], false, 0.10d),
            [CachePolicyId.ArticleSearch] = new(CachePolicyId.ArticleSearch, "blog", "article-search", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(10), null, [CacheTag.ArticleList], false, 0.10d),
            [CachePolicyId.ArticleRss] = new(CachePolicyId.ArticleRss, "blog", "article-rss", TimeSpan.FromMinutes(3), TimeSpan.FromMinutes(30), null, [CacheTag.ArticleList]),
            [CachePolicyId.ArticleListVersion] = new(CachePolicyId.ArticleListVersion, "blog", "article-list-version", TimeSpan.FromMinutes(1), TimeSpan.FromDays(7), null, [CacheTag.ArticleList]),
            [CachePolicyId.TopArticles] = new(CachePolicyId.TopArticles, "blog", "top-articles", TimeSpan.FromMinutes(2), TimeSpan.FromHours(2), null, [CacheTag.HotArticles]),
            [CachePolicyId.CommentCursor] = new(CachePolicyId.CommentCursor, "blog", "comment-cursor", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.UserCommentCursor] = new(CachePolicyId.UserCommentCursor, "blog", "user-comment-cursor", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.SystemSeo] = new(CachePolicyId.SystemSeo, "sys", "seo", TimeSpan.FromMinutes(10), TimeSpan.FromHours(24), null, [CacheTag.Seo], false, 0.10d),
            [CachePolicyId.SystemPage] = new(CachePolicyId.SystemPage, "sys", "page", TimeSpan.FromMinutes(10), TimeSpan.FromHours(24), TimeSpan.FromMinutes(2), [CacheTag.SystemPage], false, 0.10d),
            [CachePolicyId.AdminStats] = new(CachePolicyId.AdminStats, "admin", "stats", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.Stats], false, 0.10d),
            [CachePolicyId.MessageUnread] = new(CachePolicyId.MessageUnread, "msg", "unread", TimeSpan.FromMinutes(2), TimeSpan.FromDays(3)),
            [CachePolicyId.MessageGlobalVersion] = new(CachePolicyId.MessageGlobalVersion, "msg", "global-version", TimeSpan.FromMinutes(2), TimeSpan.FromDays(3)),
            [CachePolicyId.PublicAotDocument] = new(CachePolicyId.PublicAotDocument, "public", "aot-doc", TimeSpan.FromMinutes(30), TimeSpan.FromDays(30), null, [CacheTag.Aot]),
            [CachePolicyId.PublicAotRegistry] = new(CachePolicyId.PublicAotRegistry, "public", "aot-registry", TimeSpan.FromMinutes(5), TimeSpan.FromDays(30), null, [CacheTag.Aot]),
            [CachePolicyId.SecurityBlockedUser] = new(CachePolicyId.SecurityBlockedUser, "sec", "blocked-user", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(20), null, null, true),
            [CachePolicyId.SecurityMfaChallenge] = new(CachePolicyId.SecurityMfaChallenge, "sec", "mfa-challenge", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true),
            [CachePolicyId.SecurityMfaProof] = new(CachePolicyId.SecurityMfaProof, "sec", "mfa-proof", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true),
            [CachePolicyId.SecurityPowRisk] = new(CachePolicyId.SecurityPowRisk, "sec", "pow-risk", TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(2), null, null, true),
            [CachePolicyId.SecurityBlacklistUser] = new(CachePolicyId.SecurityBlacklistUser, "sec", "blacklist-user", TimeSpan.FromMinutes(2), TimeSpan.FromDays(7), null, null, true),
            [CachePolicyId.VisitLock] = new(CachePolicyId.VisitLock, "sec", "visit-lock", TimeSpan.Zero, TimeSpan.FromMinutes(30), null, null, true),
            [CachePolicyId.ArticleViewLock] = new(CachePolicyId.ArticleViewLock, "sec", "article-view-lock", TimeSpan.Zero, TimeSpan.FromHours(1), null, null, true),
            [CachePolicyId.SecurityPasskeyRegChallenge] = new(CachePolicyId.SecurityPasskeyRegChallenge, "sec", "pk-reg", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true),
            [CachePolicyId.SecurityPasskeyAuthChallenge] = new(CachePolicyId.SecurityPasskeyAuthChallenge, "sec", "pk-auth", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true),
            [CachePolicyId.HumanReadProof] = new(CachePolicyId.HumanReadProof, "sec", "human-read-proof", TimeSpan.Zero, TimeSpan.FromDays(1), null, null, true),
            [CachePolicyId.SecurityPowProof] = new(CachePolicyId.SecurityPowProof, "sec", "pow-proof", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true)
        }.ToFrozenDictionary();

    public bool TryGet(CachePolicyId id, out CachePolicy policy)
    {
        if (Policies.TryGetValue(id, out CachePolicy? resolved) && resolved is not null)
        {
            policy = resolved;
            return true;
        }

        policy = null!;
        return false;
    }
}
