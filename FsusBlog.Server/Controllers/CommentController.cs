using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.Server.Controllers;

[Route("api/[controller]")]
[ApiController]
public class CommentController(
    ICommentService _commentService,
    IPowService _powService,
    AdaptivePowGovernor _governor,
    ILogger<CommentController> _logger) : ControllerBase // 注入日志组件
{
    /// <summary>
    /// 发表评论
    /// </summary>
    [Authorize]
    [HttpPost]
    [EnableRateLimiting("fixed_ip")]
    public async Task<ActionResult<ApiResponse>> Create([FromBody] CommentDto dto)
    {
        // 1. 身份校验
        int userId = User.GetUserId();
        if (userId == 0)
        {
            _logger.LogWarning("拦截到未授权的评论尝试 | IP: {IP}", HttpContext.GetClientIp());
            return Unauthorized(ApiResponse.Fail("未授权的访问，请重新登录", 401));
        }

        // 2. PoW 校验 (核心防御)
        // 评论是高价值目标，必须确保证明了算力
        string clientIp = HttpContext.GetClientIp();

        // 2.1 熔断检查
        int currentRequired = await _governor.GetDifficultyForIpAsync(clientIp);
        if (dto.Difficulty < currentRequired)
        {
            return StatusCode(403, ApiResponse.Fail("当前评论区拥堵，请重试以提升算力", 403));
        }

        // 2.2 签名与重放校验
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验失败：凭证无效或过期", 401));
        }

        // 3. 业务逻辑
        var success = await _commentService.CreateCommentAsync(userId, dto);

        return success
            ? Ok(ApiResponse.Success("评论成功"))
            : BadRequest(ApiResponse.Fail("发布失败：可能文章已关闭评论或数据异常", 400));
    }

    /// <summary>
    /// 获取文章下的评论（游标分页）
    /// </summary>
    [HttpGet("{articleId}")]
    public async Task<ActionResult<ApiResponse<object>>> GetByArticle(int articleId, [FromQuery] long? cursor, [FromQuery] int limit = 10)
    {
        var result = await _commentService.GetCommentsByCursorAsync(articleId, cursor, limit);

        // 保持原有的数据结构，进行匿名映射以保护敏感用户信息
        var response = new
        {
            data = result.Data.Select(c => new
            {
                // 确保 API 返回的数据结构与 SignalR 推送的数据结构（小写 id）一致
                // 同时解决 JavaScript 处理 long 类型精度丢失问题
                id = c.Id.ToString(),
                c.Content,
                c.CreateTime,
                UserName = c.User?.Username ?? "匿名用户"
            }),
            result.NextCursor,
            result.HasMore
        };

        return Ok(ApiResponse<object>.Success(response));
    }

    /// <summary>
    /// 获取当前登录用户的历史评论
    /// </summary>
    [HttpGet("me")]
    [Authorize]
    public async Task<ActionResult<ApiResponse<CursorResult<UserCommentDto>>>> GetMyComments([FromQuery] long? cursor, [FromQuery] int limit = 10)
    {
        int userId = User.GetUserId();
        if (userId == 0) return Unauthorized(ApiResponse.Fail("未找到用户信息", 401));

        var result = await _commentService.GetUserCommentsAsync(userId, cursor, limit);
        return Ok(ApiResponse<CursorResult<UserCommentDto>>.Success(result));
    }

    /// <summary>
    /// 删除评论
    /// </summary>
    [HttpDelete("{id}")]
    [Authorize]
    public async Task<ActionResult<ApiResponse>> Delete(long id, [FromQuery] string? reason = null)
    {
        int userId = User.GetUserId();
        bool isAdmin = User.IsInRole("admin");

        // 🌟 核心适配：将 reason 传递给 Service 层
        // 如果前端未传 reason，Service 会使用其默认参数（如 "违反社区管理条例"）
        var success = await _commentService.DeleteCommentAsync(id, userId, isAdmin, reason ?? "不符合社区规范");

        if (success)
        {
            return Ok(ApiResponse.Success("评论已删除"));
        }

        _logger.LogWarning("删除评论失败或权限拦截 | ID: {CommentId} | 操作人: {UserId}", id, userId);
        return StatusCode(403, ApiResponse.Fail("未找到该评论或无权删除", 403));
    }
}