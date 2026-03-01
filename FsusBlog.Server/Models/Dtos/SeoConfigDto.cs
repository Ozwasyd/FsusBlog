namespace FsusBlog.Server.Models.Dtos;

/// <summary>
/// SEO 配置模型
/// 修复日期: 2026-02-23 (重构为 readonly record struct，在元数据生成等高频场景下实现零分配)
/// </summary>
public readonly record struct SeoConfigDto
{
    // 基础 SEO
    public string Title { get; init; }
    public string Description { get; init; }
    public string Keywords { get; init; }
    public string Author { get; init; }

    // 扩展 SEO (用于社交媒体分享卡片)
    public string OgImage { get; init; } // 网站封面图 URL
    public string BaseUrl { get; init; }

    // 结构体必须有显式构造函数来初始化所有字段（或使用默认值）
    public SeoConfigDto()
    {
        Title = "Fsus's Blog";
        Description = "FORWARD";
        Keywords = "记录";
        Author = "Fsu";
        OgImage = "";
        BaseUrl = "https://blog.fsus.blog";
    }
}

/// <summary>
/// 动态页面内容传输对象
/// 修复日期: 2026-02-23 (重构为 readonly record struct，作为纯数据载体实现零分配)
/// </summary>
public readonly record struct PageContentDto
{
    public string? Slug { get; init; }
    public string? Content { get; init; } // 存储 Markdown 字符串
}