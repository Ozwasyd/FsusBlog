using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 标签管理控制器：维护多对多关联元数据
/// </summary>
[Route("api/[controller]")]
[ApiController]
public class TagController(
    ISqlSugarClient _db,
    ILogger<TagController> _logger) : ControllerBase
{
    /// <summary>
    /// 获取标签列表（包含关联文章统计）
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<ApiResponse<object>>> GetAll()
    {
        // 🌟 性能重构：聚合统计每个标签下的有效文章数
        var list = await _db.Queryable<Tag>()
            .Select(t => new
            {
                t.Id,
                t.Name,
                ArticleCount = SqlFunc.Subqueryable<ArticleTag>()
                    .Where(at => at.TagId == t.Id)
                    .Count()
            })
            .OrderBy(t => t.Id)
            .ToListAsync();

        return Ok(ApiResponse<object>.Success(list));
    }

    /// <summary>
    /// 创建新标签
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPost]
    public async Task<ActionResult<ApiResponse<int>>> Create([FromBody] Tag dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return BadRequest(ApiResponse<int>.Fail("标签名称不能为空"));

        // 1. 查重
        bool exists = await _db.Queryable<Tag>().AnyAsync(t => t.Name == dto.Name.Trim());
        if (exists)
            return BadRequest(ApiResponse<int>.Fail($"标签 [{dto.Name}] 已存在"));

        // 2. 插入并返回主键
        dto.Name = dto.Name.Trim();
        var newId = await _db.Insertable(dto).ExecuteReturnIdentityAsync();

        if (newId > 0)
        {
            _logger.LogInformation("管理员 {User} 创建了新标签: {TagName}", User.Identity?.Name, dto.Name);
            return Ok(ApiResponse<int>.Success(newId, "标签创建成功"));
        }

        return StatusCode(500, ApiResponse<int>.Fail("标签创建失败，数据库写入异常"));
    }

    /// <summary>
    /// 更新标签名称
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse>> Update(int id, [FromBody] Tag dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return BadRequest(ApiResponse.Fail("标签名称不能为空"));

        // 1. 查重（排除自身 ID）
        bool exists = await _db.Queryable<Tag>()
             .Where(t => t.Name == dto.Name.Trim() && t.Id != id)
             .AnyAsync();

        if (exists)
            return BadRequest(ApiResponse.Fail($"标签名称 [{dto.Name}] 已被其他记录占用"));

        // 2. 执行更新
        var updateCount = await _db.Updateable<Tag>()
             .SetColumns(t => t.Name == dto.Name.Trim())
             .Where(t => t.Id == id)
             .ExecuteCommandAsync();

        if (updateCount > 0)
        {
            _logger.LogInformation("管理员 {User} 更新了标签 ID:{Id} 为 {NewName}", User.Identity?.Name, id, dto.Name);
            return Ok(ApiResponse.Success("标签更新成功"));
        }

        return NotFound(ApiResponse.Fail("目标标签不存在", 404));
    }

    /// <summary>
    /// 物理删除标签（包含中间表清理）
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        // 🌟 核心点：通过 Ado 事务确保数据完整性
        var result = await _db.Ado.UseTranAsync(async () =>
        {
            // 1. 先清理中间表关联 (ArticleTag)
            await _db.Deleteable<ArticleTag>().Where(at => at.TagId == id).ExecuteCommandAsync();

            // 2. 再删除标签本体
            await _db.Deleteable<Tag>().In(id).ExecuteCommandAsync();
        });

        if (result.IsSuccess)
        {
            _logger.LogWarning("审计：管理员 {User} 删除了标签 ID:{Id} 及其关联关系", User.Identity?.Name, id);
            return Ok(ApiResponse.Success("标签及其关联关系已彻底删除"));
        }

        // 事务失败处理
        _logger.LogError("标签删除事务失败 | ID: {Id} | 错误: {Msg}", id, result.ErrorMessage);
        return StatusCode(500, ApiResponse.Fail($"删除失败：{result.ErrorMessage}", 500));
    }
}