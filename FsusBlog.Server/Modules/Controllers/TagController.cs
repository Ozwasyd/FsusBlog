using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers; // 引入 GetUserName 扩展
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 标签管理控制器 (Write Side)
/// 修复日期: 2026-02-23 (CQRS 重构，引入零分配日志与响应)
/// </summary>
[Route("api/[controller]")]
[ApiController]
[Authorize(Roles = "admin")] // 权限提升到类级别
public partial class TagController( // 声明为 partial
    ISqlSugarClient _db,
    IHttpCacheInvalidator _httpCacheInvalidator,
    ILogger<TagController> _logger) : ControllerBase
{
    /// <summary>
    /// 创建新标签
    /// </summary>
    [HttpPost]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<int>>> Create([FromBody] Tag dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return ControllerResults.BadRequest<int>("标签名称不能为空", HttpContext.TraceIdentifier);

        var trimmedName = dto.Name.Trim();

        bool exists = await _db.Queryable<Tag>().AnyAsync(t => t.Name == trimmedName);
        if (exists)
            return ControllerResults.BadRequest<int>($"标签 [{trimmedName}] 已存在", HttpContext.TraceIdentifier);

        dto.Name = trimmedName;
        var newId = await _db.Insertable(dto).ExecuteReturnIdentityAsync();

        if (newId > 0)
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.create"),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            LogTagCreated(User.GetUserName(), trimmedName);
            await _httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            return ApiResponse<int>.Success(newId, "标签创建成功");
        }

        return ControllerResults.Status<int>(500, "标签创建失败，数据库写入异常", HttpContext.TraceIdentifier);
    }

    /// <summary>
    /// 更新标签名称
    /// </summary>
    [HttpPut("{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Update(int id, [FromBody] Tag dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return ControllerResults.BadRequest("标签名称不能为空", HttpContext.TraceIdentifier);

        var trimmedName = dto.Name.Trim();

        bool exists = await _db.Queryable<Tag>()
             .Where(t => t.Name == trimmedName && t.Id != id)
             .AnyAsync();

        if (exists)
            return ControllerResults.BadRequest($"标签名称 [{trimmedName}] 已被其他记录占用", HttpContext.TraceIdentifier);

        var updateCount = await _db.Updateable<Tag>()
             .SetColumns(t => t.Name == trimmedName)
             .Where(t => t.Id == id)
             .ExecuteCommandAsync();

        if (updateCount > 0)
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.update"),
                new KeyValuePair<string, object?>("TagId", id),
                new KeyValuePair<string, object?>("TagName", trimmedName));
            LogTagUpdated(User.GetUserName(), id, trimmedName);
            await _httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            return ApiResponse.Success("标签更新成功");
        }

        return ControllerResults.NotFound("目标标签不存在", HttpContext.TraceIdentifier);
    }

    /// <summary>
    /// 物理删除标签（包含中间表清理）
    /// </summary>
    [HttpDelete("{id}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            await _db.Deleteable<ArticleTag>().Where(at => at.TagId == id).ExecuteCommandAsync();
            await _db.Deleteable<Tag>().In(id).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            using var _ = AuditLogScope.Push(
                AuditSourceCatalog.Tag,
                AuditTypeCatalog.Audit,
                new KeyValuePair<string, object?>("AuditAction", "tag.delete"),
                new KeyValuePair<string, object?>("TagId", id));
            LogTagDeleted(User.GetUserName(), id);
            await _httpCacheInvalidator.InvalidateAsync(CacheTag.Tag, CacheTag.ArticleList);
            return ApiResponse.Success("标签及其关联关系已彻底删除");
        }

        _logger.LogError(result.ErrorException, "标签删除事务失败 | ID: {Id} | 错误: {Msg}", id, result.ErrorMessage);
        return ControllerResults.Status(500, $"删除失败：{result.ErrorMessage}", HttpContext.TraceIdentifier);
    }

    // ==========================================
    // 高性能日志源生成器
    // ==========================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Information,
        Message = "审计：管理员 {AdminName} 创建了新标签: {TagName}")]
    private partial void LogTagCreated(string adminName, string tagName);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Information,
        Message = "审计：管理员 {AdminName} 更新了标签 ID:{TagId} 为 {NewName}")]
    private partial void LogTagUpdated(string adminName, int tagId, string newName);

    [LoggerMessage(
        EventId = 3,
        Level = LogLevel.Warning,
        Message = "审计：管理员 {AdminName} 删除了标签 ID:{TagId} 及其关联关系")]
    private partial void LogTagDeleted(string adminName, int tagId);

}
