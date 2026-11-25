namespace FsusBlog.V2.Server.Content;

internal sealed record PublicArticleBytes(byte[] Wire, byte[] Html, byte[]? EnglishHtml = null);

internal sealed class PublicArticleCache(IReadOnlyDictionary<int, Article> articles, WebPages pages,
    long generation = 0, ILogger? log = null, RuntimeEvidence? evidence = null, PublishedMediaProjection? media = null,
    long siteConfigRevision = 0, TimeSpan? waitBudget = null, TimeSpan? renderBudget = null,
    Func<Task>? beforeEncode = null)
{
    private const int ParallelRenders = 4;
    private const int PendingRenders = 64;
    private const long ByteLimit = 96 * 1024 * 1024;
    private static readonly TimeSpan DefaultWaitBudget = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan DefaultRenderBudget = TimeSpan.FromSeconds(2);
    private static readonly Action<ILogger, string, int, long, int, int, long, Exception?> LogCold =
        LoggerMessage.Define<string, int, long, int, int, long>(LogLevel.Debug, new EventId(2201, "PublicArticleColdCache"),
            "Public article cache {Event} article={ArticleId} generation={Generation} pending={Pending} active={Active} elapsed_us={ElapsedUs}");
    private readonly PublishedMediaProjection? _media = media;
    private readonly long _siteConfigRevision = siteConfigRevision;
    private readonly TimeSpan _waitBudget = PositiveBudget(waitBudget, DefaultWaitBudget, nameof(waitBudget));
    private readonly TimeSpan _renderBudget = PositiveBudget(renderBudget, DefaultRenderBudget, nameof(renderBudget));
    private readonly Func<Task>? _beforeEncode = beforeEncode;
    private readonly object _gate = new();
    private readonly Dictionary<int, Task<PublicArticleBytes>> _pending = new();
    private readonly Dictionary<int, LinkedListNode<Entry>> _entries = new();
    private readonly LinkedList<Entry> _recent = new();
    private readonly SemaphoreSlim _workers = new(ParallelRenders, ParallelRenders);
    private long _bytes;
    private int _coldStarts;
    private int _active;

    internal int ColdStarts => Volatile.Read(ref _coldStarts);

    internal void Warm(IEnumerable<Article> warmArticles, PublicArticleCache? previous, CancellationToken cancellationToken)
    {
        foreach (var article in warmArticles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var value = previous?.FindReusable(article, _media, _siteConfigRevision) ?? Encode(article);
            lock (_gate) Add(article.Id, value);
        }
    }

    private PublicArticleBytes? FindReusable(Article article, PublishedMediaProjection? media, long siteConfigRevision)
    {
        if (_siteConfigRevision != siteConfigRevision) return null;
        // Revision/publication alone cannot prove identity if attached metadata is renamed.
        if (!articles.TryGetValue(article.Id, out var before) ||
            before with { Tags = null } != article with { Tags = null } ||
            !(before.Tags ?? []).SequenceEqual(article.Tags ?? [])) return null;
        if (!(_media?.Images(article.Id, article.Publication) ?? [])
                .SequenceEqual(media?.Images(article.Id, article.Publication) ?? [])) return null;
        lock (_gate) return _entries.TryGetValue(article.Id, out var entry) ? entry.Value.Value : null;
    }

    internal async ValueTask<PublicArticleBytes?> Read(int id, CancellationToken cancellationToken)
    {
        if (!articles.TryGetValue(id, out var article)) return null;
        long arrived;
        Task<PublicArticleBytes> operation;
        lock (_gate)
        {
            if (_entries.TryGetValue(id, out var entry))
            {
                if (entry != _recent.First)
                {
                    _recent.Remove(entry);
                    _recent.AddFirst(entry);
                }
                return entry.Value.Value;
            }

            arrived = Stopwatch.GetTimestamp();
            if (!_pending.TryGetValue(id, out operation!))
            {
                if (_pending.Count >= PendingRenders)
                {
                    Trace("admission-rejected", id, arrived);
                    throw new PublicUnavailableException();
                }
                Interlocked.Increment(ref _coldStarts);
                operation = Task.Run(() => Render(article, arrived));
                _pending.Add(id, operation);
                evidence?.ChangeCache(pending: 1);
                Trace("admitted", id, arrived);
            }
            else Trace("joined", id, arrived);
        }

        try { return await operation.WaitAsync(_waitBudget, cancellationToken); }
        catch (TimeoutException)
        {
            lock (_gate) Trace("wait-timeout", id, arrived);
            throw new PublicUnavailableException();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            lock (_gate) Trace("wait-cancelled", id, arrived);
            throw;
        }
    }

    private async Task<PublicArticleBytes> Render(Article article, long admitted)
    {
        try
        {
            var remaining = _waitBudget - Stopwatch.GetElapsedTime(admitted);
            if (remaining <= TimeSpan.Zero || !await _workers.WaitAsync(remaining))
            {
                lock (_gate) Trace("worker-timeout", article.Id, admitted);
                throw new PublicUnavailableException();
            }
            try
            {
                lock (_gate)
                {
                    if (Stopwatch.GetElapsedTime(admitted) > _waitBudget)
                    {
                        Trace("worker-timeout", article.Id, admitted);
                        throw new PublicUnavailableException();
                    }
                    _active++;
                    evidence?.ChangeCache(active: 1);
                    Trace("started", article.Id, admitted);
                }
                try
                {
                    if (_beforeEncode is not null) await _beforeEncode();
                    var encoded = Encode(article);
                    lock (_gate)
                    {
                        if (Stopwatch.GetElapsedTime(admitted) > _renderBudget)
                        {
                            Trace("render-timeout", article.Id, admitted);
                            throw new PublicUnavailableException();
                        }
                        Add(article.Id, encoded);
                        Trace("ready", article.Id, admitted);
                        return encoded;
                    }
                }
                finally
                {
                    lock (_gate)
                    {
                        _active--;
                        evidence?.ChangeCache(active: -1);
                    }
                }
            }
            finally { _workers.Release(); }
        }
        finally
        {
            lock (_gate)
            {
                _pending.Remove(article.Id);
                evidence?.ChangeCache(pending: -1);
                Trace("finished", article.Id, admitted);
            }
        }
    }

    // Called under the admission lock. Public hits never emit cache diagnostics.
    private void Trace(string kind, int id, long origin)
    {
        if (log?.IsEnabled(LogLevel.Debug) is true)
            LogCold(log, kind, id, generation, _pending.Count, _active,
                (long)Stopwatch.GetElapsedTime(origin).TotalMicroseconds, null);
    }

    private PublicArticleBytes Encode(Article article)
    {
        var wire = PublicArticles.EncodeDetail(article);
        var content = PublicArticleHtml.Render(article, _media?.Images(article.Id, article.Publication));
        var path = $"/article/{DistributionSettings.Number(article.Id)}";
        return new(wire,
            pages.PublicPage(content, article.Title, article.Summary, publicPath: path, contentDriven: true),
            pages.PublicPage(content, article.Title, article.Summary, publicPath: path, contentDriven: true, locale: "en"));
    }

    private void Add(int id, PublicArticleBytes value)
    {
        long size = (long)value.Wire.Length + value.Html.Length + (value.EnglishHtml?.Length ?? 0);
        if (size > ByteLimit || _entries.ContainsKey(id)) return;
        while (_bytes + size > ByteLimit && _recent.Last is { } victim)
        {
            _bytes -= victim.Value.Size;
            _entries.Remove(victim.Value.Id);
            _recent.RemoveLast();
        }
        _entries.Add(id, _recent.AddFirst(new Entry(id, size, value)));
        _bytes += size;
    }

    private static TimeSpan PositiveBudget(TimeSpan? configured, TimeSpan fallback, string name)
    {
        var value = configured ?? fallback;
        if (value <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(name, value, "Cache budget must be positive.");
        return value;
    }

    private sealed record Entry(int Id, long Size, PublicArticleBytes Value);
}
