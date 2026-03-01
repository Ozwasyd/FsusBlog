namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 后台管理概览统计数据
/// 保持 class：作为大型聚合根，且内部持有 List<T> 引用类型
/// </summary>
public class SiteStatsDto
{
    // --- 1. 内容指标 (Content Metrics) ---
    public int TotalArticles { get; set; }      // 文章总数（非删除）
    public int TotalComments { get; set; }      // 评论总数
    public int TrashCount { get; set; }         // 回收站文章数

    // --- 2. 访问指标 (Traffic Metrics - 新增) ---
    public int TotalVisits { get; set; }        // 总访问量
    public int RegisteredVisits { get; set; }   // 注册用户访问量
    public int AnonymousVisits { get; set; }    // 匿名访客访问量

    // --- 3. 深度数据 (Detailed Collections) ---
    public List<PopularArticleDto> PopularArticles { get; set; } = [];
    public List<RecentCommentDto> RecentComments { get; set; } = [];
    public List<RegionDistributionDto> RegionDistributions { get; set; } = [];
}

/// <summary>
/// 热门文章
/// 修复日期: 2026-02-23 (重构为 record struct 以实现零分配)
/// </summary>
public record struct PopularArticleDto
{
    public int Id { get; set; }
    public string Title { get; set; }
    public int Views { get; set; }

    // 为结构体提供无参构造函数
    public PopularArticleDto()
    {
        Title = string.Empty;
    }
}

/// <summary>
/// 最新评论
/// 修复日期: 2026-02-23 (重构为 record struct 以实现零分配)
/// </summary>
public record struct RecentCommentDto
{
    // 恢复 UserId 字段，严格遵守原设计
    public int? UserId { get; set; }
    public string UserName { get; set; }
    public string Content { get; set; }
    public DateTime CreateTime { get; set; }

    // 为结构体提供无参构造函数
    public RecentCommentDto()
    {
        UserName = "匿名";
        Content = string.Empty;
    }
}

/// <summary>
/// 地域分布项
/// 修复日期: 2026-02-23 (重构为 record struct 以实现零分配)
/// </summary>
public record struct RegionDistributionDto
{
    /// <summary>
    /// 地区名称 (如：中国-广东省-深圳市)
    /// </summary>
    public string Region { get; set; }
    public int Count { get; set; }

    public RegionDistributionDto()
    {
        Region = "未知地区";
    }
}