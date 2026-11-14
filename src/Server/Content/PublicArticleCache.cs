using System.Diagnostics;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Content;

internal sealed record PublicArticleBytes(byte[] Wire, byte[] Html);

internal sealed class PublicArticleCache(IReadOnlyDictionary<int, Article> articles, WebPages pages)
{
    private const int ParallelRenders = 4;
    private const int PendingRenders = 64;
    private const long ByteLimit = 96 * 1024 * 1024;
    private readonly object _gate = new();
    private readonly Dictionary<int, Task<PublicArticleBytes>> _pending = new();
    private readonly Dictionary<int, LinkedListNode<Entry>> _entries = new();
    private readonly LinkedList<Entry> _recent = new();
    private readonly SemaphoreSlim _workers = new(ParallelRenders, ParallelRenders);
    private long _bytes;
    private int _coldStarts;

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

            if (!_pending.TryGetValue(id, out operation!))
            {
                if (_pending.Count >= PendingRenders) throw new PublicUnavailableException();
                Interlocked.Increment(ref _coldStarts);
                operation = Task.Run(() => Render(article));
                _pending.Add(id, operation);
            }
        }

        try { return await operation.WaitAsync(TimeSpan.FromMilliseconds(750), cancellationToken); }
        catch (TimeoutException) { throw new PublicUnavailableException(); }
    }

    private async Task<PublicArticleBytes> Render(Article article)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            if (!await _workers.WaitAsync(TimeSpan.FromMilliseconds(750))) throw new PublicUnavailableException();
            try
            {
                var encoded = Encode(article);
                if (Stopwatch.GetElapsedTime(started) > TimeSpan.FromSeconds(2)) throw new PublicUnavailableException();
                lock (_gate) Add(article.Id, encoded);
                return encoded;
            }
            finally { _workers.Release(); }
        }
        finally
        {
            lock (_gate) _pending.Remove(article.Id);
        }
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
