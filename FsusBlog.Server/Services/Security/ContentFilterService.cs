using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using System.Buffers;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// 高并发内存级内容审查服务 (Singleton 生命周期)
/// 毕业版: 2026-02-22 (优化词库重载逻辑，消除内存池抖动，实现冷热路径双重极限性能)
/// 职责: 专注于政治红线与动态广告的极致审查
/// </summary>
public partial class ContentFilterService : IContentFilterService, IDisposable
{
    private readonly ILogger<ContentFilterService> _logger;

    private readonly string _dictDirectory;
    private readonly string _sensitiveFilePath;
    private readonly string _adFilePath;

    private ModernAcAutomaton? _sensitiveSearch;
    private ModernAcAutomaton? _adSearch;
    private readonly ModernAcAutomaton _contactSearch;

    [GeneratedRegex(@"(习.{0,6}近.{0,6}平|毛.{0,6}泽.{0,6}东|六.{0,6}四.{0,6}事.{0,6}件)", RegexOptions.IgnoreCase)]
    private static partial Regex TopRedLineRegex();

    private readonly FileSystemWatcher? _fileWatcher;
    private readonly ConcurrentDictionary<string, DateTime> _lastReloadTimes = new();
    private bool _disposed;

    public ContentFilterService(IWebHostEnvironment env, ILogger<ContentFilterService> logger)
    {
        _logger = logger;
        _dictDirectory = Path.Combine(env.ContentRootPath, "Dictionaries");
        if (!Directory.Exists(_dictDirectory)) Directory.CreateDirectory(_dictDirectory);

        _sensitiveFilePath = Path.Combine(_dictDirectory, "SensitiveWords.txt");
        _adFilePath = Path.Combine(_dictDirectory, "AdWords.txt");

        EnsureFileExists(_sensitiveFilePath);
        EnsureFileExists(_adFilePath);

        _contactSearch = new ModernAcAutomaton();
        _contactSearch.Build([
            "加v", "加微", "加威", "加薇", "加嶶", "vx", "微信", "威信", "薇信", "+v", "qq", "扣扣", "企鹅", "q群", "加群"
        ]);

        ReloadKeywords();

        if (Directory.Exists(_dictDirectory))
        {
            _fileWatcher = new FileSystemWatcher(_dictDirectory, "*.txt")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = true
            };
            _fileWatcher.Changed += OnFileChanged;
        }
    }

    private void EnsureFileExists(string path)
    {
        if (!File.Exists(path)) File.WriteAllText(path, string.Empty);
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e)
    {
        if (string.IsNullOrEmpty(e.Name)) return;

        if (!_lastReloadTimes.TryAdd(e.Name, DateTime.UtcNow))
        {
            if ((DateTime.UtcNow - _lastReloadTimes[e.Name]).TotalSeconds < 5) return;
        }
        _lastReloadTimes[e.Name] = DateTime.UtcNow;

        Task.Run(() =>
        {
            if (e.Name.Equals("SensitiveWords.txt", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("检测到政治红线词库变动，准备自动热重载...");
                ReloadSensitiveWords();
            }
            else if (e.Name.Equals("AdWords.txt", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("检测到动态广告词库变动，准备自动热重载...");
                ReloadAdWords();
            }
        });
    }

    public (bool isValid, string message) ValidateContent(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return (true, string.Empty);

        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(text.Length);
            var bufferSpan = rentedBuffer.AsSpan(0, text.Length);
            text.AsSpan().CopyTo(bufferSpan);

            TextNormalizer.NormalizeInPlace(bufferSpan);

            if (_contactSearch.ContainsAny(bufferSpan))
                return (false, "输入内容包含涉嫌引流的联系方式或变体，已被拦截。");

            var currentAdSearch = _adSearch;
            if (currentAdSearch != null && currentAdSearch.ContainsAny(bufferSpan))
                return (false, "输入内容包含涉嫌引流的违规业务或恶意链接，已被拦截。");

            if (TopRedLineRegex().IsMatch(bufferSpan))
                return (false, "严重违规：检测到对抗性涉政词汇。");

            var currentSensitiveSearch = _sensitiveSearch;
            if (currentSensitiveSearch != null && currentSensitiveSearch.ContainsAny(bufferSpan))
                return (false, "输入内容包含违反相关法律法规的政治红线词汇，已被拦截。");

            return (true, string.Empty);
        }
        finally
        {
            if (rentedBuffer != null) ArrayPool<char>.Shared.Return(rentedBuffer);
        }
    }

    public void ReloadKeywords()
    {
        _logger.LogInformation("系统发起全量词库热重载指令...");
        ReloadSensitiveWords();
        ReloadAdWords();
    }

    private static string[] ReadAllLinesWithRetry(string path)
    {
        for (int i = 0; i < 5; i++)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var reader = new StreamReader(stream);
                var lines = new List<string>();
                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (!string.IsNullOrWhiteSpace(line)) lines.Add(line);
                }
                return [.. lines];
            }
            catch (IOException)
            {
                Thread.Sleep(100);
            }
        }
        throw new IOException($"无法在5次重试后读取文件: {path}");
    }

    private void ReloadSensitiveWords()
    {
        try
        {
            if (File.Exists(_sensitiveFilePath))
            {
                var lines = ReadAllLinesWithRetry(_sensitiveFilePath);
                var normalizedLines = NormalizeKeywords(lines);
                var newSearch = new ModernAcAutomaton();
                newSearch.Build(normalizedLines);
                Interlocked.Exchange(ref _sensitiveSearch, newSearch);
                _logger.LogInformation("DFA引擎：政治红线词库加载成功，共载入 {Count} 个指纹化规则", normalizedLines.Length);
            }
            else
            {
                _sensitiveSearch = null;
                _logger.LogWarning("未找到红线词库 [{FilePath}]", _sensitiveFilePath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "读取或构建红线词库失败");
        }
    }

    private void ReloadAdWords()
    {
        try
        {
            if (File.Exists(_adFilePath))
            {
                var lines = ReadAllLinesWithRetry(_adFilePath);
                var normalizedLines = NormalizeKeywords(lines);
                var newSearch = new ModernAcAutomaton();
                newSearch.Build(normalizedLines);
                Interlocked.Exchange(ref _adSearch, newSearch);
                _logger.LogInformation("DFA引擎：动态广告词库加载成功，共载入 {Count} 个指纹化规则", normalizedLines.Length);
            }
            else
            {
                _adSearch = null;
                _logger.LogWarning("未找到广告词库 [{FilePath}]", _adFilePath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "读取或构建广告词库失败");
        }
    }

    private static string[] NormalizeKeywords(string[] keywords)
    {
        if (keywords.Length == 0) return [];

        // 终极优化：计算最大长度，一次性租借缓冲区，消除循环中的池抖动
        int maxLength = 0;
        for (int i = 0; i < keywords.Length; i++)
        {
            if (keywords[i].Length > maxLength)
            {
                maxLength = keywords[i].Length;
            }
        }

        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(maxLength);
            var normalized = new string[keywords.Length];

            for (int i = 0; i < keywords.Length; i++)
            {
                var keyword = keywords[i];
                var bufferSpan = rentedBuffer.AsSpan(0, keyword.Length);
                keyword.AsSpan().CopyTo(bufferSpan);
                TextNormalizer.NormalizeInPlace(bufferSpan);
                normalized[i] = bufferSpan.ToString();
            }
            return normalized;
        }
        finally
        {
            if (rentedBuffer != null) ArrayPool<char>.Shared.Return(rentedBuffer);
        }
    }

    public void Dispose()
    {
        Dispose(true);
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (!_disposed)
        {
            if (disposing) _fileWatcher?.Dispose();
            _disposed = true;
        }
    }
}