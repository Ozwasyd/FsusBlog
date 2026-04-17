using System.Globalization;
using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Sse;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SseBacklogStore(IConnectionMultiplexer redis, ILogger<SseBacklogStore> logger)
{
    private const string StreamKey = "fsus:sse:v2:stream";
    private const string SequenceKey = "fsus:sse:v2:sequence";
    private const int StreamMaxLength = 4096;
    private const int MaxReplayEntries = 512;

    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<long> NextEventIdAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return await _database.StringIncrementAsync(SequenceKey).ConfigureAwait(false);
    }

    public async Task<Result> AppendAsync(long eventId, string route, SharedSseFrame frame, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            NameValueEntry[] fields = [
                new("r", route),
                new("f", frame.BufferMemory)
            ];

            await _database.StreamAddAsync(
                    StreamKey,
                    fields,
                    string.Create(CultureInfo.InvariantCulture, $"{eventId}-0"),
                    StreamMaxLength,
                    useApproximateMaxLength: true)
                .ConfigureAwait(false);

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
            StreamEntry[] first = await _database.StreamRangeAsync(StreamKey, count: 1).ConfigureAwait(false);
            bool missedGap = first.Length > 0 && TryParseEventId(first[0].Id, out long firstEventId) && firstEventId > cursor.Value + 1;

            string start = string.Create(CultureInfo.InvariantCulture, $"{cursor.Value + 1}-0");
            StreamEntry[] entries = await _database.StreamRangeAsync(StreamKey, start, "+", MaxReplayEntries).ConfigureAwait(false);

            List<SharedSseFrame> frames = [];
            foreach (StreamEntry entry in entries)
            {
                if (!TryGetField(entry, "r", out RedisValue routeValue) || !TargetRouteCodec.Matches(routeValue.ToString(), userId, groups))
                {
                    continue;
                }

                if (!TryGetField(entry, "f", out RedisValue frameValue) || frameValue.IsNullOrEmpty)
                {
                    continue;
                }

                byte[]? buffer = frameValue;
                if (buffer is null || buffer.Length == 0)
                {
                    continue;
                }

                frames.Add(SharedSseFrame.FromArray(buffer));
            }

            SseMetrics.RecordReplay(frames.Count, missedGap);
            return new SseReplayBatch(frames, missedGap);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to replay SSE backlog. Cursor: {Cursor}", cursor.Value);
            return SseReplayBatch.Empty;
        }
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
}

public sealed record SseReplayBatch(IReadOnlyList<SharedSseFrame> Frames, bool MissedGap)
{
    public static SseReplayBatch Empty { get; } = new(Array.Empty<SharedSseFrame>(), false);
}

internal static class TargetRouteCodec
{
    public static Result<string> TryEncode(SseTarget target) => target switch
    {
        UserTarget user => Result<string>.Success($"u:{user.UserId}"),
        GroupTarget group => Result<string>.Success($"g:{group.GroupName}"),
        MultiUserTarget multi => Result<string>.Success($"m:{string.Join(',', multi.UserIds)}"),
        _ => Result<string>.Failure(ErrorCode.Validation, "Unsupported SSE target.")
    };

    public static bool Matches(string? route, string? userId, IReadOnlySet<string> groups)
    {
        if (string.IsNullOrWhiteSpace(route) || route.Length < 3)
        {
            return false;
        }

        return route[0] switch
        {
            'u' => !string.IsNullOrEmpty(userId) && string.Equals(route[2..], userId, StringComparison.Ordinal),
            'g' => groups.Contains(route[2..]),
            'm' => !string.IsNullOrEmpty(userId) && route[2..].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Contains(userId, StringComparer.Ordinal),
            _ => false
        };
    }
}
