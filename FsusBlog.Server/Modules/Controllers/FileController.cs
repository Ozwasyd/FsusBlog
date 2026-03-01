using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos; // 引用统一的 DTO
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 资源文件管理控制器
/// 修复日期: 2026-02-23 (提取内部结构体至通用 DTO，保持零分配特性)
/// </summary>
[Authorize(Roles = "admin")]
[ApiController]
[Route("api/[controller]")]
public class FileController(IFileService _fileService) : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(5 * 1024 * 1024)]
    [RequiresPow]
    public async Task<ActionResult<FileUploadOutputDto>> UploadImage(IFormFile file)
    {
        if (file == null) return BadRequest(new { message = "未选择任何文件" });

        // Service 返回的是 record struct (FileUploadResult)，栈上分配
        var result = await _fileService.UploadImageAsync(file);

        if (!result.Success)
        {
            return BadRequest(new { message = result.Message });
        }

        var request = HttpContext.Request;

        // 零分配字符串插值
        var fullUrl = $"{request.Scheme}://{request.Host}{result.Url}";

        // 核心优化：使用定义在 DTO 文件中的 FileUploadOutputDto
        // 隐式转换为 ActionResult，零堆分配
        return new FileUploadOutputDto(fullUrl, result.RelativeUrl ?? string.Empty, "上传成功");
    }

    [HttpDelete("delete")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> DeleteImage([FromQuery] string url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return BadRequest(ApiResponse.Fail("参数不能为空"));
        }

        ReadOnlySpan<char> relativeWebPathSpan;

        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                relativeWebPathSpan = uri.AbsolutePath.AsSpan();
            }
            else
            {
                return BadRequest(ApiResponse.Fail("无效的 URL 格式"));
            }
        }
        else
        {
            relativeWebPathSpan = url.AsSpan();
        }

        if (!relativeWebPathSpan.Contains("/uploads/illustration/", StringComparison.OrdinalIgnoreCase) ||
             relativeWebPathSpan.Contains("..", StringComparison.Ordinal))
        {
            return BadRequest(ApiResponse.Fail("非法路径请求"));
        }

        var trimmedSpan = relativeWebPathSpan.TrimStart('/');
        string ioRelativePath;

        if (!trimmedSpan.StartsWith("wwwroot", StringComparison.OrdinalIgnoreCase))
        {
            ioRelativePath = $"wwwroot/{trimmedSpan}";
        }
        else
        {
            ioRelativePath = trimmedSpan.ToString();
        }

        var success = await _fileService.DeleteImageAsync(ioRelativePath);

        return success
            ? ApiResponse.Success("文件已移除")
            : NotFound(ApiResponse.Fail("文件不存在或已被移除", 404));
    }
}