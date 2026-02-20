namespace FsusBlog.Server.Models.Dtos;

public class FileUploadResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = string.Empty;
    public string? Url { get; set; }           // 给前端显示的完整 URL
    public string? RelativeUrl { get; set; }   // 存入数据库的相对路径 (如 /uploads/...)
    public string? PhysicalPath { get; set; }  // 服务器物理路径 (用于后续逻辑)
}
