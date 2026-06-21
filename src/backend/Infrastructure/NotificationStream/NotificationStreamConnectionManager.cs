using System.Collections.Concurrent;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public sealed class NotificationStreamConnectionManager(IConfiguration configuration, ILogger<NotificationStreamConnectionManager> logger)
{
    private const int MinQueueCapacity = 32;
    private const int MaxQueueCapacity = 4096;

    private readonly ConcurrentDictionary<string, NotificationStreamConnection> _byConnectionId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _byUserId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _byGroup = new(StringComparer.Ordinal);
    private readonly int _queueCapacity = NormalizeQueueCapacity(configuration.GetValue<int?>("NotificationStream:QueueCapacity") ?? 256);

    public int ConnectionCount => _byConnectionId.Count;

    public NotificationStreamConnection RegisterConnection(string connectionId, string? userId, IReadOnlyCollection<string> groups, int? queueCapacityOverride = null)
    {
        if (_byConnectionId.ContainsKey(connectionId))
        {
            throw new InvalidOperationException($"Duplicate notification stream connection id: {connectionId}");
        }

        int queueCapacity = queueCapacityOverride.HasValue ? NormalizeQueueCapacity(queueCapacityOverride.Value) : _queueCapacity;
        var connection = new NotificationStreamConnection(connectionId, userId, groups, queueCapacity);
        if (!_byConnectionId.TryAdd(connectionId, connection))
        {
            connection.Complete();
            connection.Drain();
            throw new InvalidOperationException($"Duplicate notification stream connection id: {connectionId}");
        }

        try
        {
            if (!string.IsNullOrEmpty(userId))
            {
                AddToIndex(_byUserId, userId, connectionId);
            }

            foreach (string group in connection.Groups)
            {
                AddToIndex(_byGroup, group, connectionId);
            }
        }
        catch
        {
            _byConnectionId.TryRemove(connectionId, out _);
            if (!string.IsNullOrEmpty(userId))
            {
                RemoveFromIndex(_byUserId, userId, connectionId);
            }

            foreach (string group in connection.Groups)
            {
                RemoveFromIndex(_byGroup, group, connectionId);
            }

            connection.Complete();
            connection.Drain();
            throw;
        }

        NotificationStreamMetrics.ConnectionOpened();
        logger.LogDebug("Notification stream connection registered. ConnectionId: {ConnectionId} | UserId: {UserId}", connectionId, userId);
        return connection;
    }

    private static int NormalizeQueueCapacity(int value)
        => Math.Clamp(value, MinQueueCapacity, MaxQueueCapacity);

    public void RemoveConnection(string connectionId)
    {
        if (!_byConnectionId.TryRemove(connectionId, out NotificationStreamConnection? connection))
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
        NotificationStreamMetrics.ConnectionClosed();

        logger.LogDebug("Notification stream connection removed. ConnectionId: {ConnectionId}", connectionId);
    }

    public int Publish(SharedNotificationStreamFrame frame, NotificationStreamTarget target)
    {
        int delivered = 0;
        foreach (NotificationStreamConnection connection in ResolveConnectionsSnapshot(target))
        {
            frame.Retain();
            if (connection.TryEnqueue(frame))
            {
                delivered++;
            }
        }

        return delivered;
    }

    private IReadOnlyList<NotificationStreamConnection> ResolveConnectionsSnapshot(NotificationStreamTarget target)
    {
        return target switch
        {
            NotificationStreamUserTarget account => ResolveAccountTarget(account),
            NotificationStreamGroupTarget group => ResolveByIndexSnapshot(_byGroup, group.GroupName),
            NotificationStreamMultiUserTarget multi => ResolveMultiUser(multi.UserIds),
            _ => []
        };
    }

    private IReadOnlyList<NotificationStreamConnection> ResolveAccountTarget(NotificationStreamUserTarget target)
        => ResolveByIndexSnapshot(_byUserId, target.AccountId);

    private IReadOnlyList<NotificationStreamConnection> ResolveByIndexSnapshot(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key)
    {
        if (!index.TryGetValue(key, out ConcurrentDictionary<string, byte>? connectionIds))
        {
            return [];
        }

        KeyValuePair<string, byte>[] snapshot = connectionIds.ToArray();
        if (snapshot.Length == 0)
        {
            return [];
        }

        var connections = new List<NotificationStreamConnection>(snapshot.Length);
        foreach ((string connectionId, _) in snapshot)
        {
            if (_byConnectionId.TryGetValue(connectionId, out NotificationStreamConnection? connection))
            {
                connections.Add(connection);
            }
        }

        return connections;
    }

    private IReadOnlyList<NotificationStreamConnection> ResolveMultiUser(IReadOnlyList<string> userIds)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        List<NotificationStreamConnection>? connections = null;

        foreach (string userId in userIds)
        {
            if (!_byUserId.TryGetValue(userId, out ConcurrentDictionary<string, byte>? connectionIds))
            {
                continue;
            }

            KeyValuePair<string, byte>[] snapshot = connectionIds.ToArray();
            foreach ((string connectionId, _) in snapshot)
            {
                if (!seen.Add(connectionId))
                {
                    continue;
                }

                if (_byConnectionId.TryGetValue(connectionId, out NotificationStreamConnection? connection))
                {
                    connections ??= new List<NotificationStreamConnection>(snapshot.Length);
                    connections.Add(connection);
                }
            }
        }

        return connections ?? [];
    }

    private static void AddToIndex(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key, string connectionId)
    {
        while (true)
        {
            ConcurrentDictionary<string, byte> connections = index.GetOrAdd(key, static _ => new ConcurrentDictionary<string, byte>(StringComparer.Ordinal));
            lock (connections)
            {
                // The bucket may have been removed after GetOrAdd returned; never add to an orphaned bucket.
                if (!index.TryGetValue(key, out ConcurrentDictionary<string, byte>? current) || !ReferenceEquals(current, connections))
                {
                    continue;
                }

                connections.TryAdd(connectionId, 0);
                return;
            }
        }
    }

    private static void RemoveFromIndex(ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index, string key, string connectionId)
    {
        if (!index.TryGetValue(key, out ConcurrentDictionary<string, byte>? connections))
        {
            return;
        }

        lock (connections)
        {
            connections.TryRemove(connectionId, out _);
            if (connections.IsEmpty)
            {
                TryRemoveBucketIfCurrent(index, key, connections);
            }
        }
    }

    internal static bool TryRemoveBucketIfCurrent(
        ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> index,
        string key,
        ConcurrentDictionary<string, byte> connections)
    {
        lock (connections)
        {
            return connections.IsEmpty
                && index.TryRemove(new KeyValuePair<string, ConcurrentDictionary<string, byte>>(key, connections));
        }
    }
}

public sealed class NotificationStreamConnection
{
    private readonly Channel<SharedNotificationStreamFrame> _queue;
    private readonly HashSet<string> _groups;
    private readonly int _queueCapacity;
    private int _queuedFrames;
    private int _closed;
    private long _lastActivityUnixMs;

    internal NotificationStreamConnection(string connectionId, string? userId, IReadOnlyCollection<string> groups, int queueCapacity)
    {
        ConnectionId = connectionId;
        UserId = userId;
        _groups = new HashSet<string>(groups, StringComparer.Ordinal);
        _queueCapacity = queueCapacity;
        _queue = Channel.CreateBounded<SharedNotificationStreamFrame>(new BoundedChannelOptions(queueCapacity)
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

    public ChannelReader<SharedNotificationStreamFrame> Reader => _queue.Reader;

    public bool IsClosed => Volatile.Read(ref _closed) == 1;

    public bool IsIdle(TimeSpan idleWindow)
        => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Volatile.Read(ref _lastActivityUnixMs) >= (long)idleWindow.TotalMilliseconds;

    public void MarkWriteActivity() => Touch();

    public bool TryEnqueue(SharedNotificationStreamFrame frame)
    {
        // Consumes one caller-transferred retain on every path:
        // success queues it for the writer, failure releases it here.
        if (Volatile.Read(ref _closed) == 1)
        {
            frame.Release();
            return false;
        }

        int depth = Interlocked.Increment(ref _queuedFrames);
        if (depth > _queueCapacity)
        {
            Interlocked.Decrement(ref _queuedFrames);
            CloseSlowConsumer();
            frame.Release();
            return false;
        }

        if (_queue.Writer.TryWrite(frame))
        {
            Touch();
            NotificationStreamMetrics.RecordQueueDepth(depth);
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
        while (_queue.Reader.TryRead(out SharedNotificationStreamFrame? frame))
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

        NotificationStreamMetrics.RecordSlowDisconnect();
        _queue.Writer.TryComplete();
    }

    private void Touch() => Volatile.Write(ref _lastActivityUnixMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
}
