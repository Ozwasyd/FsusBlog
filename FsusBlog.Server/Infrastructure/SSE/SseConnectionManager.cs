using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.Sse;

public sealed class SseClient(string connectionId, string? userId, ChannelWriter<string> writer, IEnumerable<string> groups)
{
    public string ConnectionId { get; } = connectionId;
    public string? UserId { get; } = userId;
    public ChannelWriter<string> Writer { get; } = writer;
    public HashSet<string> Groups { get; } = new(groups);
}

public sealed class SseConnectionManager
{
    private readonly ConcurrentDictionary<string, SseClient> _clients = new();

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public void AddClient(SseClient client) => _clients.TryAdd(client.ConnectionId, client);

    public void RemoveClient(string connectionId) => _clients.TryRemove(connectionId, out _);

    private static string FormatSseEvent(string eventName, object data)
    {
        var payload = JsonSerializer.Serialize(data, _jsonOptions);
        return $"event: {eventName}\ndata: {payload}\n\n";
    }

    public void SendToUser(string userId, string eventName, object data)
    {
        var message = FormatSseEvent(eventName, data);
        foreach (var client in _clients.Values)
        {
            if (client.UserId == userId) client.Writer.TryWrite(message);
        }
    }

    public void SendToUsers(IEnumerable<string> userIds, string eventName, object data)
    {
        var message = FormatSseEvent(eventName, data);
        IReadOnlySet<string> set = userIds as IReadOnlySet<string> ?? userIds.ToHashSet();
        foreach (var client in _clients.Values)
        {
            if (client.UserId != null && set.Contains(client.UserId)) client.Writer.TryWrite(message);
        }
    }

    public void SendToGroup(string groupName, string eventName, object data)
    {
        var message = FormatSseEvent(eventName, data);
        foreach (var client in _clients.Values)
        {
            if (client.Groups.Contains(groupName)) client.Writer.TryWrite(message);
        }
    }

    public void BroadcastPing()
    {
        var message = "event: ping\ndata: {}\n\n";
        foreach (var client in _clients.Values)
        {
            client.Writer.TryWrite(message);
        }
    }
}

// 后台心跳守护进程：自动探测半开 TCP 连接并触发 Cancellation 销毁僵尸内存
public sealed class SseHeartbeatService(SseConnectionManager manager) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            manager.BroadcastPing();
        }
    }
}
