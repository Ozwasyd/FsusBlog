namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// 后台管理概览统计数据
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
    public List<PopularArticleDto> PopularArticles { get; set; } = new();
    public List<RecentCommentDto> RecentComments { get; set; } = new();

    /// <summary>
    /// 地域分布统计
    /// 格式遵循: 国家-省份-城市
    /// </summary>
    public List<RegionDistributionDto> RegionDistributions { get; set; } = new();
}

/// <summary>
/// 热门文章
/// </summary>
public class PopularArticleDto
{
    public int Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public int Views { get; set; }
}

/// <summary>
/// 最新评论
/// </summary>
public class RecentCommentDto
{
    public int? UserId { get; set; }             // 用户ID
    public string UserName { get; set; } = "匿名"; // 用户名
    public string Content { get; set; } = string.Empty;
    public DateTime CreateTime { get; set; }
}

/// <summary>
/// 地域分布项
/// </summary>
public class RegionDistributionDto
{
    /// <summary>
    /// 地区名称 (如：中国-广东省-深圳市)
    /// </summary>
    public string Region { get; set; } = "未知地区";
    public int Count { get; set; }
}