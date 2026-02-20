using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Models.Dtos;

public class ArticleDto
{
    public required string Title { get; set; }
    public required string Content { get; set; }
    public required string Summary { get; set; }
    public int CategoryId { get; set; }
    public List<int> TagIds { get; set; } = []; // 前端只传 ID 集合
}

/// <summary>
/// 文章列表展示专用的 DTO
/// </summary>
public class ArticleListDto
{
    public int Id { get; set; }

    public string Title { get; set; } = null!;

    public string? Summary { get; set; } // 文章摘要
    public string? Snippet { get; set; }

    public int Views { get; set; }

    public DateTime CreateTime { get; set; }

    // 实体类里是 CategoryId(int)，
    // 但前端列表页通常需要直接显示 分类名称(string)
    public string CategoryName { get; set; } = null!;

    // 标签也只需要简单的 ID 和名称
    public List<TagDto> Tags { get; set; } = [];

    public bool? IsDeleted { get; set; }
}

public class TagDto
{
    public int Id { get; set; }
    public string Name { get; set; } = null!;
}

public class PageResultDto<T>
{
    public List<T> Items { get; set; } = [];
    public int Total { get; set; }
}

public class CategoryDto
{
    public int Id { get; set; }
    public required string Name { get; set; }

    // 前端表格需要的统计字段
    public int ArticleCount { get; set; }
}

public class ArticleNoticeDto
{
    public int ArticleId { get; set; }

    /// <summary>
    /// 操作类型: "Created", "Updated", "Deleted", "Restored"
    /// </summary>
    public string Action { get; set; } = null!;

    public DateTime EventTime { get; set; } = DateTime.UtcNow;
}

public class SearchDto : IPowRequest
{
    // 业务参数
    [FromQuery(Name = "keyword")]
    public string Keyword { get; set; } = string.Empty;

    // ==========================================
    // Name 属性与前端 Axios 发送的字段名完全一致
    // ==========================================

    [FromQuery(Name = "powSalt")]
    public string PowSalt { get; set; } = string.Empty;

    [FromQuery(Name = "powSignature")]
    public string PowSignature { get; set; } = string.Empty;

    [FromQuery(Name = "powTimestamp")]
    public long PowTimestamp { get; set; }

    [FromQuery(Name = "difficulty")]
    public int Difficulty { get; set; }

    [FromQuery(Name = "powNonce")]
    public string PowNonce { get; set; } = string.Empty;

    [FromQuery(Name = "browserFp")]
    public string BrowserFp { get; set; } = string.Empty;
}