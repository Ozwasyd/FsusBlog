namespace FsusBlog.Server.Infrastructure.Cache;

public enum CachePolicyId
{
    None = 0,
    ArticleList = 1,
    ArticleDetail = 2,
    ArticleHot = 3,
    ArticleSearch = 4,
    ArticleRss = 5,
    ArticleListVersion = 6,
    TopArticles = 7,
    CommentCursor = 8,
    UserCommentCursor = 9,
    SystemSeo = 10,
    SystemPage = 11,
    AdminStats = 12,
    MessageUnread = 13,
    MessageGlobalVersion = 14,
    PublicAotDocument = 15,
    PublicAotRegistry = 16,
    SecurityBlockedUser = 17,
    SecurityMfaChallenge = 18,
    SecurityMfaProof = 19,
    SecurityPowRisk = 20,
    SecurityBlacklistUser = 21,
    VisitLock = 22,
    ArticleViewLock = 23,
    SecurityPasskeyRegChallenge = 24,
    SecurityPasskeyAuthChallenge = 25,
    HumanReadProof = 26,
    SecurityPowProof = 27
}
