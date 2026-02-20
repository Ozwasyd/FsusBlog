using FsusBlog.Server.Interfaces;
using global::FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services;

public class FileService(IWebHostEnvironment _env, ILogger<FileService> _logger) : IFileService
{
    private readonly string[] _allowedExtensions = { ".jpg", ".jpeg", ".png", ".gif", ".webp" };
    private readonly string _subFolder = Path.Combine("uploads", "illustration");

    public async Task<FileUploadResult> UploadImageAsync(IFormFile file)
    {
        // 性能最大化：快速失败原则
        if (file == null || file.Length == 0)
            return new FileUploadResult { Success = false, Message = "文件为空" };

        // 校验扩展名
        var extension = Path.GetExtension(file.FileName).ToLower();
        if (!_allowedExtensions.Contains(extension))
            return new FileUploadResult { Success = false, Message = "格式不支持" };

        // 逻辑自洽：确保目录生成的稳定性
        var folderPath = Path.Combine(_env.WebRootPath, _subFolder);
        if (!Directory.Exists(folderPath))
        {
            Directory.CreateDirectory(folderPath);
        }

        // 生成唯一文件名 (N: 32位数字)
        var fileName = $"{Guid.NewGuid():N}{extension}";
        var filePath = Path.Combine(folderPath, fileName);

        // 路径安全性：标准化 Web 路径，防止双斜杠
        var cleanSubFolder = _subFolder.Trim('/', '\\').Replace("\\", "/");
        var relativeUrl = $"/{cleanSubFolder}/{fileName}";

        try
        {
            // 性能优化：显式使用 FileStreamOptions 或异步模式
            // 使用更高性能的缓冲区配置
            using (var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
            {
                await file.CopyToAsync(stream);
            }

            return new FileUploadResult
            {
                Success = true,
                Url = relativeUrl,
                RelativeUrl = relativeUrl,
                PhysicalPath = filePath
            };
        }
        catch (Exception ex)
        {
            // 生产环境安全：记录具体路径以便于排查权限或磁盘满额问题
            _logger.LogError(ex, "插图磁盘写入异常。目标路径: {FilePath}", filePath);
            return new FileUploadResult { Success = false, Message = "写入失败" };
        }
    }

    public async Task<bool> DeleteImageAsync(string imageUrl)
    {
        if (string.IsNullOrEmpty(imageUrl)) return false;

        // 1. 路径提纯：去掉 Web 路径可能带有的前导斜杠
        var sanitizedRelativePath = imageUrl.TrimStart('/').Replace('\\', '/');

        // 2. 核心修正：锚定容器根目录
        // 在 Docker Linux 环境下，Directory.GetCurrentDirectory() 通常指向 Dockerfile 中的 WORKDIR (即 /app)
        // 这避开了 bin/Debug/net10.0 带来的路径偏移
        var baseDir = Directory.GetCurrentDirectory();
        var filePath = Path.GetFullPath(Path.Combine(baseDir, sanitizedRelativePath));

        return await Task.Run(() =>
        {
            try
            {
                if (File.Exists(filePath))
                {
                    File.Delete(filePath);
                    _logger?.LogInformation("[Storage] 物理文件删除成功 | 路径: {FullPath}", filePath);
                    return true;
                }
                else
                {
                    _logger?.LogWarning("[Storage] 文件不存在，跳过删除 | 尝试路径: {FullPath}", filePath);
                    return false;
                }
            }
            catch (Exception ex)
            {
                _logger?.LogError(ex, "[Storage] 物理文件删除异常 | 目标路径: {FullPath}", filePath);
                return false;
            }
        });
    }
}
