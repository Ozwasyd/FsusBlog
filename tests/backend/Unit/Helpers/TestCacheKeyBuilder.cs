using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.Unit;

internal static class TestCacheKeyBuilder
{
    private const string Prefix = "pod:v1:";
    private const string PublicAotPrefix = "public:aot:v2:";

    public static string ArticleList(int page, int size, int? categoryId, int? tagId, bool isDeleted)
        => string.Concat(Prefix, "article:list:", page.ToString(), ":", size.ToString(), ":", categoryId?.ToString() ?? "0", ":", tagId?.ToString() ?? "0", ":", isDeleted ? "1" : "0");

    public static string ArticleDetail(int id) => string.Concat(Prefix, "article:detail:", id.ToString());

    public static string ArticleHot(int count) => string.Concat(Prefix, "article:hot:", count.ToString());

    public static string ArticleSearch(string keyword) => string.Concat(Prefix, "article:search:", keyword);

    public static string CommentCursor(int articleId, long? cursor, int limit)
        => string.Concat(Prefix, "comment:article:", articleId.ToString(), ":", cursor?.ToString() ?? "0", ":", limit.ToString());

    public static string UserCommentCursor(int userId, long? cursor, int limit)
        => string.Concat(Prefix, "comment:user:", userId.ToString(), ":", cursor?.ToString() ?? "0", ":", limit.ToString());

    public static string AdminStats() => string.Concat(Prefix, "stats:admin");

    public static string PublicAotShell(PublicPageId pageId, string routeKey)
        => string.Concat(PublicAotPrefix, ((int)pageId).ToString(), ":", routeKey);
}
