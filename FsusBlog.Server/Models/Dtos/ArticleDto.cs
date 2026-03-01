using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models) - 保持 Class
// ==========================================

public class ArticleDto
{
    public required string Title { get; set; }
    public required string Content { get; set; }
    public string? Summary { get; set; }
    public int CategoryId { get; set; }
    public List<int> TagIds { get; set; } = [];
}

public class SearchDto
{
    public string Keyword { get; set; } = string.Empty;
}

// ==========================================
// 2. 输出 DTO (Response Models) - 重构为 Struct
// ==========================================

/// <summary>
/// 对齐前端 article.category.name 的嵌套视图
/// </summary>
public readonly record struct ArticleCategoryView(int Id, string Name);

/// <summary>
/// 文章列表视图
/// 修复日期: 2026-02-23 (补全 CategoryId 字段)
/// </summary>
public record struct ArticleListDto
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string? Summary { get; set; }
    public string? Snippet { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }
    public bool? IsDeleted { get; set; }

    public ArticleListDto() { Title = string.Empty; Category = default; Tags = []; }
}


/// <summary>
/// 标签精简视图 (用于文章列表内嵌)
/// </summary>
public readonly record struct TagDto(int Id, string Name);

/// <summary>
/// 标签列表视图 (带文章计数)
/// 修复日期: 2026-02-23 (正式定义于 DTO 文件，保持内聚性)
/// </summary>
public readonly record struct TagWithCountDto(int Id, string Name, int ArticleCount);

/// <summary>
/// 分类视图 (带文章计数)
/// </summary>
public record struct CategoryDto
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public int ArticleCount { get; set; }
}

public readonly record struct ArticleNoticeDto
{
    public int ArticleId { get; init; }
    public string Action { get; init; }
    public DateTime EventTime { get; init; }

    public ArticleNoticeDto(int articleId, string action, DateTime eventTime)
    {
        ArticleId = articleId;
        Action = action;
        EventTime = eventTime;
    }

    public ArticleNoticeDto() : this(0, string.Empty, DateTime.UtcNow) { }
}

/// <summary>
/// 文章列表查询参数
/// 修复日期: 2026-02-23 (迁移至 DTO 文件集中管理，适配 Minimal API AsParameters)
/// </summary>
public readonly record struct ArticleQueryRequestDto(
    int Page = 1,
    int Size = 10,
    int? CategoryId = null,
    int? TagId = null,
    bool IsDeleted = false);

// ==========================================
// 3. 通用泛型容器 - 保持 Class
// ==========================================

public class PageResultDto<T>
{
    public List<T> Items { get; set; } = [];
    public int Total { get; set; }
}

/// <summary>
/// 文章创建/更新成功的响应载荷
/// </summary>
public readonly record struct ArticleMutationResponseDto(int Id);

/// <summary>
/// 清空回收站的响应载荷
/// </summary>
public readonly record struct TrashClearResponseDto(int Count);

/// <summary>
/// 文章详情视图 (零分配)
/// </summary>
public record struct ArticleDetailDto
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string Content { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }
}