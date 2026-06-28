using System.Collections.Frozen;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CachePolicyRegistry : ICachePolicyRegistry
{
    private static readonly FrozenDictionary<CachePolicyId, CachePolicy> Policies =
        new Dictionary<CachePolicyId, CachePolicy>
        {
            [CachePolicyId.ArticleList] = new(CachePolicyId.ArticleList, "blog", "article-list", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.ArticleList, CacheTag.Category], false, 0.10d, false),
            [CachePolicyId.ArticleListCount] = new(CachePolicyId.ArticleListCount, "blog", "article-list-count", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(30), null, [CacheTag.ArticleList, CacheTag.Category], false, 0.10d, false),
            [CachePolicyId.ArticleDetail] = new(CachePolicyId.ArticleDetail, "blog", "article-detail", TimeSpan.FromMinutes(5), TimeSpan.FromHours(1), TimeSpan.FromMinutes(5), [CacheTag.ArticleList], false, 0.10d, false),
            [CachePolicyId.ArticleHot] = new(CachePolicyId.ArticleHot, "blog", "article-hot", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.HotArticles], false, 0.10d),
            [CachePolicyId.ArticleSearch] = new(CachePolicyId.ArticleSearch, "blog", "article-search", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(10), null, [CacheTag.ArticleList], false, 0.10d, false),
            [CachePolicyId.ArticleRss] = new(CachePolicyId.ArticleRss, "blog", "article-rss", TimeSpan.FromMinutes(3), TimeSpan.FromMinutes(30), null, [CacheTag.ArticleList], false, 0d, false),
            [CachePolicyId.ArticleListVersion] = new(CachePolicyId.ArticleListVersion, "blog", "article-list-version", TimeSpan.FromMinutes(1), TimeSpan.FromDays(7), null, [CacheTag.ArticleList], false, 0d, false),
            [CachePolicyId.TopArticles] = new(CachePolicyId.TopArticles, "blog", "top-articles", TimeSpan.FromMinutes(2), TimeSpan.FromHours(2), null, [CacheTag.HotArticles], false, 0d, false),
            [CachePolicyId.CommentCursor] = new(CachePolicyId.CommentCursor, "blog", "comment-cursor", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.UserCommentCursor] = new(CachePolicyId.UserCommentCursor, "blog", "user-comment-cursor", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.SystemSeo] = new(CachePolicyId.SystemSeo, "sys", "seo", TimeSpan.FromMinutes(10), TimeSpan.FromHours(24), null, [CacheTag.Seo], false, 0.10d, false),
            [CachePolicyId.SystemPage] = new(CachePolicyId.SystemPage, "sys", "page", TimeSpan.FromMinutes(10), TimeSpan.FromHours(24), TimeSpan.FromMinutes(2), [CacheTag.SystemPage], false, 0.10d, false),
            [CachePolicyId.SystemCompliance] = new(CachePolicyId.SystemCompliance, "sys", "compliance", TimeSpan.FromMinutes(10), TimeSpan.FromHours(24), null, [CacheTag.Seo], false, 0.10d, false),
            [CachePolicyId.AdminStats] = new(CachePolicyId.AdminStats, "admin", "stats", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.Stats], false, 0.10d, false),
            [CachePolicyId.MessageUnread] = new(CachePolicyId.MessageUnread, "msg", "unread", TimeSpan.FromMinutes(2), TimeSpan.FromDays(3), null, null, false, 0d, false),
            [CachePolicyId.MessageGlobalVersion] = new(CachePolicyId.MessageGlobalVersion, "msg", "global-version", TimeSpan.FromMinutes(2), TimeSpan.FromDays(3), null, null, false, 0d, false),
            [CachePolicyId.PublicAotDocument] = new(CachePolicyId.PublicAotDocument, "public", "aot-doc", TimeSpan.FromMinutes(30), TimeSpan.FromDays(30), null, [CacheTag.Aot]),
            [CachePolicyId.PublicAotRegistry] = new(CachePolicyId.PublicAotRegistry, "public", "aot-registry", TimeSpan.FromMinutes(5), TimeSpan.FromDays(30), null, [CacheTag.Aot], false, 0d, false),
            [CachePolicyId.SecurityBlockedUser] = new(CachePolicyId.SecurityBlockedUser, "sec", "blocked-user", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(20), null, null, true, 0d, false),
            [CachePolicyId.SecurityMfaChallenge] = new(CachePolicyId.SecurityMfaChallenge, "sec", "mfa-challenge", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true, 0d, false),
            [CachePolicyId.SecurityMfaProof] = new(CachePolicyId.SecurityMfaProof, "sec", "mfa-proof", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true, 0d, false),
            [CachePolicyId.SecurityPowRisk] = new(CachePolicyId.SecurityPowRisk, "sec", "pow-risk", TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(2), null, null, true, 0d, false),
            [CachePolicyId.SecurityBlacklistUser] = new(CachePolicyId.SecurityBlacklistUser, "sec", "blacklist-user", TimeSpan.FromMinutes(2), Timeout.InfiniteTimeSpan, null, null, true, 0d, false),
            [CachePolicyId.VisitLock] = new(CachePolicyId.VisitLock, "sec", "visit-lock", TimeSpan.Zero, TimeSpan.FromMinutes(30), null, null, true, 0d, false),
            [CachePolicyId.ArticleViewLock] = new(CachePolicyId.ArticleViewLock, "sec", "article-view-lock", TimeSpan.Zero, TimeSpan.FromHours(1), null, null, true, 0d, false),
            [CachePolicyId.SecurityPasskeyRegChallenge] = new(CachePolicyId.SecurityPasskeyRegChallenge, "sec", "pk-reg", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.SecurityPasskeyAuthChallenge] = new(CachePolicyId.SecurityPasskeyAuthChallenge, "sec", "pk-auth", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.SecurityRecoveryKeyAttempt] = new(CachePolicyId.SecurityRecoveryKeyAttempt, "sec", "rk-attempt", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true, 0d, false),
            [CachePolicyId.SecurityRecoveryKeySession] = new(CachePolicyId.SecurityRecoveryKeySession, "sec", "rk-session", TimeSpan.Zero, TimeSpan.FromMinutes(10), null, null, true, 0d, false),
            [CachePolicyId.SecurityChallengeProof] = new(CachePolicyId.SecurityChallengeProof, "sec", "challenge-proof", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.SecurityCaptchaChallenge] = new(CachePolicyId.SecurityCaptchaChallenge, "sec", "captcha-challenge", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.SecurityPoSpaceChallenge] = new(CachePolicyId.SecurityPoSpaceChallenge, "sec", "pospace-challenge", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.AnonymousCommentTicket] = new(CachePolicyId.AnonymousCommentTicket, "sec", "anonymous-comment-ticket", TimeSpan.Zero, TimeSpan.FromMinutes(2), null, null, true, 0d, false),
            [CachePolicyId.AnonymousCommentPolicyVersion] = new(CachePolicyId.AnonymousCommentPolicyVersion, "sec", "anonymous-comment-policy-version", TimeSpan.FromMinutes(1), TimeSpan.FromDays(7), null, null, true, 0d, false),
            [CachePolicyId.SecurityPerceptionChallenge] = new(CachePolicyId.SecurityPerceptionChallenge, "sec", "perception-challenge", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.SiteSubscriptionUnsubscribeProof] = new(CachePolicyId.SiteSubscriptionUnsubscribeProof, "sec", "site-subscription-unsubscribe-proof", TimeSpan.Zero, TimeSpan.FromMinutes(15), null, null, true, 0d, false),
            [CachePolicyId.SecurityChallengeVerifyRateLimit] = new(CachePolicyId.SecurityChallengeVerifyRateLimit, "sec", "challenge-verify-rate", TimeSpan.Zero, TimeSpan.FromMinutes(2), null, null, true, 0d, false),
            [CachePolicyId.HumanReadProof] = new(CachePolicyId.HumanReadProof, "sec", "human-read-proof", TimeSpan.Zero, TimeSpan.FromDays(1), null, null, true, 0d, false),
            [CachePolicyId.SecurityPowProof] = new(CachePolicyId.SecurityPowProof, "sec", "pow-proof", TimeSpan.Zero, TimeSpan.FromMinutes(5), null, null, true, 0d, false),
            [CachePolicyId.NotificationStreamDrillNonce] = new(CachePolicyId.NotificationStreamDrillNonce, "sec", "notification-drill-nonce", TimeSpan.Zero, TimeSpan.FromMinutes(1), null, null, true, 0d, false),
            [CachePolicyId.ArticleListFrame] = new(CachePolicyId.ArticleListFrame, "blog", "article-list-frame", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.ArticleList, CacheTag.Category], false, 0.10d, false),
            [CachePolicyId.ArticleDetailFrame] = new(CachePolicyId.ArticleDetailFrame, "blog", "article-detail-frame", TimeSpan.FromMinutes(5), TimeSpan.FromHours(1), null, [CacheTag.ArticleList], false, 0.10d, false),
            [CachePolicyId.ArticleHotFrame] = new(CachePolicyId.ArticleHotFrame, "blog", "article-hot-frame", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.HotArticles], false, 0.10d),
            [CachePolicyId.TopArticlesFrame] = new(CachePolicyId.TopArticlesFrame, "blog", "top-articles-frame", TimeSpan.FromMinutes(2), TimeSpan.FromHours(2), null, [CacheTag.HotArticles], false, 0d, false),
            [CachePolicyId.CommentCursorFrame] = new(CachePolicyId.CommentCursorFrame, "blog", "comment-cursor-frame", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.UserCommentCursorFrame] = new(CachePolicyId.UserCommentCursorFrame, "blog", "user-comment-cursor-frame", TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), null, [CacheTag.Stats]),
            [CachePolicyId.CategoryFrame] = new(CachePolicyId.CategoryFrame, "blog", "category-frame", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.Category], false, 0.10d, false),
            [CachePolicyId.TagFrame] = new(CachePolicyId.TagFrame, "blog", "tag-frame", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.Tag], false, 0.10d, false),
            [CachePolicyId.AdminStatsFrame] = new(CachePolicyId.AdminStatsFrame, "admin", "stats-frame", TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(10), null, [CacheTag.Stats], false, 0.10d, false),
            [CachePolicyId.BackgroundWorkerLease] = new(CachePolicyId.BackgroundWorkerLease, "runtime", "worker-lease", TimeSpan.Zero, TimeSpan.FromSeconds(30), null, null, false, 0d, false)
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
