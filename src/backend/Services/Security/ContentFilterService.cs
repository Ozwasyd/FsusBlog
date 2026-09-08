using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Runtime.InteropServices;
using System.Threading.Channels;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// Owns the in-memory moderation dictionaries and atomically publishes rebuilt search automata.
/// </summary>
public partial class ContentFilterService : IContentFilterService, IDisposable, IAsyncDisposable
{
    private const int MaxValidationTextChars = 256 * 1024;

    private readonly ILogger<ContentFilterService> _logger;
    private readonly IModerationDictionaryService? _moderationDictionaryService;

    private readonly string _dictDirectory;
    private readonly string _sensitiveFilePath;
    private readonly string _adFilePath;

    private readonly Lock _ruleReloadLock = new();
    private string[] _sensitiveRules = [];
    private string[] _adRules = [];
    private ModernTaggedAcAutomaton<ContentRulePayload> _ruleSearch = new();

    private static readonly string[] s_contactRules =
    [
        "加v", "加微", "加威", "加薇", "加嶶", "vx", "微信", "威信", "薇信", "+v", "qq", "扣扣", "企鹅", "q群", "加群"
    ];

    private static readonly string[] s_topRedLineRules =
    [
        "习+近+平",
        "毛+泽+东",
        "六+四+事+件"
    ];

    private static readonly FrozenSet<string> s_globalDictionaryHardFilterCategories = new[]
    {
        "html_risk",
        "malicious_link"
    }.ToFrozenSet(StringComparer.Ordinal);

    private enum ContentRuleKind
    {
        Contact = 0,
        Ad = 1,
        TopRedLine = 2,
        Sensitive = 3
    }

    private readonly record struct ContentRulePayload(
        ContentRuleKind Kind,
        string ReasonCode,
        string Message);

    private readonly FileSystemWatcher? _fileWatcher;
    private readonly Channel<string> _reloadQueue;
    private readonly CancellationTokenSource _reloadCts = new();
    private readonly Task _reloadWorker;
    private readonly ConcurrentDictionary<string, DateTime> _lastReloadTimes = new();
    private bool _disposed;

    public ContentFilterService(IWebHostEnvironment env, ILogger<ContentFilterService> logger)
        : this(env, logger, null)
    {
    }

    public ContentFilterService(
        IWebHostEnvironment env,
        ILogger<ContentFilterService> logger,
        IModerationDictionaryService? moderationDictionaryService)
    {
        _logger = logger;
        _moderationDictionaryService = moderationDictionaryService;
        _dictDirectory = Path.Combine(env.ContentRootPath, "Dictionaries");
        if (!Directory.Exists(_dictDirectory))
            Directory.CreateDirectory(_dictDirectory);

        _sensitiveFilePath = Path.Combine(_dictDirectory, "SensitiveWords.txt");
        _adFilePath = Path.Combine(_dictDirectory, "AdWords.txt");
        _reloadQueue = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });
        _reloadWorker = Task.Factory
            .StartNew(
                static state =>
                {
                    var service = (ContentFilterService)state!;
                    return service.ProcessReloadQueueAsync(service._reloadCts.Token);
                },
                this,
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default)
            .Unwrap();

        EnsureFileExists(_sensitiveFilePath);
        EnsureFileExists(_adFilePath);

        TextNormalizer.Initialize(_logger);
        _ruleSearch = BuildUnifiedRuleSearch([], [], []);
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

    internal int ReloadQueuedCount
        => _reloadQueue.Reader.CanCount ? _reloadQueue.Reader.Count : 0;

    private static void EnsureFileExists(string path)
    {
        if (!File.Exists(path))
            File.WriteAllText(path, string.Empty);
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e)
    {
        if (_disposed)
        {
            return;
        }

        if (string.IsNullOrEmpty(e.Name))
            return;

        if (!_lastReloadTimes.TryAdd(e.Name, DateTime.UtcNow))
        {
            if ((DateTime.UtcNow - _lastReloadTimes[e.Name]).TotalSeconds < 5)
                return;
        }
        _lastReloadTimes[e.Name] = DateTime.UtcNow;

        if (!_reloadQueue.Writer.TryWrite(e.Name))
        {
            _logger.LogWarning("内容审查词库 reload 队列已满，已丢弃本次 watcher 事件: {FileName}", e.Name);
        }
    }

    private async Task ProcessReloadQueueAsync(CancellationToken cancellationToken)
    {
        var pending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            while (await _reloadQueue.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
            {
                pending.Clear();
                while (_reloadQueue.Reader.TryRead(out string? fileName))
                {
                    if (!string.IsNullOrWhiteSpace(fileName))
                    {
                        pending.Add(fileName);
                    }
                }

                await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken).ConfigureAwait(false);
                while (_reloadQueue.Reader.TryRead(out string? fileName))
                {
                    if (!string.IsNullOrWhiteSpace(fileName))
                    {
                        pending.Add(fileName);
                    }
                }

                foreach (string fileName in pending)
                {
                    Result result = await ReloadFromWatcherAsync(fileName, cancellationToken).ConfigureAwait(false);
                    if (result.IsFailure)
                    {
                        _logger.LogWarning("内容审查词库热重载失败: {FileName} {Message}", fileName, result.Error.Message);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "内容审查词库 reload worker 异常退出。");
        }
    }

    private async Task<Result> ReloadFromWatcherAsync(string fileName, CancellationToken cancellationToken)
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (fileName.Equals("SensitiveWords.txt", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("检测到政治红线词库变动，准备自动热重载...");
            return await ReloadSensitiveWordsAsync(cancellationToken).ConfigureAwait(false);
        }

        if (fileName.Equals("AdWords.txt", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("检测到动态广告词库变动，准备自动热重载...");
            return await ReloadAdWordsAsync(cancellationToken).ConfigureAwait(false);
        }

        return Result.Success();
    }

    public ContentValidationResult ValidateContent(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new ContentValidationResult(true, "ok", string.Empty);
        if (text.Length > MaxValidationTextChars)
        {
            return new ContentValidationResult(false, "content_too_large", "内容长度超过安全检查上限");
        }

        char[]? rentedBuffer = null;
        try
        {
            rentedBuffer = ArrayPool<char>.Shared.Rent(text.Length);
            var bufferSpan = rentedBuffer.AsSpan(0, text.Length);
            text.AsSpan().CopyTo(bufferSpan);

            TextNormalizer.NormalizeInPlace(bufferSpan);

            var currentRuleSearch = Volatile.Read(ref _ruleSearch);
            if (currentRuleSearch.TryFindBest(bufferSpan, out ContentRulePayload payload))
            {
                return new ContentValidationResult(false, payload.ReasonCode, payload.Message);
            }

            return new ContentValidationResult(true, "ok", string.Empty);
        }
        finally
        {
            if (rentedBuffer != null)
                ArrayPool<char>.Shared.Return(rentedBuffer);
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
                $"content-filter-read-lines-{Path.GetFileName(path)}");

            if (attemptResult.IsSuccess)
            {
                return attemptResult;
            }

            lastResult = attemptResult;
            if (i < 4)
            {
                WaitForStartupReloadRetry(CancellationToken.None);
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
            var attemptResult = await BoundaryExecutor.ExecuteResultAsync(
                () => ReadAllLinesCoreAsync(path, cancellationToken),
                ex => ErrorDetail.Create(
                    ErrorCode.InfraFailure,
                    $"读取词库文件失败: {Path.GetFileName(path)}",
                    path,
                    ex.Message),
                _logger,
                $"content-filter-read-lines-{Path.GetFileName(path)}");

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

    private static void WaitForStartupReloadRetry(CancellationToken cancellationToken)
        => cancellationToken.WaitHandle.WaitOne(TimeSpan.FromMilliseconds(100));

    private static string[] ReadAllLinesCore(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        var lines = new List<string>(EstimateDictionaryLineCapacity(stream.Length));
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                lines.Add(line);
            }
        }

        return lines.Count == 0 ? [] : lines.ToArray();
    }

    private static async Task<string[]> ReadAllLinesCoreAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.ReadWrite,
            BufferSize = 81920,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        });
        using var reader = new StreamReader(stream);
        var lines = new List<string>(EstimateDictionaryLineCapacity(stream.Length));
        while (await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false) is { } line)
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                lines.Add(line);
            }
        }

        return lines.Count == 0 ? [] : lines.ToArray();
    }

    private static int EstimateDictionaryLineCapacity(long byteLength)
        => (int)Math.Clamp(byteLength / 24, 16, 65_536);

    private Result ReloadSensitiveWords()
    {
        if (_disposed)
        {
            return Result.Success();
        }

        if (!File.Exists(_sensitiveFilePath))
        {
            ReplaceSensitiveRules([]);
            _logger.LogWarning("未找到红线词库 [{FilePath}]", _sensitiveFilePath);
            return Result.Success();
        }

        var linesResult = ReadAllLinesWithRetry(_sensitiveFilePath);
        if (linesResult.IsFailure)
        {
            ReplaceSensitiveRules([]);
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
            ReplaceSensitiveRules([]);
            _logger.LogWarning("未找到红线词库 [{FilePath}]", _sensitiveFilePath);
            return Result.Success();
        }

        var linesResult = await ReadAllLinesWithRetryAsync(_sensitiveFilePath, cancellationToken).ConfigureAwait(false);
        if (linesResult.IsFailure)
        {
            ReplaceSensitiveRules([]);
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
                ReplaceSensitiveRules(normalizedLines);
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
            ReplaceAdRules([]);
            _logger.LogWarning("未找到广告词库 [{FilePath}]", _adFilePath);
            return Result.Success();
        }

        var linesResult = ReadAllLinesWithRetry(_adFilePath);
        if (linesResult.IsFailure)
        {
            ReplaceAdRules([]);
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
            ReplaceAdRules([]);
            _logger.LogWarning("未找到广告词库 [{FilePath}]", _adFilePath);
            return Result.Success();
        }

        var linesResult = await ReadAllLinesWithRetryAsync(_adFilePath, cancellationToken).ConfigureAwait(false);
        if (linesResult.IsFailure)
        {
            ReplaceAdRules([]);
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
                ReplaceAdRules(normalizedLines);
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

    private void ReplaceSensitiveRules(string[] normalizedRules)
        => ReplaceRules(sensitiveRules: normalizedRules, adRules: null);

    private void ReplaceAdRules(string[] normalizedRules)
        => ReplaceRules(sensitiveRules: null, adRules: normalizedRules);

    private void ReplaceRules(string[]? sensitiveRules, string[]? adRules)
    {
        lock (_ruleReloadLock)
        {
            if (sensitiveRules is not null)
            {
                _sensitiveRules = sensitiveRules;
            }

            if (adRules is not null)
            {
                _adRules = adRules;
            }

            IReadOnlyList<ModerationDictionaryTerm> globalDictionaryTerms = _moderationDictionaryService?.GetGlobalHardFilterTerms() ?? [];
            var newSearch = BuildUnifiedRuleSearch(_sensitiveRules, _adRules, globalDictionaryTerms);
            Volatile.Write(ref _ruleSearch, newSearch);
        }
    }

    private static ModernTaggedAcAutomaton<ContentRulePayload> BuildUnifiedRuleSearch(
        string[] sensitiveRules,
        string[] adRules,
        IReadOnlyList<ModerationDictionaryTerm> globalDictionaryTerms)
    {
        var rules = new List<ModernTaggedAcRule<ContentRulePayload>>(
            s_contactRules.Length + s_topRedLineRules.Length + sensitiveRules.Length + adRules.Length + globalDictionaryTerms.Count);

        AddRules(
            rules,
            NormalizeKeywords(s_contactRules),
            new ContentRulePayload(
                ContentRuleKind.Contact,
                "contact_lead_detected",
                "输入内容包含涉嫌引流的联系方式或变体，已被拦截。"));
        AddRules(
            rules,
            adRules,
            new ContentRulePayload(
                ContentRuleKind.Ad,
                "malicious_ad_detected",
                "输入内容包含涉嫌引流的违规业务或恶意链接，已被拦截。"));
        foreach (ModerationDictionaryTerm term in globalDictionaryTerms)
        {
            if (s_globalDictionaryHardFilterCategories.Contains(term.Category))
            {
                AddGlobalDictionaryTermRules(rules, term);
            }
        }
        AddRules(
            rules,
            NormalizeKeywords(s_topRedLineRules),
            new ContentRulePayload(
                ContentRuleKind.TopRedLine,
                "political_redline_detected",
                "严重违规：检测到对抗性涉政词汇。"));
        AddRules(
            rules,
            sensitiveRules,
            new ContentRulePayload(
                ContentRuleKind.Sensitive,
                "sensitive_term_detected",
                "输入内容包含违反相关法律法规的政治红线词汇，已被拦截。"));

        var search = new ModernTaggedAcAutomaton<ContentRulePayload>();
        search.Build(CollectionsMarshal.AsSpan(rules));
        return search;
    }

    private static void AddRules(
        List<ModernTaggedAcRule<ContentRulePayload>> rules,
        string[] patterns,
        ContentRulePayload payload)
    {
        for (int i = 0; i < patterns.Length; i++)
        {
            string pattern = patterns[i];
            if (string.IsNullOrWhiteSpace(pattern))
            {
                continue;
            }

            rules.Add(new ModernTaggedAcRule<ContentRulePayload>(pattern, payload, (int)payload.Kind));
        }
    }

    private static void AddGlobalDictionaryTermRules(
        List<ModernTaggedAcRule<ContentRulePayload>> rules,
        ModerationDictionaryTerm term)
    {
        var payload = new ContentRulePayload(
            ContentRuleKind.Ad,
            term.Reason,
            "输入内容命中站点硬词库规则，已进入安全拦截。");

        AddNormalizedRule(rules, TextNormalizer.Normalize(term.Value), payload);
        foreach (string alias in term.Aliases)
        {
            AddNormalizedRule(rules, TextNormalizer.Normalize(alias), payload);
        }
    }

    private static void AddNormalizedRule(
        List<ModernTaggedAcRule<ContentRulePayload>> rules,
        string pattern,
        ContentRulePayload payload)
    {
        if (!string.IsNullOrWhiteSpace(pattern))
        {
            rules.Add(new ModernTaggedAcRule<ContentRulePayload>(pattern, payload, (int)payload.Kind));
        }
    }

    private static string[] NormalizeKeywords(string[] keywords)
    {
        if (keywords.Length == 0)
            return [];

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
            if (rentedBuffer != null)
                ArrayPool<char>.Shared.Return(rentedBuffer);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore().ConfigureAwait(false);
        GC.SuppressFinalize(this);
    }

    public void Dispose()
    {
        Dispose(disposing: true);
        GC.SuppressFinalize(this);
    }

    protected virtual void Dispose(bool disposing)
    {
        if (!_disposed)
        {
            _disposed = true;
            if (disposing)
            {
                _fileWatcher?.Dispose();
                _reloadQueue.Writer.TryComplete();
                _reloadCts.Cancel();
                _reloadCts.Dispose();
            }
        }
    }

    private async ValueTask DisposeAsyncCore()
    {
        if (!_disposed)
        {
            _disposed = true;
            _fileWatcher?.Dispose();
            _reloadQueue.Writer.TryComplete();
            _reloadCts.Cancel();
            try
            {
                await _reloadWorker.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            }
            catch (AggregateException ex)
            {
                _logger.LogDebug(ex, "内容审查词库 reload worker 停止时已忽略异常。");
            }
            finally
            {
                _reloadCts.Dispose();
            }
        }
    }
}
