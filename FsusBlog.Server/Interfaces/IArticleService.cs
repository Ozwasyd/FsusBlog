using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Interfaces;

public interface IArticleService
{
    Task<PageResultDto<ArticleListDto>> GetPageListAsync(int page, int size, int? categoryId, int? tagId, bool isDeleted = false);

    /// <summary>
    /// 获取文章详情
    /// </summary>
    Task<Article?> GetByIdAsync(int id);

    /// <summary>
    /// 发布文章（包含存数据库 + 建索引）
    /// </summary>
    Task<int> CreateAsync(ArticleDto dto);
    /// <summary>
    /// 更新文章（包含存数据库 + 建索引）
    /// </summary>
    Task<bool> UpdateAsync(int id, ArticleDto dto);

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
    /// 搜索文章（从 Lucene 查，或者从数据库查）
    /// </summary>
    Task<List<ArticleListDto>> SearchArticlesAsync(string keyword);

    /// <summary>
    /// 获取热门文章排行榜
    /// </summary>
    /// <param name="count">获取数量，默认 10 条</param>
    Task<List<PopularArticleDto>> GetHotArticlesAsync(int count = 10);

    /// <summary>
    /// 高性能增加阅读量：同步更新 DB、热榜 Score 并失效详情缓存
    /// </summary>
    ValueTask IncreaseViewCountAsync(int id);
}
