using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 评论管理控制器 (Write Side)
/// 修复日期: 2026-02-23 (引入源生成器日志，适配统一 DTO)
/// </summary>
[Route("api/[controller]")]
[ApiController]
public partial class CommentController( // partial for logger
    ICommentService _commentService,
    ILogger<CommentController> _logger) : ControllerBase
{
    [Authorize]
    [HttpPost]
    [EnableRateLimiting("fixed_ip")]
    [SensitiveContentFilter]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> Create([FromBody] CommentDto dto)
    {
        int userId = User.GetUserId();
        if (userId == 0)
        {
            LogUnauthorizedComment(HttpContext.GetClientIp());
            return Unauthorized(ApiResponse.Fail("未授权的访问，请重新登录", 401));
        }

        var success = await _commentService.CreateCommentAsync(userId, dto);

        return success
            ? ApiResponse.Success("评论成功")
            : BadRequest(ApiResponse.Fail("发布失败：可能文章已关闭评论或数据异常", 400));
    }

    /// <summary>
    /// 删除评论
    /// </summary>
    [HttpDelete("{id}")]
    [RequiresPow]
    [Authorize]
    public async Task<ActionResult<ApiResponse>> Delete(long id, [FromQuery] string? reason = null)
    {
        int userId = User.GetUserId();
        bool isAdmin = User.IsInRole("admin");

        // 逻辑自洽：管理员删除他人评论时，reason 会通过 Query 传入并下发通知
        var success = await _commentService.DeleteCommentAsync(id, userId, isAdmin, reason ?? "不符合社区规范");

        if (success)
        {
            return ApiResponse.Success("评论已删除");
        }

        LogDeleteFailed(id, userId);
        return StatusCode(403, ApiResponse.Fail("未找到该评论或无权删除", 403));
    }

    // ==========================================
    // 高性能日志源生成器
    // ==========================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "拦截到未授权的评论尝试 | IP: {IpAddress}")]
    private partial void LogUnauthorizedComment(string ipAddress);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Warning,
        Message = "删除评论失败或权限拦截 | ID: {CommentId} | 操作人: {UserId}")]
    private partial void LogDeleteFailed(long commentId, int userId);
}