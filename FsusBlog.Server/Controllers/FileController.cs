using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 资源文件管理
/// </summary>
[Authorize(Roles = "admin")]
[ApiController]
[Route("api/[controller]")]
public class FileController(IFileService _fileService) : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(5 * 1024 * 1024)] // 🌟 安全保障：限制 5MB，防止大文件 OOM 攻击
    public async Task<IActionResult> UploadImage(IFormFile file)
    {
        // 1. 快速基础检查
        if (file == null) return BadRequest(new { message = "未选择任何文件" });

        // 2. 调用业务层执行 IO 操作
        var result = await _fileService.UploadImageAsync(file);

        if (!result.Success)
        {
            return BadRequest(new { message = result.Message });
        }

        // 3. 构建更具兼容性的绝对地址
        // 考虑生产环境 Nginx 转发，优先保障 URL 的可用性
        var request = HttpContext.Request;

        // 使用 Request 的属性拼接 URL，确保在不同域名下都能自动适配
        // 提示：若生产环境使用反向代理，请确保已启用 app.UseForwardedHeaders()
        var baseUrl = $"{request.Scheme}://{request.Host}";
        var fullUrl = $"{baseUrl}{result.Url}";

        // 4. 返回标准结果契约
        return Ok(new
        {
            url = fullUrl,                // 用于编辑器预览的绝对路径
            relativeUrl = result.RelativeUrl, // 用于存储到数据库的相对路径（解耦域名）
            message = "上传成功"
        });
    }

    [HttpDelete("delete")]
    public async Task<IActionResult> DeleteImage([FromQuery] string url)
    {
        // 1. 基础合法性校验
        if (string.IsNullOrWhiteSpace(url))
        {
            return BadRequest(new { message = "参数不能为空" });
        }

        // 2. 逻辑自洽：URL 提纯与路径标准化
        // 无论前端传入的是预览用的全路径还是相对路径，统一提取 Web 相对路径
        string relativeWebPath;
        try
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            {
                relativeWebPath = uri.AbsolutePath;
            }
            else
            {
                relativeWebPath = url;
            }
        }
        catch
        {
            return BadRequest(new { message = "无效的 URL 格式" });
        }

        // 3. 安全性保障：路径边界锁定
        // 严格限制只能操作插图目录，并防止目录穿越攻击（..）
        if (!relativeWebPath.Contains("/uploads/illustration/") || relativeWebPath.Contains(".."))
        {
            return BadRequest(new { message = "非法路径请求" });
        }

        // 4. 路径转换：Web Path -> IO Relative Path
        // 将 /uploads/... 转换为 wwwroot/uploads/... 以匹配 Service 层预期
        var ioRelativePath = relativeWebPath.TrimStart('/');
        if (!ioRelativePath.StartsWith("wwwroot", StringComparison.OrdinalIgnoreCase))
        {
            ioRelativePath = Path.Combine("wwwroot", ioRelativePath);
        }

        // 5. 执行物理删除
        var success = await _fileService.DeleteImageAsync(ioRelativePath);

        return success
            ? Ok(new { message = "文件已移除" })
            : NotFound(new { message = "文件不存在或已被移除" });
    }
}