using FsusBlog.Server.Interfaces;
using global::FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services;

/// <summary>
/// 博客插图辅助工具：负责物理文件的 I/O 操作
/// 修复日期: 2026-02-23 (CISO级别安全修复：封堵 Path Traversal 任意文件删除漏洞，修正 WebRootPath 空引用炸弹，恢复 80KB 异步黄金缓冲区)
/// </summary>
public sealed partial class FileService : IFileService
{
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<FileService> _logger;

    private static readonly string[] _allowedExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    private readonly string _subFolder;

    private readonly string _folderPath;
    private readonly string _cleanSubFolderWeb;

    // 核心防御：静态沙箱边界
    private readonly string _sandboxAbsolutePath;

    public FileService(IWebHostEnvironment env, ILogger<FileService> logger)
    {
        _env = env;
        _logger = logger;
        _subFolder = Path.Combine("uploads", "illustration");

        // 边缘健壮性修复：兜底 WebRootPath，防止首次部署时 wwwroot 不存在导致的 NullReferenceException
        string webRoot = _env.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");

        _folderPath = Path.Combine(webRoot, _subFolder);

        // 初始化沙箱的绝对路径，并强制以分隔符结尾
        // 防止类似于 /app/wwwroot/uploads_backup 被 /app/wwwroot/uploads 误判放行
        string absPath = Path.GetFullPath(_folderPath);
        _sandboxAbsolutePath = absPath.EndsWith(Path.DirectorySeparatorChar)
            ? absPath
            : absPath + Path.DirectorySeparatorChar;

        _cleanSubFolderWeb = "/" + _subFolder.Trim('/', '\\').Replace('\\', '/');
    }

    public async Task<FileUploadResult> UploadImageAsync(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return new FileUploadResult { Success = false, Message = "文件为空" };

        var fileNameSpan = file.FileName.AsSpan();
        var extSpan = Path.GetExtension(fileNameSpan);

        bool isValidExt = false;
        foreach (var allowedExt in _allowedExtensions)
        {
            if (extSpan.Equals(allowedExt.AsSpan(), StringComparison.OrdinalIgnoreCase))
            {
                isValidExt = true;
                break;
            }
        }

        if (!isValidExt)
            return new FileUploadResult { Success = false, Message = "格式不支持" };

        if (!Directory.Exists(_folderPath))
        {
            Directory.CreateDirectory(_folderPath);
        }

        string fileName = $"{Guid.NewGuid():N}{extSpan}";
        string filePath = Path.Combine(_folderPath, fileName);
        string relativeUrl = $"{_cleanSubFolderWeb}/{fileName}";

        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.Create,
                Access = FileAccess.Write,
                Share = FileShare.None,
                // 性能陷阱修复：80KB (81920) 黄金平衡点
                // 完美贴合 CopyToAsync 默认切块，低于 LOH 阈值，最大化压榨磁盘异步吞吐量
                BufferSize = 81920,
                Options = FileOptions.Asynchronous
            };

            using (var stream = new FileStream(filePath, options))
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
            LogWriteError(ex, filePath);
            return new FileUploadResult { Success = false, Message = "写入失败" };
        }
    }

    public Task<bool> DeleteImageAsync(string imageUrl)
    {
        if (string.IsNullOrEmpty(imageUrl)) return Task.FromResult(false);

        var baseDir = Directory.GetCurrentDirectory();

        int startIndex = 0;
        while (startIndex < imageUrl.Length && imageUrl[startIndex] == '/')
        {
            startIndex++;
        }
        int length = imageUrl.Length - startIndex;

        string rawFilePath = string.Create(baseDir.Length + 1 + length, (baseDir, imageUrl, startIndex, length), (dst, state) =>
        {
            state.baseDir.AsSpan().CopyTo(dst);
            dst[state.baseDir.Length] = Path.DirectorySeparatorChar;

            var rel = state.imageUrl.AsSpan(state.startIndex, state.length);
            for (int i = 0; i < rel.Length; i++)
            {
                char c = rel[i];
                dst[state.baseDir.Length + 1 + i] = (c == '/' || c == '\\')
                    ? Path.DirectorySeparatorChar
                    : c;
            }
        });

        // 获取包含 ../ 运算后的最终绝对路径
        string filePath = Path.GetFullPath(rawFilePath);

        // 🌟 致命缺陷修复：沙箱逃逸防御 (Path Traversal 防护)
        // 如果解析后的路径跳出了我们限定的插图目录，直接拦截！
        if (!filePath.StartsWith(_sandboxAbsolutePath, StringComparison.OrdinalIgnoreCase))
        {
            LogSecurityWarning(filePath);
            return Task.FromResult(false);
        }

        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
                LogDeleteSuccess(filePath);
                return Task.FromResult(true);
            }

            LogFileNotFound(filePath);
            return Task.FromResult(false);
        }
        catch (Exception ex)
        {
            LogDeleteError(ex, filePath);
            return Task.FromResult(false);
        }
    }

    // ==========================================
    // 高性能日志源生成器 (Zero-Allocation Logging)
    // ==========================================

    [LoggerMessage(EventId = 1, Level = LogLevel.Error, Message = "插图磁盘写入异常。目标路径: {FilePath}")]
    private partial void LogWriteError(Exception ex, string filePath);

    [LoggerMessage(EventId = 2, Level = LogLevel.Information, Message = "[Storage] 物理文件删除成功 | 路径: {FullPath}")]
    private partial void LogDeleteSuccess(string fullPath);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "[Storage] 文件不存在，跳过删除 | 尝试路径: {FullPath}")]
    private partial void LogFileNotFound(string fullPath);

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "[Storage] 物理文件删除异常 | 目标路径: {FullPath}")]
    private partial void LogDeleteError(Exception ex, string fullPath);

    [LoggerMessage(EventId = 5, Level = LogLevel.Critical, Message = "🚨 [安全拦截] 探测到恶意的目录逃逸(Path Traversal)文件删除尝试 | 最终解析路径: {FullPath}")]
    private partial void LogSecurityWarning(string fullPath);
}
