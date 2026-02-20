namespace FsusBlog.Server.Models.Dtos;

public class SeoConfigDto
{
    // 基础 SEO
    public string Title { get; set; } = "Fsus's Blog";
    public string Description { get; set; } = "FORWARD";
    public string Keywords { get; set; } = "记录";
    public string Author { get; set; } = "Fsu";

    // 扩展 SEO (用于社交媒体分享卡片)
    public string OgImage { get; set; } = ""; // 网站封面图 URL
    public string BaseUrl { get; set; } = "https://blog.fsus.blog";
}

// 数据传输对象 (DTO)
public class PageContentDto
{
    public string? Slug { get; set; }
    public string? Content { get; set; } // 存储 Markdown 字符串
}