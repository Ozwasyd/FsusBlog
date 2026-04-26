using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
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
    [HttpPost("upload/init")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<UploadInitDto>>> InitUploadSession(
        [FromBody] UploadInitRequestDto dto,
        CancellationToken cancellationToken)
    {
        var result = await _fileService.InitUploadSessionAsync(dto, cancellationToken);
        return ToActionResult(result);
    }

    [HttpGet("upload/{uploadId}/status")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<UploadStatusDto>>> GetUploadStatus(
        string uploadId,
        CancellationToken cancellationToken)
    {
        var result = await _fileService.GetUploadStatusAsync(uploadId, cancellationToken);
        return ToActionResult(result);
    }

    [HttpPut("upload/{uploadId}/part")]
    [RequestSizeLimit(3 * 1024 * 1024)]
    [RequiresPow]
    [Consumes("multipart/form-data")]
    public async Task<ActionResult<ApiResponse<UploadPartAckDto>>> UploadPart(
        string uploadId,
        [FromForm] IFormFile file,
        [FromForm] int partNumber,
        [FromForm] long offset,
        [FromForm] string? payloadHash,
        CancellationToken cancellationToken)
    {
        var result = await _fileService.UploadPartAsync(uploadId, partNumber, offset, file, payloadHash, cancellationToken);
        return ToActionResult(result);
    }

    [HttpPost("upload/{uploadId}/complete")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse<UploadCompleteDto>>> CompleteUpload(
        string uploadId,
        [FromBody] UploadCompleteRequestDto dto,
        CancellationToken cancellationToken)
    {
        var result = await _fileService.CompleteUploadAsync(uploadId, dto.Sha256, cancellationToken);
        return ToActionResult(result);
    }

    [HttpDelete("upload/{uploadId}")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> AbortUpload(string uploadId, CancellationToken cancellationToken)
    {
        var result = await _fileService.AbortUploadAsync(uploadId, cancellationToken);
        if (result.IsSuccess)
        {
            return ApiResponse.Success("上传会话已取消");
        }

        return result.Error.Code == ErrorCode.NotFound
            ? ControllerResults.NotFound(result.Error.Message, HttpContext.TraceIdentifier)
            : ControllerResults.BadRequest(result.Error.Message, HttpContext.TraceIdentifier);
    }

    [HttpPost("upload")]
    [RequestSizeLimit(5 * 1024 * 1024)]
    [RequiresPow]
    public async Task<ActionResult<FileUploadOutputDto>> UploadImage(IFormFile file)
    {
        if (file == null)
        {
            return new BadRequestObjectResult(ApiResponse.Fail("未选择任何文件", 400, HttpContext.TraceIdentifier));
        }

        // Service 返回的是 record struct (FileUploadResult)，栈上分配
        var result = await _fileService.UploadImageAsync(file);

        if (!result.Success)
        {
            return new BadRequestObjectResult(ApiResponse.Fail(result.Message, 400, HttpContext.TraceIdentifier));
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
            return ControllerResults.BadRequest("参数不能为空", HttpContext.TraceIdentifier);
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
                return ControllerResults.BadRequest("无效的 URL 格式", HttpContext.TraceIdentifier);
            }
        }
        else
        {
            relativeWebPathSpan = url.AsSpan();
        }

        if (!relativeWebPathSpan.Contains("/uploads/illustration/", StringComparison.OrdinalIgnoreCase) ||
             relativeWebPathSpan.Contains("..", StringComparison.Ordinal))
        {
            return ControllerResults.BadRequest("非法路径请求", HttpContext.TraceIdentifier);
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
            : ControllerResults.NotFound("文件不存在或已被移除", HttpContext.TraceIdentifier);
    }

    private ActionResult<ApiResponse<T>> ToActionResult<T>(Result<T> result)
    {
        if (result.IsSuccess && result.Value is not null)
        {
            return ApiResponse<T>.Success(result.Value);
        }

        var message = string.IsNullOrWhiteSpace(result.Error.Message) ? "请求失败" : result.Error.Message;
        return result.Error.Code switch
        {
            ErrorCode.NotFound => ControllerResults.NotFound<T>(message, HttpContext.TraceIdentifier),
            ErrorCode.Conflict => ControllerResults.Conflict<T>(message, HttpContext.TraceIdentifier),
            ErrorCode.Forbidden => ControllerResults.Forbidden<T>(message, HttpContext.TraceIdentifier),
            ErrorCode.Unauthorized => ControllerResults.Unauthorized<T>(message, HttpContext.TraceIdentifier),
            ErrorCode.Validation => ControllerResults.BadRequest<T>(message, HttpContext.TraceIdentifier),
            _ => ControllerResults.Status<T>(500, message, HttpContext.TraceIdentifier)
        };
    }
}
