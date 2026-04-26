using System.Collections.Concurrent;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SseConnectionManager(IConfiguration configuration, ILogger<SseConnectionManager> logger)
{
    private readonly ConcurrentDictionary<string, SseConnection> _byConnectionId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _byUserId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _byGroup = new(StringComparer.Ordinal);
    private readonly int _queueCapacity = Math.Clamp(configuration.GetValue<int?>("Sse:QueueCapacity") ?? 256, 32, 4096);

    public int ConnectionCount => _byConnectionId.Count;

    public SseConnection RegisterConnection(string connectionId, string? userId, IReadOnlyCollection<string> groups)
    {
        var connection = new SseConnection(connectionId, userId, groups, _queueCapacity);
        if (!_byConnectionId.TryAdd(connectionId, connection))
        {
            throw new InvalidOperationException($"Duplicate SSE connection id: {connectionId}");
        }

        if (!string.IsNullOrEmpty(userId))
        {
            AddToIndex(_byUserId, userId, connectionId);
        }

        foreach (string group in groups)
        {
            AddToIndex(_byGroup, group, connectionId);
        }

        SseMetrics.ConnectionOpened();
        logger.LogDebug("SSE connection registered. ConnectionId: {ConnectionId} | UserId: {UserId}", connectionId, userId);
        return connection;
    }

    public void RemoveConnection(string connectionId)
    {
        if (!_byConnectionId.TryRemove(connectionId, out SseConnection? connection))
        {
            return;
        }

        if (!string.IsNullOrEmpty(connection.UserId))
        {
            RemoveFromIndex(_byUserId, connection.UserId, connectionId);
        }

        foreach (string group in connection.Groups)
        {
            RemoveFromIndex(_byGroup, group, connectionId);
        }

        connection.Complete();
        connection.Drain();
        SseMetrics.ConnectionClosed();

        logger.LogDebug("SSE connection removed. ConnectionId: {ConnectionId}", connectionId);
    }

    public int Publish(SharedSseFrame frame, SseTarget target)
    {
        int delivered = 0;
        foreach (SseConnection connection in ResolveConnections(target))
        {
            if (connection.TryEnqueue(frame))
            {
                delivered++;
            }
        }

        return delivered;
    }

    private IEnumerable<SseConnection> ResolveConnections(SseTarget target)
    {
        return target switch
        {
            UserTarget user => ResolveByIndex(_byUserId, user.UserId),
            GroupTarget group => ResolveByIndex(_byGroup, group.GroupName),
            MultiUserTarget multi => ResolveMultiUser(multi.UserIds),
            _ => Array.Empty<SseConnection>()
        };
    }

    private IEnumerable<SseConnection> ResolveByIndex(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key)
    {
        if (!index.TryGetValue(key, out ConcurrentDictionary<string, byte>? connectionIds))
        {
            yield break;
        }

        foreach ((string connectionId, _) in connectionIds)
        {
            if (_byConnectionId.TryGetValue(connectionId, out SseConnection? connection))
            {
                yield return connection;
            }
        }
    }

    private IEnumerable<SseConnection> ResolveMultiUser(IReadOnlyList<string> userIds)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (string userId in userIds)
        {
            if (!_byUserId.TryGetValue(userId, out ConcurrentDictionary<string, byte>? connectionIds))
            {
                continue;
            }

            foreach ((string connectionId, _) in connectionIds)
            {
                if (!seen.Add(connectionId))
                {
                    continue;
                }

                if (_byConnectionId.TryGetValue(connectionId, out SseConnection? connection))
                {
                    yield return connection;
                }
            }
        }
    }

    private static void AddToIndex(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key, string connectionId)
    {
        ConcurrentDictionary<string, byte> connections = index.GetOrAdd(key, static _ => new ConcurrentDictionary<string, byte>(StringComparer.Ordinal));
        connections.TryAdd(connectionId, 0);
    }

    private static void RemoveFromIndex(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key, string connectionId)
    {
        if (!index.TryGetValue(key, out ConcurrentDictionary<string, byte>? connections))
        {
            return;
        }

        connections.TryRemove(connectionId, out _);
        if (connections.IsEmpty)
        {
            TryRemoveBucketIfCurrent(index, key, connections);
        }
    }

    internal static bool TryRemoveBucketIfCurrent(
        ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index,
        string key,
        ConcurrentDictionary<string, byte> connections)
        => index.TryRemove(new KeyValuePair<string, ConcurrentDictionary<string, byte>>(key, connections));
}

public sealed class SseConnection
{
    private readonly Channel<SharedSseFrame> _queue;
    private readonly HashSet<string> _groups;
    private readonly int _queueCapacity;
    private int _queuedFrames;
    private int _closed;
    private long _lastActivityUnixMs;

    internal SseConnection(string connectionId, string? userId, IReadOnlyCollection<string> groups, int queueCapacity)
    {
        ConnectionId = connectionId;
        UserId = userId;
        _groups = new HashSet<string>(groups, StringComparer.Ordinal);
        _queueCapacity = queueCapacity;
        _queue = Channel.CreateBounded<SharedSseFrame>(new BoundedChannelOptions(queueCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false
        });

        Touch();
    }

    public string ConnectionId { get; }

    public string? UserId { get; }

    public IReadOnlySet<string> Groups => _groups;

    public ChannelReader<SharedSseFrame> Reader => _queue.Reader;

    public bool IsIdle(TimeSpan idleWindow)
        => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Volatile.Read(ref _lastActivityUnixMs) >= (long)idleWindow.TotalMilliseconds;

    public void MarkWriteActivity() => Touch();

    public bool TryEnqueue(SharedSseFrame frame)
    {
        if (Volatile.Read(ref _closed) == 1)
        {
            return false;
        }

        int depth = Interlocked.Increment(ref _queuedFrames);
        if (depth > _queueCapacity)
        {
            Interlocked.Decrement(ref _queuedFrames);
            CloseSlowConsumer();
            return false;
        }

        frame.Retain();
        if (_queue.Writer.TryWrite(frame))
        {
            Touch();
            SseMetrics.RecordQueueDepth(depth);
            return true;
        }

        frame.Release();
        Interlocked.Decrement(ref _queuedFrames);
        CloseSlowConsumer();
        return false;
    }

    public void AcknowledgeDequeuedFrame()
    {
        int depth = Interlocked.Decrement(ref _queuedFrames);
        if (depth < 0)
        {
            Interlocked.Exchange(ref _queuedFrames, 0);
        }

        Touch();
    }

    public void Complete()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }

        _queue.Writer.TryComplete();
    }

    public void Drain()
    {
        while (_queue.Reader.TryRead(out SharedSseFrame? frame))
        {
            AcknowledgeDequeuedFrame();
            frame.Release();
        }
    }

    private void CloseSlowConsumer()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }

        SseMetrics.RecordSlowDisconnect();
        _queue.Writer.TryComplete();
    }

    private void Touch() => Volatile.Write(ref _lastActivityUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
}
