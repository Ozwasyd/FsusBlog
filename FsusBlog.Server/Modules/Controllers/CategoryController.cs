using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.OutputCaching;
using SqlSugar;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 文章分类管理控制器 (Write Side)
/// 修复日期: 2026-02-23 (引入零分配日志，优化查重逻辑)
/// </summary>
[Route("api/[controller]")]
[ApiController]
[Authorize(Roles = "admin")]
public partial class CategoryController( // partial for logger
    ISqlSugarClient _db,
    IOutputCacheStore _cacheStore,
    ILogger<CategoryController> _logger) : ControllerBase
{
    private const string CacheTag = "Category";

    /// <summary>
    /// 新增分类
    /// </summary>
    [HttpPost]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Create([FromBody] CategoryDto dto)
    {
        var trimmedName = dto.Name.Trim();
        if (string.IsNullOrWhiteSpace(trimmedName))
            return BadRequest(ApiResponse.Fail("分类名称不能为空"));

        bool exists = await _db.Queryable<Category>().AnyAsync(c => c.Name == trimmedName);
        if (exists)
            return BadRequest(ApiResponse.Fail($"分类“{trimmedName}”已存在"));

        var category = new Category { Name = trimmedName };
        var success = await _db.Insertable(category).ExecuteCommandAsync() > 0;

        if (success)
        {
            LogCategoryCreated(User.GetUserName(), trimmedName);
            await _cacheStore.EvictByTagAsync(CacheTag, default);
            return ApiResponse.Success("分类创建成功");
        }

        return StatusCode(500, ApiResponse.Fail("由于数据库写入异常，分类创建失败"));
    }

    /// <summary>
    /// 修改分类
    /// </summary>
    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse>> Update(int id, [FromBody] CategoryDto dto)
    {
        var trimmedName = dto.Name.Trim();
        if (string.IsNullOrWhiteSpace(trimmedName))
            return BadRequest(ApiResponse.Fail("分类名称不能为空"));

        bool exists = await _db.Queryable<Category>()
            .Where(c => c.Name == trimmedName && c.Id != id)
            .AnyAsync();

        if (exists)
            return BadRequest(ApiResponse.Fail($"该分类名称“{trimmedName}”已被其他分类占用"));

        var updateCount = await _db.Updateable<Category>()
             .SetColumns(c => c.Name == trimmedName)
             .Where(c => c.Id == id)
             .ExecuteCommandAsync();

        if (updateCount > 0)
        {
            LogCategoryUpdated(User.GetUserName(), id, trimmedName);
            await _cacheStore.EvictByTagAsync(CacheTag, default);
            return ApiResponse.Success("分类更新成功");
        }

        return NotFound(ApiResponse.Fail("操作失败：未找到对应的分类记录"));
    }

    /// <summary>
    /// 删除分类
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        bool hasArticles = await _db.Queryable<Article>()
            .AnyAsync(a => a.CategoryId == id && !a.IsDeleted);

        if (hasArticles)
        {
            LogUnsafeDeleteAttempt(id);
            return BadRequest(ApiResponse.Fail("无法删除：该分类下仍有关联文章，请先迁移文章到其他分类"));
        }

        var deleteCount = await _db.Deleteable<Category>().In(id).ExecuteCommandAsync();

        if (deleteCount > 0)
        {
            LogCategoryDeleted(User.GetUserName(), id);
            await _cacheStore.EvictByTagAsync(CacheTag, default);
            return ApiResponse.Success("分类及统计信息已移除");
        }

        return NotFound(ApiResponse.Fail("操作失败：目标分类不存在或已被删除"));
    }

    // ==========================================
    // 高性能日志源生成器
    // ==========================================

    [LoggerMessage(EventId = 1, Level = LogLevel.Information, Message = "审计：管理员 {AdminName} 创建了分类 [{CategoryName}]")]
    private partial void LogCategoryCreated(string adminName, string categoryName);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "审计：管理员 {AdminName} 更新了分类 ID:{CategoryId} 为 [{NewName}]")]
    private partial void LogCategoryUpdated(string adminName, int categoryId, string newName);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "拦截到不安全的删除尝试：分类 ID:{CategoryId} 下仍有关联文章")]
    private partial void LogUnsafeDeleteAttempt(int categoryId);

    [LoggerMessage(EventId = 4, Level = LogLevel.Warning, Message = "审计：管理员 {AdminName} 执行了分类物理删除 | ID: {CategoryId}")]
    private partial void LogCategoryDeleted(string adminName, int categoryId);
}