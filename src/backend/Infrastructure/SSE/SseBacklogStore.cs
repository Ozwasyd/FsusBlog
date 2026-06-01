using System.Globalization;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Shared.Contracts.Sse;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SseBacklogStore(IConnectionMultiplexer redis, IRuntimeKeyScope keyScope, ILogger<SseBacklogStore> logger)
{
    private const string SequenceKey = "fsus:sse:v2:sequence";
    private const string RouteStreamPrefix = "fsus:sse:v2:route:";
    private const int StreamMaxLength = 4096;
    private const int MaxReplayEntries = 512;

    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<long> NextEventIdAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await _database.StringIncrementAsync(keyScope.PrefixKey(SequenceKey)).ConfigureAwait(false);
    }

    public async Task<Result> AppendAsync(long eventId, string route, SharedSseFrame frame, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            IReadOnlyList<string> storageRoutes = TargetRouteCodec.GetStorageRoutes(route);
            if (storageRoutes.Count == 0)
            {
                return Result.Failure(ErrorCode.Validation, "SSE backlog route invalid");
            }

            NameValueEntry[] fields = [new("f", frame.BufferMemory)];
            string streamId = string.Create(CultureInfo.InvariantCulture, $"{eventId}-0");
            if (storageRoutes.Count == 1)
            {
                await _database.StreamAddAsync(
                        RouteStreamKey(storageRoutes[0]),
                        fields,
                        streamId,
                        StreamMaxLength,
                        useApproximateMaxLength: true)
                    .ConfigureAwait(false);
                return Result.Success();
            }

            IBatch batch = _database.CreateBatch();
            var writes = new Task<RedisValue>[storageRoutes.Count];
            for (int i = 0; i < storageRoutes.Count; i++)
            {
                writes[i] = batch.StreamAddAsync(
                    RouteStreamKey(storageRoutes[i]),
                    fields,
                    streamId,
                    StreamMaxLength,
                    useApproximateMaxLength: true);
            }

            batch.Execute();
            await Task.WhenAll(writes).ConfigureAwait(false);
            return Result.Success();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to append SSE backlog entry. EventId: {EventId}", eventId);
            return Result.Failure(ErrorCode.InfraFailure, "SSE backlog append failed");
        }
    }

    public async Task<SseReplayBatch> ReplayAsync(SseCursor cursor, string? userId, IReadOnlySet<string> groups, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!cursor.HasValue)
        {
            return SseReplayBatch.Empty;
        }

        try
        {
            IReadOnlyList<string> replayRoutes = TargetRouteCodec.GetReplayRoutes(userId, groups);
            string start = string.Create(CultureInfo.InvariantCulture, $"{cursor.Value + 1}-0");
            bool missedGap = false;
            int scannedEntries = 0;
            List<ReplayEntry> replayEntries = [];
            Task<RouteReplayRead>[] routeReads = replayRoutes
                .Select(route => ReadRouteReplayAsync(route, start, cursor.Value))
                .ToArray();

            RouteReplayRead[] reads = await Task.WhenAll(routeReads).ConfigureAwait(false);
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
            List<SharedSseFrame> frames = [];
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
                frames.Add(SharedSseFrame.FromArray(buffer));
            }

            SseMetrics.RecordReplay(frames.Count, missedGap, replayRoutes.Count, scannedEntries, dedupedEntries);
            return new SseReplayBatch(frames, missedGap);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to replay SSE backlog. Cursor: {Cursor}", cursor.Value);
            return SseReplayBatch.Empty;
        }
    }

    private string RouteStreamKey(string route)
        => keyScope.PrefixKey(RouteStreamPrefix + route);

    private async Task<RouteReplayRead> ReadRouteReplayAsync(string route, string start, long cursorValue)
    {
        string streamKey = RouteStreamKey(route);
        Task<StreamEntry[]> firstTask = _database.StreamRangeAsync(streamKey, count: 1);
        Task<StreamEntry[]> entriesTask = _database.StreamRangeAsync(streamKey, start, "+", MaxReplayEntries);
        await Task.WhenAll(firstTask, entriesTask).ConfigureAwait(false);

        StreamEntry[] first = await firstTask.ConfigureAwait(false);
        bool missedGap = first.Length > 0
            && TryParseEventId(first[0].Id, out long firstEventId)
            && firstEventId > cursorValue + 1;
        return new RouteReplayRead(await entriesTask.ConfigureAwait(false), missedGap);
    }

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
}

public sealed record SseReplayBatch(IReadOnlyList<SharedSseFrame> Frames, bool MissedGap)
{
    public static SseReplayBatch Empty { get; } = new(Array.Empty<SharedSseFrame>(), false);
}

internal static class TargetRouteCodec
{
    private const string UserPrefix = "u:";
    private const string GroupPrefix = "g:";
    private const string MultiUserPrefix = "m:";

    public static Result<string> TryEncode(SseTarget target) => target switch
    {
        UserTarget user => Result<string>.Success(UserPrefix + user.UserId),
        GroupTarget group => Result<string>.Success(GroupPrefix + group.GroupName),
        MultiUserTarget multi => Result<string>.Success(MultiUserPrefix + string.Join(',', multi.UserIds)),
        _ => Result<string>.Failure(ErrorCode.Validation, "Unsupported SSE target.")
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
