using System.Net.WebSockets;
using System.Threading.Channels;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Infrastructure.Sse;

internal interface INotificationStreamSessionService
{
    Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken);
}

internal sealed class NotificationStreamSessionService(
    SseConnectionManager manager,
    SseBacklogStore backlogStore,
    INotificationFrameCodec frameCodec) : INotificationStreamSessionService
{
    private static readonly TimeSpan HeartbeatWindow = TimeSpan.FromSeconds(25);

    public async Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken)
    {
        string connectionId = Guid.NewGuid().ToString("N");
        SseConnection connection = manager.RegisterConnection(connectionId, handshake.UserId, handshake.Groups);
        SseCursor cursor = ResolveCursor(context);

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
        finally
        {
            manager.RemoveConnection(connectionId);
        }
    }

    private async Task SendHeartbeatAsync(WebSocket socket, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        byte[] frame = frameCodec.EncodeHeartbeatFrame();
        await SendBinaryAsync(socket, frame, sendGate, cancellationToken);
        SseMetrics.RecordHeartbeatSent();
    }

    private static async Task SendReplayAsync(WebSocket socket, IReadOnlyList<SharedSseFrame> frames, SemaphoreSlim sendGate, CancellationToken cancellationToken)
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

    private async Task PumpConnectionAsync(WebSocket socket, SseConnection connection, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task heartbeatTask = RunHeartbeatLoopAsync(socket, connection, sendGate, heartbeatCts.Token);

        try
        {
            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                SharedSseFrame? frame;
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

        if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "closed", CancellationToken.None);
        }
    }

    private async Task RunHeartbeatLoopAsync(WebSocket socket, SseConnection connection, SemaphoreSlim sendGate, CancellationToken cancellationToken)
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

    private static SseCursor ResolveCursor(HttpContext context)
    {
        if (SseCursor.TryParse(context.Request.Query["cursor"], out SseCursor cursor))
        {
            return cursor;
        }

        return SseCursor.TryParse(context.Request.Headers["Last-Event-ID"], out cursor)
            ? cursor
            : SseCursor.Empty;
    }
}
