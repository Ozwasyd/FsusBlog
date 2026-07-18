using System.Collections.Concurrent;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public enum NotificationStreamConnectionLimitScope
{
    Global,
    Ip,
    Account
}

public sealed class NotificationStreamConnectionLimitExceededException(NotificationStreamConnectionLimitScope scope)
    : InvalidOperationException($"Notification stream connection limit exceeded: {scope}")
{
    public NotificationStreamConnectionLimitScope Scope { get; } = scope;
}

public sealed class NotificationStreamDeploymentUnavailableException(string errorCode)
    : InvalidOperationException(errorCode)
{
    public string ErrorCode { get; } = errorCode;
}

public sealed class NotificationStreamConnectionManager(
    IConfiguration configuration,
    ILogger<NotificationStreamConnectionManager> logger,
    DeploymentRuntimeState? deploymentRuntime = null)
{
    private const int MinQueueCapacity = 32;
    private const int MaxQueueCapacity = 4096;
    private const int DefaultMaxConnectionsGlobal = 10_000;
    private const int DefaultMaxConnectionsPerIp = 100;
    private const int DefaultMaxConnectionsPerAccount = 10;

    private readonly ConcurrentDictionary<string, NotificationStreamConnection> _byConnectionId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConnectionIndexBucket> _byUserId = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConnectionIndexBucket> _byGroup = new(StringComparer.Ordinal);
    private readonly object _quotaGate = new();
    private readonly Dictionary<string, int> _connectionsByIp = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _connectionsByAccount = new(StringComparer.Ordinal);
    private readonly int _queueCapacity = NormalizeQueueCapacity(configuration.GetValue<int?>("NotificationStream:QueueCapacity") ?? 256);
    private readonly int _maxConnectionsGlobal = NormalizeLimit(configuration.GetValue<int?>("NotificationStream:MaxConnectionsGlobal"), DefaultMaxConnectionsGlobal);
    private readonly int _maxConnectionsPerIp = NormalizeLimit(configuration.GetValue<int?>("NotificationStream:MaxConnectionsPerIp"), DefaultMaxConnectionsPerIp);
    private readonly int _maxConnectionsPerAccount = NormalizeLimit(configuration.GetValue<int?>("NotificationStream:MaxConnectionsPerAccount"), DefaultMaxConnectionsPerAccount);
    private int _reservedConnectionCount;

    public int ConnectionCount => _byConnectionId.Count;

    public NotificationStreamConnection RegisterConnection(
        string connectionId,
        string? userId,
        IReadOnlyCollection<string> groups,
        int? queueCapacityOverride = null,
        string? clientIp = null)
    {
        if (deploymentRuntime is not null && !deploymentRuntime.CanAcceptNotificationStream)
        {
            throw new NotificationStreamDeploymentUnavailableException(
                deploymentRuntime.IsDraining ? "deployment_draining" : "deployment_not_active");
        }
        if (_byConnectionId.ContainsKey(connectionId))
        {
            throw new InvalidOperationException($"Duplicate notification stream connection id: {connectionId}");
        }

        string ipQuotaKey = NormalizeQuotaKey(clientIp, "unknown-ip");
        string accountQuotaKey = ResolveAccountQuotaKey(userId, ipQuotaKey);
        AcquireQuota(ipQuotaKey, accountQuotaKey);

        int queueCapacity = queueCapacityOverride.HasValue ? NormalizeQueueCapacity(queueCapacityOverride.Value) : _queueCapacity;
        var connection = new NotificationStreamConnection(connectionId, userId, groups, queueCapacity, ipQuotaKey, accountQuotaKey);
        if (!_byConnectionId.TryAdd(connectionId, connection))
        {
            ReleaseQuota(ipQuotaKey, accountQuotaKey);
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
            ReleaseQuota(ipQuotaKey, accountQuotaKey);
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

    private static int NormalizeLimit(int? value, int fallback)
        => Math.Clamp(value.GetValueOrDefault(fallback), 1, 1_000_000);

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
        ReleaseQuota(connection.IpQuotaKey, connection.AccountQuotaKey);
        NotificationStreamMetrics.ConnectionClosed();

        logger.LogDebug("Notification stream connection removed. ConnectionId: {ConnectionId}", connectionId);
    }

    public int Publish(SharedNotificationStreamFrame frame, NotificationStreamTarget target)
    {
        long allocationEstimateBytes = EstimatePublishAllocationBytes(target);
        int delivered = target switch
        {
            NotificationStreamUserTarget account => PublishByIndexSnapshot(frame, _byUserId, account.AccountId),
            NotificationStreamGroupTarget group => PublishByIndexSnapshot(frame, _byGroup, group.GroupName),
            NotificationStreamMultiUserTarget multi => PublishMultiUser(frame, multi.UserIds),
            _ => 0
        };

        NotificationStreamMetrics.RecordPublishFanout(delivered, target, allocationEstimateBytes);
        return delivered;
    }

    private static long EstimatePublishAllocationBytes(NotificationStreamTarget target)
        => target is NotificationStreamMultiUserTarget multi
            ? Math.Max(0, multi.UserIds.Count) * 32L
            : 0;

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

    private IReadOnlyList<NotificationStreamConnection> ResolveByIndexSnapshot(ConcurrentDictionary<string, ConnectionIndexBucket> index, string key)
    {
        if (!index.TryGetValue(key, out ConnectionIndexBucket? bucket))
        {
            return [];
        }

        string[] snapshot = bucket.Snapshot;
        if (snapshot.Length == 0)
        {
            return [];
        }

        var connections = new List<NotificationStreamConnection>(snapshot.Length);
        foreach (string connectionId in snapshot)
        {
            if (_byConnectionId.TryGetValue(connectionId, out NotificationStreamConnection? connection))
            {
                connections.Add(connection);
            }
        }

        return connections;
    }

    private int PublishByIndexSnapshot(SharedNotificationStreamFrame frame, ConcurrentDictionary<string, ConnectionIndexBucket> index, string key)
    {
        if (!index.TryGetValue(key, out ConnectionIndexBucket? bucket))
        {
            return 0;
        }

        return PublishToConnectionIds(frame, bucket.Snapshot);
    }

    private int PublishToConnectionIds(SharedNotificationStreamFrame frame, IReadOnlyList<string> connectionIds)
    {
        int delivered = 0;
        foreach (string connectionId in connectionIds)
        {
            if (!_byConnectionId.TryGetValue(connectionId, out NotificationStreamConnection? connection))
            {
                continue;
            }

            frame.Retain();
            if (connection.TryEnqueue(frame))
            {
                delivered++;
            }
        }

        return delivered;
    }

    private IReadOnlyList<NotificationStreamConnection> ResolveMultiUser(IReadOnlyList<string> userIds)
    {
        var seenConnectionIds = new HashSet<string>(StringComparer.Ordinal);
        List<NotificationStreamConnection>? connections = null;

        foreach (string userId in userIds)
        {
            if (!_byUserId.TryGetValue(userId, out ConnectionIndexBucket? bucket))
            {
                continue;
            }

            string[] snapshot = bucket.Snapshot;
            foreach (string connectionId in snapshot)
            {
                if (!seenConnectionIds.Add(connectionId))
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

    private int PublishMultiUser(SharedNotificationStreamFrame frame, IReadOnlyList<string> userIds)
    {
        var seenConnectionIds = new HashSet<string>(StringComparer.Ordinal);
        int delivered = 0;

        foreach (string userId in userIds)
        {
            if (!_byUserId.TryGetValue(userId, out ConnectionIndexBucket? bucket))
            {
                continue;
            }

            foreach (string connectionId in bucket.Snapshot)
            {
                if (!seenConnectionIds.Add(connectionId))
                {
                    continue;
                }

                if (!_byConnectionId.TryGetValue(connectionId, out NotificationStreamConnection? connection))
                {
                    continue;
                }

                frame.Retain();
                if (connection.TryEnqueue(frame))
                {
                    delivered++;
                }
            }
        }

        return delivered;
    }

    private static void AddToIndex(ConcurrentDictionary<string, ConnectionIndexBucket> index, string key, string connectionId)
    {
        while (true)
        {
            ConnectionIndexBucket bucket = index.GetOrAdd(key, static _ => new ConnectionIndexBucket());
            lock (bucket)
            {
                // The bucket may have been removed after GetOrAdd returned; never add to an orphaned bucket.
                if (!index.TryGetValue(key, out ConnectionIndexBucket? current) || !ReferenceEquals(current, bucket))
                {
                    continue;
                }

                bucket.Add(connectionId);
                return;
            }
        }
    }

    private void AcquireQuota(string ipQuotaKey, string accountQuotaKey)
    {
        lock (_quotaGate)
        {
            if (_reservedConnectionCount >= _maxConnectionsGlobal)
            {
                throw new NotificationStreamConnectionLimitExceededException(NotificationStreamConnectionLimitScope.Global);
            }

            if (GetCount(_connectionsByIp, ipQuotaKey) >= _maxConnectionsPerIp)
            {
                throw new NotificationStreamConnectionLimitExceededException(NotificationStreamConnectionLimitScope.Ip);
            }

            if (GetCount(_connectionsByAccount, accountQuotaKey) >= _maxConnectionsPerAccount)
            {
                throw new NotificationStreamConnectionLimitExceededException(NotificationStreamConnectionLimitScope.Account);
            }

            _reservedConnectionCount++;
            Increment(_connectionsByIp, ipQuotaKey);
            Increment(_connectionsByAccount, accountQuotaKey);
        }
    }

    private void ReleaseQuota(string ipQuotaKey, string accountQuotaKey)
    {
        lock (_quotaGate)
        {
            if (_reservedConnectionCount > 0)
            {
                _reservedConnectionCount--;
            }

            Decrement(_connectionsByIp, ipQuotaKey);
            Decrement(_connectionsByAccount, accountQuotaKey);
        }
    }

    private static int GetCount(Dictionary<string, int> counts, string key)
        => counts.TryGetValue(key, out int count) ? count : 0;

    private static void Increment(Dictionary<string, int> counts, string key)
        => counts[key] = GetCount(counts, key) + 1;

    private static void Decrement(Dictionary<string, int> counts, string key)
    {
        if (!counts.TryGetValue(key, out int count))
        {
            return;
        }

        if (count <= 1)
        {
            counts.Remove(key);
            return;
        }

        counts[key] = count - 1;
    }

    private static string ResolveAccountQuotaKey(string? userId, string ipQuotaKey)
        => string.IsNullOrWhiteSpace(userId)
            ? string.Concat("anonymous:", ipQuotaKey)
            : string.Concat("account:", userId.Trim());

    private static string NormalizeQuotaKey(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    private static void RemoveFromIndex(ConcurrentDictionary<string, ConnectionIndexBucket> index, string key, string connectionId)
    {
        if (!index.TryGetValue(key, out ConnectionIndexBucket? bucket))
        {
            return;
        }

        lock (bucket)
        {
            bucket.Remove(connectionId);
            if (bucket.IsEmpty)
            {
                TryRemoveBucketIfCurrent(index, key, bucket);
            }
        }
    }

    internal static bool TryRemoveBucketIfCurrent(
        ConcurrentDictionary<string, ConnectionIndexBucket> index,
        string key,
        ConnectionIndexBucket bucket)
    {
        lock (bucket)
        {
            return bucket.IsEmpty
                && index.TryRemove(new KeyValuePair<string, ConnectionIndexBucket>(key, bucket));
        }
    }
}

internal sealed class ConnectionIndexBucket
{
    private readonly ConcurrentDictionary<string, byte> _connections = new(StringComparer.Ordinal);
    private string[] _snapshot = [];

    public string[] Snapshot => Volatile.Read(ref _snapshot);

    public bool IsEmpty => _connections.IsEmpty;

    public void Add(string connectionId)
    {
        if (_connections.TryAdd(connectionId, 0))
        {
            RefreshSnapshot();
        }
    }

    public void Remove(string connectionId)
    {
        if (_connections.TryRemove(connectionId, out _))
        {
            RefreshSnapshot();
        }
    }

    private void RefreshSnapshot()
        => Volatile.Write(ref _snapshot, _connections.Keys.ToArray());
}

public sealed class NotificationStreamConnection
{
    private readonly Channel<SharedNotificationStreamFrame> _queue;
    private readonly HashSet<string> _groups;
    private readonly int _queueCapacity;
    private int _queuedFrames;
    private int _closed;
    private long _lastActivityUnixMs;

    internal NotificationStreamConnection(
        string connectionId,
        string? userId,
        IReadOnlyCollection<string> groups,
        int queueCapacity,
        string ipQuotaKey = "unknown-ip",
        string accountQuotaKey = "anonymous:unknown-ip")
    {
        ConnectionId = connectionId;
        UserId = userId;
        IpQuotaKey = ipQuotaKey;
        AccountQuotaKey = accountQuotaKey;
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

    public string ConnectionId
    {
        get;
    }

    public string? UserId
    {
        get;
    }

    internal string IpQuotaKey
    {
        get;
    }

    internal string AccountQuotaKey
    {
        get;
    }

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
