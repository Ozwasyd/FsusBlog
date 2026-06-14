using System.Net.WebSockets;
using System.Threading.Channels;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamSessionService
{
    Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken);
}

internal sealed class NotificationStreamSessionService(
    NotificationStreamConnectionManager manager,
    NotificationStreamBacklogStore backlogStore,
    INotificationFrameCodec frameCodec,
    ILogger<NotificationStreamSessionService> logger) : INotificationStreamSessionService
{
    private static readonly TimeSpan HeartbeatWindow = TimeSpan.FromSeconds(25);

    public async Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken)
    {
        string connectionId = Guid.NewGuid().ToString("N");
        NotificationStreamConnection connection = manager.RegisterConnection(connectionId, handshake.UserId, handshake.Groups);
        NotificationStreamCursor cursor = ResolveCursor(context);

        try
        {
            using WebSocket socket = await context.WebSockets.AcceptWebSocketAsync(handshake.Protocol);
            var replay = await backlogStore.ReplayAsync(cursor, handshake.UserId, handshake.Groups, cancellationToken);
            using var sendGate = new SemaphoreSlim(1, 1);
            await SendHeartbeatAsync(socket, sendGate, cancellationToken);
            await SendReplayAsync(socket, replay.Frames, sendGate, cancellationToken);
            await PumpConnectionAsync(socket, connection, sendGate, cancellationToken);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "notification-stream-session-ended-before-accept-or-pump {ConnectionId}", connectionId);
        }
        finally
        {
            manager.RemoveConnection(connectionId);
        }
    }

    private async Task SendHeartbeatAsync(WebSocket socket, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        byte[] frame = frameCodec.EncodeHeartbeatFrame();
        await SendBinaryAsync(socket, frame, sendGate, cancellationToken);
        NotificationStreamMetrics.RecordHeartbeatSent();
    }

    private static async Task SendReplayAsync(WebSocket socket, IReadOnlyList<SharedNotificationStreamFrame> frames, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        int releasedCount = 0;
        try
        {
            for (int i = 0; i < frames.Count; i++)
            {
                await SendBinaryAsync(socket, frames[i].Memory, sendGate, cancellationToken);
                frames[i].Release();
                releasedCount++;
            }
        }
        finally
        {
            for (int i = releasedCount; i < frames.Count; i++)
            {
                frames[i].Release();
            }
        }
    }

    private async Task PumpConnectionAsync(WebSocket socket, NotificationStreamConnection connection, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task heartbeatTask = RunHeartbeatLoopAsync(socket, connection, sendGate, heartbeatCts.Token);

        try
        {
            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                SharedNotificationStreamFrame? frame;
                try
                {
                    frame = await connection.Reader.ReadAsync(cancellationToken);
                }
                catch (ChannelClosedException)
                {
                    break;
                }

                try
                {
                    await SendBinaryAsync(socket, frame.Memory, sendGate, cancellationToken);
                    connection.MarkWriteActivity();
                }
                finally
                {
                    connection.AcknowledgeDequeuedFrame();
                    frame.Release();
                }

                if (socket.State != WebSocketState.Open)
                {
                    break;
                }

                while (connection.Reader.TryRead(out frame))
                {
                    try
                    {
                        await SendBinaryAsync(socket, frame.Memory, sendGate, cancellationToken);
                        connection.MarkWriteActivity();
                    }
                    finally
                    {
                        connection.AcknowledgeDequeuedFrame();
                        frame.Release();
                    }

                    if (socket.State != WebSocketState.Open)
                    {
                        break;
                    }
                }
            }
        }
        finally
        {
            await heartbeatCts.CancelAsync();
            await AwaitHeartbeatLoopShutdownAsync(heartbeatTask);
        }

        await CloseSocketAsync(socket, sendGate);
    }

    private async Task RunHeartbeatLoopAsync(WebSocket socket, NotificationStreamConnection connection, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(HeartbeatWindow);
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            if (socket.State != WebSocketState.Open)
            {
                break;
            }

            if (connection.IsIdle(HeartbeatWindow))
            {
                await SendHeartbeatAsync(socket, sendGate, cancellationToken);
                connection.MarkWriteActivity();
            }
        }
    }

    private static async Task SendBinaryAsync(WebSocket socket, ReadOnlyMemory<byte> frame, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        await sendGate.WaitAsync(cancellationToken);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(frame, WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
            }
        }
        finally
        {
            sendGate.Release();
        }
    }

    private static async Task CloseSocketAsync(WebSocket socket, SemaphoreSlim sendGate)
    {
        await sendGate.WaitAsync(CancellationToken.None);
        try
        {
            if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
            }
        }
        finally
        {
            sendGate.Release();
        }
    }

    private static async Task AwaitHeartbeatLoopShutdownAsync(Task heartbeatTask)
    {
        try
        {
            await heartbeatTask;
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static NotificationStreamCursor ResolveCursor(HttpContext context)
    {
        if (NotificationStreamCursor.TryParse(context.Request.Query["cursor"], out NotificationStreamCursor cursor))
        {
            return cursor;
        }

        return NotificationStreamCursor.TryParse(context.Request.Headers["Last-Event-ID"], out cursor)
            ? cursor
            : NotificationStreamCursor.Empty;
    }
}
