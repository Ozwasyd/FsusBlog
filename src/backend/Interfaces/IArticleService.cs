using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Models.Requests;

namespace FsusBlog.Server.Interfaces;

public interface IArticleService
{
    Task<ArticleListPageReadModel> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted = false, int? status = null, bool includePrivate = false);

    /// <summary>
    /// 获取文章详情
    /// </summary>
    Task<ArticleDetailReadModel?> GetByIdAsync(int id, bool includePrivate = false);

    /// <summary>
    /// 发布文章（包含存数据库 + 建索引）
    /// </summary>
    Task<int> CreateAsync(CreateArticleRequest request);
    /// <summary>
    /// 更新文章（包含存数据库 + 建索引）
    /// </summary>
    Task<bool> UpdateAsync(int id, UpdateArticleRequest request);

    /// <summary>
    /// 删除文章（包含存数据库 + 建索引）
    /// </summary>
    Task<bool> DeleteAsync(int id);
    /// <summary>
    /// 恢复文章（包含存数据库 + 建索引）
    /// </summary>
    Task<bool> RestoreAsync(int id);

    /// <summary>
    /// 彻底删除文章及其所有插图（不可恢复）
    /// </summary>
    Task<bool> PermanentlyDeleteArticleAsync(int id);
    /// <summary>
    /// 清除回收站
    /// </summary>
    Task<int> ClearTrashAsync();

    /// <summary>
    /// 搜索文章（优先使用本地搜索索引链，必要时回落到数据库查）
    /// </summary>
    Task<List<ArticleListItemReadModel>> SearchArticlesAsync(string keyword);

    /// <summary>
    /// 获取热门文章排行榜
    /// </summary>
    /// <param name="count">获取数量，默认 10 条</param>
    Task<List<PopularArticleSummaryDto>> GetHotArticlesAsync(int count = 10);

    /// <summary>
    /// 获取精选文章
    /// </summary>
    Task<List<FeaturedArticleSummaryDto>> GetFeaturedArticlesAsync(int size);

    /// <summary>
    /// 高性能增加阅读量：同步更新 DB、热榜 Score 并失效详情缓存
    /// </summary>
    ValueTask IncreaseViewCountAsync(int id);

    /// <summary>
    /// 高性能批量增加阅读量：按聚合计数减少后台写入往返
    /// </summary>
    ValueTask IncreaseViewCountAsync(int id, int count);

    /// <summary>
    /// 批量增加阅读量，并返回实际命中非删除文章的 id 集合。
    /// </summary>
    ValueTask<IReadOnlySet<int>> IncreaseViewCountsAsync(
        IReadOnlyDictionary<int, int> articleCounts,
        CancellationToken cancellationToken = default);
}
