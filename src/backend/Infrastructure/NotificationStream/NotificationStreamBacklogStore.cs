using System.Globalization;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Shared.Contracts.NotificationStream;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public readonly record struct NotificationStreamAppendResult(bool Appended);

public sealed class NotificationStreamBacklogStore(IConnectionMultiplexer redis, IRuntimeKeyScope keyScope, ILogger<NotificationStreamBacklogStore> logger)
{
    private const string SequenceKey = "fsus:notification-stream:v2:sequence";
    private const string IdempotencyKeyPrefix = "fsus:notification-stream:v2:idempotency:";
    private const string RouteStreamPrefix = "fsus:notification-stream:v2:route:";
    private const string PublishOrderLockKey = "fsus:notification-stream:v2:publish-order-lock";
    private const int StreamMaxLength = 4096;
    private const int MaxReplayEntries = 512;
    private static readonly TimeSpan IdempotencyRetention = TimeSpan.FromDays(7);
    private static readonly TimeSpan PublishOrderLockExpiry = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan PublishOrderRetryDelay = TimeSpan.FromMilliseconds(10);

    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<RedisValue> AcquirePublishOrderLockAsync(CancellationToken cancellationToken = default)
    {
        RedisKey lockKey = keyScope.PrefixKey(PublishOrderLockKey);
        RedisValue lockToken = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        while (!await _database.LockTakeAsync(lockKey, lockToken, PublishOrderLockExpiry).ConfigureAwait(false))
        {
            await Task.Delay(PublishOrderRetryDelay, cancellationToken).ConfigureAwait(false);
        }

        return lockToken;
    }

    public Task<bool> ReleasePublishOrderLockAsync(RedisValue lockToken)
        => _database.LockReleaseAsync(keyScope.PrefixKey(PublishOrderLockKey), lockToken);

    public async Task<long> NextEventIdAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await _database.StringIncrementAsync(keyScope.PrefixKey(SequenceKey)).ConfigureAwait(false);
    }

    public async Task<long> GetOrCreateEventIdAsync(
        string? idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return await NextEventIdAsync(cancellationToken).ConfigureAwait(false);
        }

        RedisKey dedupeKey = keyScope.PrefixKey(string.Concat(IdempotencyKeyPrefix, idempotencyKey));
        RedisKey sequenceKey = keyScope.PrefixKey(SequenceKey);
        RedisResult result = await _database.ScriptEvaluateAsync(
            """
            local existing = redis.call('GET', KEYS[1])
            if existing then
                return existing
            end
            local event_id = redis.call('INCR', KEYS[2])
            redis.call('SET', KEYS[1], event_id, 'PX', ARGV[1], 'NX')
            return event_id
            """,
            [dedupeKey, sequenceKey],
            [(RedisValue)(long)IdempotencyRetention.TotalMilliseconds]).ConfigureAwait(false);
        return (long)result;
    }

    public async Task<Result<NotificationStreamAppendResult>> AppendAsync(
        long eventId,
        string route,
        SharedNotificationStreamFrame frame,
        CancellationToken cancellationToken = default,
        bool idempotent = false)
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            IReadOnlyList<string> storageRoutes = NotificationStreamTargetRouteCodec.GetStorageRoutes(route);
            if (storageRoutes.Count == 0)
            {
                return Result<NotificationStreamAppendResult>.Failure(
                    ErrorCode.Validation,
                    "Notification stream backlog route invalid");
            }

            RedisValue streamId = string.Concat(eventId.ToString(CultureInfo.InvariantCulture), "-0");
            if (idempotent)
            {
                bool appended = false;
                foreach (string storageRoute in storageRoutes)
                {
                    appended |= await AppendToRouteIdempotentlyAsync(RouteStreamKey(storageRoute), streamId, frame)
                        .ConfigureAwait(false);
                }
                return Result<NotificationStreamAppendResult>.Success(new NotificationStreamAppendResult(appended));
            }

            if (storageRoutes.Count == 1)
            {
                await _database.StreamAddAsync(
                        RouteStreamKey(storageRoutes[0]),
                        "f",
                        frame.BufferMemory,
                        streamId,
                        StreamMaxLength,
                        useApproximateMaxLength: true)
                    .ConfigureAwait(false);
                return Result<NotificationStreamAppendResult>.Success(new NotificationStreamAppendResult(true));
            }

            IBatch batch = _database.CreateBatch();
            var writes = new Task<RedisValue>[storageRoutes.Count];
            for (int i = 0; i < storageRoutes.Count; i++)
            {
                writes[i] = batch.StreamAddAsync(
                    RouteStreamKey(storageRoutes[i]),
                    "f",
                    frame.BufferMemory,
                    streamId,
                    StreamMaxLength,
                    useApproximateMaxLength: true);
            }

            batch.Execute();
            await Task.WhenAll(writes).ConfigureAwait(false);
            return Result<NotificationStreamAppendResult>.Success(new NotificationStreamAppendResult(true));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to append notification stream backlog entry. EventId: {EventId}", eventId);
            return Result<NotificationStreamAppendResult>.Failure(
                ErrorCode.InfraFailure,
                "Notification stream backlog append failed");
        }
    }

    private async Task<bool> AppendToRouteIdempotentlyAsync(
        RedisKey streamKey,
        RedisValue streamId,
        SharedNotificationStreamFrame frame)
    {
        StreamEntry[] existing = await _database.StreamRangeAsync(streamKey, streamId, streamId, 1)
            .ConfigureAwait(false);
        if (existing.Length > 0)
        {
            return false;
        }

        try
        {
            await _database.StreamAddAsync(
                    streamKey,
                    "f",
                    frame.BufferMemory,
                    streamId,
                    StreamMaxLength,
                    useApproximateMaxLength: true)
                .ConfigureAwait(false);
            return true;
        }
        catch
        {
            existing = await _database.StreamRangeAsync(streamKey, streamId, streamId, 1).ConfigureAwait(false);
            if (existing.Length == 0)
            {
                throw;
            }

            return false;
        }
    }

    public async Task<NotificationStreamReplayBatch> ReplayAsync(NotificationStreamCursor cursor, string? userId, IReadOnlySet<string> groups, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!cursor.HasValue)
        {
            return NotificationStreamReplayBatch.Empty;
        }

        try
        {
            IReadOnlyList<string> replayRoutes = NotificationStreamTargetRouteCodec.GetReplayRoutes(userId, groups);
            string start = string.Create(CultureInfo.InvariantCulture, $"{cursor.Value + 1}-0");
            bool missedGap = false;
            int scannedEntries = 0;
            List<ReplayEntry> replayEntries = [];
            RouteReplayReadBatch routeReplayBatch = await ReadRouteReplaysAsync(replayRoutes, start, cursor.Value).ConfigureAwait(false);
            RouteReplayRead[] reads = routeReplayBatch.Reads;
            int redisCommandCount = routeReplayBatch.RedisCommandCount;
            for (int routeIndex = 0; routeIndex < reads.Length; routeIndex++)
            {
                RouteReplayRead read = reads[routeIndex];
                missedGap |= read.MissedGap;
                StreamEntry[] entries = read.Entries;
                scannedEntries += entries.Length;
                foreach (StreamEntry entry in entries)
                {
                    if (!TryParseEventId(entry.Id, out long eventId))
                    {
                        continue;
                    }

                    if (!TryGetField(entry, "f", out RedisValue frameValue) || frameValue.IsNullOrEmpty)
                    {
                        continue;
                    }

                    replayEntries.Add(new ReplayEntry(eventId, frameValue));
                }
            }

            replayEntries.Sort(static (left, right) => left.EventId.CompareTo(right.EventId));

            var seenEventIds = new HashSet<long>();
            List<SharedNotificationStreamFrame> frames = [];
            int dedupedEntries = 0;
            foreach (ReplayEntry replayEntry in replayEntries)
            {
                if (!seenEventIds.Add(replayEntry.EventId))
                {
                    dedupedEntries++;
                    continue;
                }

                if (frames.Count >= MaxReplayEntries)
                {
                    continue;
                }

                byte[]? buffer = replayEntry.Frame;
                if (buffer is null || buffer.Length == 0)
                {
                    continue;
                }
                frames.Add(SharedNotificationStreamFrame.FromArray(buffer));
            }

            NotificationStreamMetrics.RecordReplay(frames.Count, missedGap, replayRoutes.Count, scannedEntries, dedupedEntries, redisCommandCount);
            return new NotificationStreamReplayBatch(frames, missedGap);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to replay notification stream backlog. Cursor: {Cursor}", cursor.Value);
            return NotificationStreamReplayBatch.Empty;
        }
    }

    private string RouteStreamKey(string route)
        => keyScope.PrefixKey(RouteStreamPrefix + route);

    private async Task<RouteReplayReadBatch> ReadRouteReplaysAsync(IReadOnlyList<string> routes, string start, long cursorValue)
    {
        if (routes.Count == 0)
        {
            return new RouteReplayReadBatch([], 0);
        }

        if (routes.Count == 1)
        {
            RouteReplayRead read = await ReadRouteReplayAsync(routes[0], start, cursorValue).ConfigureAwait(false);
            return new RouteReplayReadBatch([read], 1);
        }

        IBatch batch = _database.CreateBatch();
        PendingRouteReplayRead[] pendingReads = new PendingRouteReplayRead[routes.Count];
        string cursorUpperBound = string.Create(CultureInfo.InvariantCulture, $"{cursorValue}-0");
        for (int i = 0; i < routes.Count; i++)
        {
            string streamKey = RouteStreamKey(routes[i]);
            pendingReads[i] = new PendingRouteReplayRead(
                batch.StreamRangeAsync(streamKey, count: 1),
                batch.StreamRangeAsync(streamKey, start, "+", MaxReplayEntries),
                batch.StreamRangeAsync(
                    streamKey,
                    "-",
                    cursorUpperBound,
                    count: 1,
                    messageOrder: Order.Descending));
        }

        batch.Execute();

        RouteReplayRead[] reads = new RouteReplayRead[pendingReads.Length];
        for (int i = 0; i < pendingReads.Length; i++)
        {
            PendingRouteReplayRead pending = pendingReads[i];
            await Task.WhenAll(pending.First, pending.Entries, pending.CursorFloor).ConfigureAwait(false);
            StreamEntry[] first = await pending.First.ConfigureAwait(false);
            StreamEntry[] cursorFloor = await pending.CursorFloor.ConfigureAwait(false);
            bool missedGap = first.Length > 0
                && TryParseEventId(first[0].Id, out long firstEventId)
                && firstEventId > cursorValue + 1
                && !HasRetainedCursorFloor(cursorFloor, cursorValue);
            reads[i] = new RouteReplayRead(await pending.Entries.ConfigureAwait(false), missedGap);
        }

        return new RouteReplayReadBatch(reads, routes.Count);
    }

    private async Task<RouteReplayRead> ReadRouteReplayAsync(string route, string start, long cursorValue)
    {
        string streamKey = RouteStreamKey(route);
        IBatch batch = _database.CreateBatch();
        Task<StreamEntry[]> firstTask = batch.StreamRangeAsync(streamKey, count: 1);
        Task<StreamEntry[]> entriesTask = batch.StreamRangeAsync(streamKey, start, "+", MaxReplayEntries);
        string cursorUpperBound = string.Create(CultureInfo.InvariantCulture, $"{cursorValue}-0");
        Task<StreamEntry[]> cursorFloorTask = batch.StreamRangeAsync(
            streamKey,
            "-",
            cursorUpperBound,
            count: 1,
            messageOrder: Order.Descending);
        batch.Execute();
        await Task.WhenAll(firstTask, entriesTask, cursorFloorTask).ConfigureAwait(false);

        StreamEntry[] first = await firstTask.ConfigureAwait(false);
        StreamEntry[] cursorFloor = await cursorFloorTask.ConfigureAwait(false);
        bool missedGap = first.Length > 0
            && TryParseEventId(first[0].Id, out long firstEventId)
            && firstEventId > cursorValue + 1
            && !HasRetainedCursorFloor(cursorFloor, cursorValue);
        return new RouteReplayRead(await entriesTask.ConfigureAwait(false), missedGap);
    }

    private static bool HasRetainedCursorFloor(StreamEntry[] cursorFloor, long cursorValue)
        => cursorFloor.Length > 0
            && TryParseEventId(cursorFloor[0].Id, out long floorEventId)
            && floorEventId <= cursorValue;

    private static bool TryGetField(StreamEntry entry, string fieldName, out RedisValue value)
    {
        foreach (NameValueEntry current in entry.Values)
        {
            if (string.Equals(current.Name, fieldName, StringComparison.Ordinal))
            {
                value = current.Value;
                return true;
            }
        }

        value = RedisValue.Null;
        return false;
    }

    private static bool TryParseEventId(RedisValue streamId, out long eventId)
    {
        string? raw = streamId.ToString();
        int separator = raw?.IndexOf('-') ?? -1;
        if (separator <= 0)
        {
            eventId = 0;
            return false;
        }

        return long.TryParse(raw.AsSpan(0, separator), NumberStyles.None, CultureInfo.InvariantCulture, out eventId);
    }

    private readonly record struct ReplayEntry(long EventId, RedisValue Frame);
    private readonly record struct RouteReplayRead(StreamEntry[] Entries, bool MissedGap);
    private readonly record struct PendingRouteReplayRead(
        Task<StreamEntry[]> First,
        Task<StreamEntry[]> Entries,
        Task<StreamEntry[]> CursorFloor);
    private readonly record struct RouteReplayReadBatch(RouteReplayRead[] Reads, int RedisCommandCount);
}

public sealed record NotificationStreamReplayBatch(IReadOnlyList<SharedNotificationStreamFrame> Frames, bool MissedGap)
{
    public static NotificationStreamReplayBatch Empty { get; } = new(Array.Empty<SharedNotificationStreamFrame>(), false);
}

internal static class NotificationStreamTargetRouteCodec
{
    private const string UserPrefix = "u:";
    private const string GroupPrefix = "g:";
    private const string MultiUserPrefix = "m:";

    public static Result<string> TryEncode(NotificationStreamTarget target) => target switch
    {
        NotificationStreamUserTarget user => Result<string>.Success(UserPrefix + user.AccountId),
        NotificationStreamGroupTarget group => Result<string>.Success(GroupPrefix + group.GroupName),
        NotificationStreamMultiUserTarget multi => Result<string>.Success(MultiUserPrefix + string.Join(',', multi.UserIds)),
        _ => Result<string>.Failure(ErrorCode.Validation, "Unsupported notification stream target.")
    };

    public static IReadOnlyList<string> GetReplayRoutes(string? userId, IReadOnlySet<string> groups)
    {
        var routes = new List<string>(groups.Count + (string.IsNullOrEmpty(userId) ? 0 : 1));
        if (!string.IsNullOrEmpty(userId))
        {
            routes.Add(UserPrefix + userId);
        }

        foreach (string group in groups)
        {
            if (!string.IsNullOrWhiteSpace(group))
            {
                routes.Add(GroupPrefix + group);
            }
        }

        return routes;
    }

    public static IReadOnlyList<string> GetStorageRoutes(string route)
    {
        if (route.StartsWith(MultiUserPrefix, StringComparison.Ordinal))
        {
            return ExpandMultiUserRoutes(route.AsSpan(MultiUserPrefix.Length));
        }

        return string.IsNullOrWhiteSpace(route) ? [] : [route];
    }

    public static bool Matches(string? route, string? userId, IReadOnlySet<string> groups)
    {
        if (string.IsNullOrWhiteSpace(route) || route.Length < 3)
        {
            return false;
        }

        ReadOnlySpan<char> target = route.AsSpan(2);
        return route[0] switch
        {
            'u' => !string.IsNullOrEmpty(userId) && target.Equals(userId.AsSpan(), StringComparison.Ordinal),
            'g' => groups.Contains(target.ToString()),
            'm' => !string.IsNullOrEmpty(userId) && ContainsUser(target, userId),
            _ => false
        };
    }

    private static IReadOnlyList<string> ExpandMultiUserRoutes(ReadOnlySpan<char> routeUsers)
    {
        var routes = new List<string>();
        while (!routeUsers.IsEmpty)
        {
            int comma = routeUsers.IndexOf(',');
            ReadOnlySpan<char> segment = comma >= 0 ? routeUsers[..comma] : routeUsers;
            segment = segment.Trim();
            if (!segment.IsEmpty)
            {
                routes.Add(UserPrefix + segment.ToString());
            }

            if (comma < 0)
            {
                break;
            }

            routeUsers = routeUsers[(comma + 1)..];
        }

        return routes;
    }

    private static bool ContainsUser(ReadOnlySpan<char> routeUsers, string userId)
    {
        while (!routeUsers.IsEmpty)
        {
            int comma = routeUsers.IndexOf(',');
            ReadOnlySpan<char> segment = comma >= 0 ? routeUsers[..comma] : routeUsers;
            if (segment.Trim().Equals(userId.AsSpan(), StringComparison.Ordinal))
            {
                return true;
            }

            if (comma < 0)
            {
                break;
            }

            routeUsers = routeUsers[(comma + 1)..];
        }

        return false;
    }
}
