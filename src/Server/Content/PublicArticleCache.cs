using System.Diagnostics;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Content;

internal sealed record PublicArticleBytes(byte[] Wire, byte[] Html);

internal sealed class PublicArticleCache(IReadOnlyDictionary<int, Article> articles, WebPages pages,
    long generation = 0, ILogger? log = null)
{
    private const int ParallelRenders = 4;
    private const int PendingRenders = 64;
    private const long ByteLimit = 96 * 1024 * 1024;
    private static readonly TimeSpan WaitBudget = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan RenderBudget = TimeSpan.FromSeconds(2);
    private static readonly Action<ILogger, string, int, long, int, int, long, Exception?> LogCold =
        LoggerMessage.Define<string, int, long, int, int, long>(LogLevel.Debug, new EventId(2201, "PublicArticleColdCache"),
            "Public article cache {Event} article={ArticleId} generation={Generation} pending={Pending} active={Active} elapsed_us={ElapsedUs}");
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
            var value = previous?.FindReusable(article) ?? Encode(article);
            lock (_gate) Add(article.Id, value);
        }
    }

    private PublicArticleBytes? FindReusable(Article article)
    {
        // Revision/publication alone cannot prove identity if attached metadata is renamed.
        if (!articles.TryGetValue(article.Id, out var before) ||
            before with { Tags = null } != article with { Tags = null } ||
            !(before.Tags ?? []).SequenceEqual(article.Tags ?? [])) return null;
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
                Trace("admitted", id, arrived);
            }
            else Trace("joined", id, arrived);
        }

        try { return await operation.WaitAsync(WaitBudget, cancellationToken); }
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
            var remaining = WaitBudget - Stopwatch.GetElapsedTime(admitted);
            if (remaining <= TimeSpan.Zero || !await _workers.WaitAsync(remaining))
            {
                lock (_gate) Trace("worker-timeout", article.Id, admitted);
                throw new PublicUnavailableException();
            }
            try
            {
                lock (_gate)
                {
                    _active++;
                    Trace("started", article.Id, admitted);
                }
                var encoded = Encode(article);
                lock (_gate)
                {
                    if (Stopwatch.GetElapsedTime(admitted) > RenderBudget)
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
                lock (_gate) _active--;
                _workers.Release();
            }
        }
        finally
        {
            lock (_gate)
            {
                _pending.Remove(article.Id);
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

    private PublicArticleBytes Encode(Article article) => new(PublicArticles.EncodeDetail(article),
        pages.Page(PublicArticleHtml.Render(article), article.Title, article.Summary));

    private void Add(int id, PublicArticleBytes value)
    {
        long size = (long)value.Wire.Length + value.Html.Length;
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

    private sealed record Entry(int Id, long Size, PublicArticleBytes Value);
}
