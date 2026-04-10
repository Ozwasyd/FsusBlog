using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public sealed record class ArticleDto
{
    public required string Title { get; init; }
    public required string Content { get; init; }
    public string? Summary { get; init; }
    public int CategoryId { get; init; }
    public List<int> TagIds { get; init; } = [];
    public PublicAotShellBundleContract? AotBundle { get; init; }
}

public sealed record class SearchDto
{
    public string Keyword { get; init; } = string.Empty;
}
public readonly record struct ArticleQueryRequestDto(
    int Page = 1,
    int Size = 10,
    int? CategoryId = null,
    int? TagId = null,
    bool IsDeleted = false);
