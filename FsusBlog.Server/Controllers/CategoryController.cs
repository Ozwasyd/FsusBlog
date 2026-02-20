using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 文章分类控制器：管理博客内容的层级归类
/// </summary>
[Route("api/[controller]")]
[ApiController]
public class CategoryController(
    ISqlSugarClient _db,
    ILogger<CategoryController> _logger) : ControllerBase
{
    /// <summary>
    /// 获取分类列表（带实时文章计数）
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<ApiResponse<List<CategoryDto>>>> GetAll()
    {
        // 🚀 高性能：在 SQL 层面通过子查询统计未删除的文章总数
        var list = await _db.Queryable<Category>()
            .Select(c => new CategoryDto
            {
                Id = c.Id,
                Name = c.Name,
                ArticleCount = SqlFunc.Subqueryable<Article>()
                    .Where(a => a.CategoryId == c.Id && a.IsDeleted == false)
                    .Count()
            })
            .OrderBy(c => c.Id)
            .ToListAsync();

        return Ok(ApiResponse<List<CategoryDto>>.Success(list));
    }

    /// <summary>
    /// 新增分类 (仅管理员)
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPost]
    public async Task<ActionResult<ApiResponse>> Create([FromBody] CategoryDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return BadRequest(ApiResponse.Fail("分类名称不能为空"));

        // 1. 查重：防止同名分类产生
        bool exists = await _db.Queryable<Category>().AnyAsync(c => c.Name == dto.Name);
        if (exists)
            return BadRequest(ApiResponse.Fail($"分类“{dto.Name}”已存在"));

        // 2. 插入执行
        var category = new Category { Name = dto.Name };
        var success = await _db.Insertable(category).ExecuteCommandAsync() > 0;

        if (success)
        {
            _logger.LogInformation("审计日志：管理员创建了分类 [{Name}]", dto.Name);
            return Ok(ApiResponse.Success("分类创建成功"));
        }

        return StatusCode(500, ApiResponse.Fail("由于数据库写入异常，分类创建失败"));
    }

    /// <summary>
    /// 修改分类 (仅管理员)
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPut("{id}")]
    public async Task<ActionResult<ApiResponse>> Update(int id, [FromBody] CategoryDto dto)
    {
        if (string.IsNullOrWhiteSpace(dto.Name))
            return BadRequest(ApiResponse.Fail("分类名称不能为空"));

        // 1. 查重：确保不与现有的其他分类重名
        bool exists = await _db.Queryable<Category>()
            .Where(c => c.Name == dto.Name && c.Id != id)
            .AnyAsync();

        if (exists)
            return BadRequest(ApiResponse.Fail($"该分类名称“{dto.Name}”已被其他分类占用"));

        // 2. 更新执行
        var updateCount = await _db.Updateable<Category>()
             .SetColumns(c => c.Name == dto.Name)
             .Where(c => c.Id == id)
             .ExecuteCommandAsync();

        if (updateCount > 0)
        {
            _logger.LogInformation("审计日志：管理员更新了分类 ID:{Id} 为 [{NewName}]", id, dto.Name);
            return Ok(ApiResponse.Success("分类更新成功"));
        }

        return NotFound(ApiResponse.Fail("操作失败：未找到对应的分类记录"));
    }

    /// <summary>
    /// 删除分类 (带强一致性引用检查)
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpDelete("{id}")]
    public async Task<ActionResult<ApiResponse>> Delete(int id)
    {
        // 1. 核心防御：分类下仍有“有效”文章时，禁止物理删除
        bool hasArticles = await _db.Queryable<Article>()
            .AnyAsync(a => a.CategoryId == id && !a.IsDeleted);

        if (hasArticles)
        {
            _logger.LogWarning("拦截到不安全的删除尝试：分类 ID:{Id} 下仍有关联文章", id);
            return BadRequest(ApiResponse.Fail("无法删除：该分类下仍有关联文章，请先迁移文章到其他分类"));
        }

        // 2. 物理删除
        var deleteCount = await _db.Deleteable<Category>().In(id).ExecuteCommandAsync();

        if (deleteCount > 0)
        {
            _logger.LogWarning("审计日志：管理员执行了分类物理删除 | ID: {Id}", id);
            return Ok(ApiResponse.Success("分类及统计信息已移除"));
        }

        return NotFound(ApiResponse.Fail("操作失败：目标分类不存在或已被删除"));
    }
}