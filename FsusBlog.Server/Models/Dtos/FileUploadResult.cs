namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. Service -> Controller (内部传输)
// ==========================================

/// <summary>
/// 文件服务操作结果
/// 优化：改为 record struct，在 Service 层返回时零分配
/// </summary>
public record struct FileUploadResult
{
    public bool Success { get; set; }

    // 默认值初始化，避免 null
    public string Message { get; set; } = string.Empty;

    /// <summary>
    /// 相对路径 (如 /uploads/illustration/xxx.jpg)
    /// </summary>
    public string? RelativeUrl { get; set; }

    /// <summary>
    /// 原始 URL (部分场景可能未拼接域名)
    /// </summary>
    public string? Url { get; set; }

    /// <summary>
    /// 服务器物理路径 (仅内部使用，绝对不要输出给前端)
    /// </summary>
    public string? PhysicalPath { get; set; }

    public FileUploadResult() { }
}

// ==========================================
// 2. Controller -> Client (外部契约)
// ==========================================

/// <summary>
/// 文件上传响应 DTO
/// 优化：readonly record struct，专门用于序列化输出
/// </summary>
public readonly record struct FileUploadOutputDto(string Url, string RelativeUrl, string Message);