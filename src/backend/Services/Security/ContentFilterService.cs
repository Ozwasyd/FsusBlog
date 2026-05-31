using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
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

        TextNormalizer.Initialize(_logger);
        var initResult = ReloadKeywordsCore();
        if (initResult.IsFailure)
        {
            _logger.LogWarning("内容审查词库初始化失败，已降级为空词库: {Message}", initResult.Error.Message);
        }

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

    private static void EnsureFileExists(string path)
    {
        if (!File.Exists(path)) File.WriteAllText(path, string.Empty);
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e)
    {
        if (_disposed)
        {
            return;
        }

        if (string.IsNullOrEmpty(e.Name)) return;

        if (!_lastReloadTimes.TryAdd(e.Name, DateTime.UtcNow))
        {
            if ((DateTime.UtcNow - _lastReloadTimes[e.Name]).TotalSeconds < 5) return;
        }
        _lastReloadTimes[e.Name] = DateTime.UtcNow;

        string fileName = e.Name;
        _ = Task.Run(async () => await ReloadFromWatcherAsync(fileName).ConfigureAwait(false));
    }

    private async Task<Result> ReloadFromWatcherAsync(string fileName)
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (fileName.Equals("SensitiveWords.txt", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("检测到政治红线词库变动，准备自动热重载...");
            return await ReloadSensitiveWordsAsync().ConfigureAwait(false);
        }

        if (fileName.Equals("AdWords.txt", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("检测到动态广告词库变动，准备自动热重载...");
            return await ReloadAdWordsAsync().ConfigureAwait(false);
        }

        return Result.Success();
    }

    public ContentValidationResult ValidateContent(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new ContentValidationResult(true, "ok", string.Empty);

        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(text.Length);
            var bufferSpan = rentedBuffer.AsSpan(0, text.Length);
            text.AsSpan().CopyTo(bufferSpan);

            TextNormalizer.NormalizeInPlace(bufferSpan);

            if (_contactSearch.ContainsAny(bufferSpan))
                return new ContentValidationResult(false, "contact_lead_detected", "输入内容包含涉嫌引流的联系方式或变体，已被拦截。");

            var currentAdSearch = Volatile.Read(ref _adSearch);
            if (currentAdSearch != null && currentAdSearch.ContainsAny(bufferSpan))
                return new ContentValidationResult(false, "malicious_ad_detected", "输入内容包含涉嫌引流的违规业务或恶意链接，已被拦截。");

            if (TopRedLineRegex().IsMatch(bufferSpan))
                return new ContentValidationResult(false, "political_redline_detected", "严重违规：检测到对抗性涉政词汇。");

            var currentSensitiveSearch = Volatile.Read(ref _sensitiveSearch);
            if (currentSensitiveSearch != null && currentSensitiveSearch.ContainsAny(bufferSpan))
                return new ContentValidationResult(false, "sensitive_term_detected", "输入内容包含违反相关法律法规的政治红线词汇，已被拦截。");

            return new ContentValidationResult(true, "ok", string.Empty);
        }
        finally
        {
            if (rentedBuffer != null) ArrayPool<char>.Shared.Return(rentedBuffer);
        }
    }

    public void ReloadKeywords()
    {
        if (_disposed)
        {
            return;
        }

        var result = ReloadKeywordsCore();
        if (result.IsFailure)
        {
            _logger.LogWarning("词库热重载存在失败项: {Message}", result.Error.Message);
        }
    }

    private Result ReloadKeywordsCore()
    {
        _logger.LogInformation("系统发起全量词库热重载指令...");
        var sensitiveResult = ReloadSensitiveWords();
        if (sensitiveResult.IsFailure)
        {
            return sensitiveResult;
        }

        return ReloadAdWords();
    }

    private Result<string[]> ReadAllLinesWithRetry(string path)
    {
        Result<string[]> lastResult = Result<string[]>.Failure(
            ErrorCode.InfraFailure,
            $"读取词库失败: {Path.GetFileName(path)}");

        for (int i = 0; i < 5; i++)
        {
            var attemptResult = BoundaryExecutor.ExecuteResult(
                () => ReadAllLinesCore(path),
                ex => ErrorDetail.Create(
                    ErrorCode.InfraFailure,
                    $"读取词库文件失败: {Path.GetFileName(path)}",
                    path,
                    ex.Message),
                _logger,
                $"content-filter-read-lines-{Path.GetFileName(path)}",
                i < 4 ? LogLevel.Debug : LogLevel.Warning);

            if (attemptResult.IsSuccess)
            {
                return attemptResult;
            }

            lastResult = attemptResult;
            if (i < 4)
            {
                WaitForReloadRetryAsync(CancellationToken.None).GetAwaiter().GetResult();
            }
        }

        _logger.LogWarning("词库文件读取失败，已降级为空词库 | Path: {Path}", path);
        return lastResult;
    }

    private async Task<Result<string[]>> ReadAllLinesWithRetryAsync(string path, CancellationToken cancellationToken = default)
    {
        Result<string[]> lastResult = Result<string[]>.Failure(
            ErrorCode.InfraFailure,
            $"读取词库失败: {Path.GetFileName(path)}");

        for (int i = 0; i < 5; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var attemptResult = BoundaryExecutor.ExecuteResult(
                () => ReadAllLinesCore(path),
                ex => ErrorDetail.Create(
                    ErrorCode.InfraFailure,
                    $"读取词库文件失败: {Path.GetFileName(path)}",
                    path,
                    ex.Message),
                _logger,
                $"content-filter-read-lines-{Path.GetFileName(path)}",
                i < 4 ? LogLevel.Debug : LogLevel.Warning);

            if (attemptResult.IsSuccess)
            {
                return attemptResult;
            }

            lastResult = attemptResult;
            if (i < 4)
            {
                await WaitForReloadRetryAsync(cancellationToken).ConfigureAwait(false);
            }
        }

        _logger.LogWarning("词库文件读取失败，已降级为空词库 | Path: {Path}", path);
        return lastResult;
    }

    private static Task WaitForReloadRetryAsync(CancellationToken cancellationToken)
        => Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken);

    private static string[] ReadAllLinesCore(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        var lines = new List<string>();
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                lines.Add(line);
            }
        }

        return [.. lines];
    }

    private Result ReloadSensitiveWords()
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (!File.Exists(_sensitiveFilePath))
        {
            _sensitiveSearch = null;
            _logger.LogWarning("未找到红线词库 [{FilePath}]", _sensitiveFilePath);
            return Result.Success();
        }

        var linesResult = ReadAllLinesWithRetry(_sensitiveFilePath);
        if (linesResult.IsFailure)
        {
            _sensitiveSearch = null;
            return Result.Failure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取红线词库失败",
                _sensitiveFilePath,
                linesResult.Error.TraceId));
        }

        return BuildSensitiveSearch(linesResult.Value!);
    }

    private async Task<Result> ReloadSensitiveWordsAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (!File.Exists(_sensitiveFilePath))
        {
            _sensitiveSearch = null;
            _logger.LogWarning("未找到红线词库 [{FilePath}]", _sensitiveFilePath);
            return Result.Success();
        }

        var linesResult = await ReadAllLinesWithRetryAsync(_sensitiveFilePath, cancellationToken).ConfigureAwait(false);
        if (linesResult.IsFailure)
        {
            _sensitiveSearch = null;
            return Result.Failure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取红线词库失败",
                _sensitiveFilePath,
                linesResult.Error.TraceId));
        }

        return BuildSensitiveSearch(linesResult.Value!);
    }

    private Result BuildSensitiveSearch(string[] lines)
    {
        Result buildResult = BoundaryExecutor.Execute(
            () =>
            {
                var normalizedLines = NormalizeKeywords(lines);
                var newSearch = new ModernAcAutomaton();
                newSearch.Build(normalizedLines);
                Interlocked.Exchange(ref _sensitiveSearch, newSearch);
                _logger.LogInformation("DFA引擎：政治红线词库加载成功，共载入 {Count} 个指纹化规则", normalizedLines.Length);
            },
            ex => ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取或构建红线词库失败",
                _sensitiveFilePath,
                ex.Message),
            _logger,
            "content-filter-reload-sensitive",
            LogLevel.Warning);
        return buildResult;
    }

    private Result ReloadAdWords()
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (!File.Exists(_adFilePath))
        {
            _adSearch = null;
            _logger.LogWarning("未找到广告词库 [{FilePath}]", _adFilePath);
            return Result.Success();
        }

        var linesResult = ReadAllLinesWithRetry(_adFilePath);
        if (linesResult.IsFailure)
        {
            _adSearch = null;
            return Result.Failure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取广告词库失败",
                _adFilePath,
                linesResult.Error.TraceId));
        }

        return BuildAdSearch(linesResult.Value!);
    }

    private async Task<Result> ReloadAdWordsAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (!File.Exists(_adFilePath))
        {
            _adSearch = null;
            _logger.LogWarning("未找到广告词库 [{FilePath}]", _adFilePath);
            return Result.Success();
        }

        var linesResult = await ReadAllLinesWithRetryAsync(_adFilePath, cancellationToken).ConfigureAwait(false);
        if (linesResult.IsFailure)
        {
            _adSearch = null;
            return Result.Failure(ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取广告词库失败",
                _adFilePath,
                linesResult.Error.TraceId));
        }

        return BuildAdSearch(linesResult.Value!);
    }

    private Result BuildAdSearch(string[] lines)
    {
        Result buildResult = BoundaryExecutor.Execute(
            () =>
            {
                var normalizedLines = NormalizeKeywords(lines);
                var newSearch = new ModernAcAutomaton();
                newSearch.Build(normalizedLines);
                Interlocked.Exchange(ref _adSearch, newSearch);
                _logger.LogInformation("DFA引擎：动态广告词库加载成功，共载入 {Count} 个指纹化规则", normalizedLines.Length);
            },
            ex => ErrorDetail.Create(
                ErrorCode.InfraFailure,
                "读取或构建广告词库失败",
                _adFilePath,
                ex.Message),
            _logger,
            "content-filter-reload-ad",
            LogLevel.Warning);
        return buildResult;
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
            _disposed = true;
            if (disposing) _fileWatcher?.Dispose();
        }
    }
}
