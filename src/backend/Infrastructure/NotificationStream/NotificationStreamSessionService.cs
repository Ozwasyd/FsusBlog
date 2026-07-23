using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamSessionService
{
    Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken);
}

internal sealed class NotificationStreamSessionService(
    NotificationStreamConnectionManager manager,
    NotificationStreamBacklogStore backlogStore,
    INotificationFrameCodec frameCodec,
    IWebHostEnvironment environment,
    ILogger<NotificationStreamSessionService> logger,
    NotificationStreamRestartCoordinator? restartCoordinator = null) : INotificationStreamSessionService
{
    private static readonly TimeSpan s_heartbeatWindow = TimeSpan.FromSeconds(25);
    private static readonly TimeSpan s_defaultDrillSendDelay = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan s_minDrillSendDelay = TimeSpan.FromMilliseconds(25);
    private static readonly TimeSpan s_maxDrillSendDelay = TimeSpan.FromSeconds(5);
    private const int DefaultDrillQueueCapacity = 32;
    private const int MinDrillQueueCapacity = 32;
    private const int MaxDrillQueueCapacity = 4096;

    public async Task RunAsync(HttpContext context, NotificationStreamHandshake handshake, CancellationToken cancellationToken)
    {
        using CancellationTokenSource sessionCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            restartCoordinator?.RestartToken ?? CancellationToken.None);
        CancellationToken sessionToken = sessionCancellation.Token;
        string connectionId = Guid.NewGuid().ToString("N");
        NotificationStreamCursor cursor = ResolveCursor(context);
        TimeSpan? drillSendDelay = ResolveDrillSendDelay(context);
        int? drillQueueCapacity = ResolveDrillQueueCapacity(context);
        NotificationStreamConnection connection = manager.RegisterConnection(
            connectionId,
            handshake.UserId,
            handshake.Groups,
            drillQueueCapacity,
            context.GetClientIp());

        try
        {
            using WebSocket socket = await context.WebSockets.AcceptWebSocketAsync(handshake.Protocol);
            using var sendGate = new SemaphoreSlim(1, 1);
            if (restartCoordinator?.IsRestartRequested == true)
            {
                await CloseSocketAsync(
                    socket,
                    sendGate,
                    NotificationStreamRestartProtocol.Resolve(replayMissed: false, serviceRestartRequested: true));
                return;
            }

            long replayStarted = Stopwatch.GetTimestamp();
            var replay = await backlogStore.ReplayAsync(cursor, handshake.UserId, handshake.Groups, cancellationToken);
            if (replay.MissedGap)
            {
                ReleaseReplayFrames(replay.Frames);
                await CloseSocketAsync(
                    socket,
                    sendGate,
                    NotificationStreamRestartProtocol.Resolve(replayMissed: true, serviceRestartRequested: false));
                return;
            }

            if (restartCoordinator?.IsRestartRequested == true)
            {
                ReleaseReplayFrames(replay.Frames);
                await CloseSocketAsync(
                    socket,
                    sendGate,
                    NotificationStreamRestartProtocol.Resolve(replayMissed: false, serviceRestartRequested: true));
                return;
            }

            try
            {
                await SendHeartbeatAsync(socket, sendGate, sessionToken);
                await SendReplayAsync(socket, replay.Frames, sendGate, sessionToken);
                NotificationStreamMetrics.RecordReplayLiveTransitionGap(Stopwatch.GetElapsedTime(replayStarted));
                await PumpConnectionAsync(socket, connection, sendGate, drillSendDelay, sessionToken);
            }
            catch (OperationCanceledException) when (sessionToken.IsCancellationRequested)
            {
                await CloseSocketAsync(
                    socket,
                    sendGate,
                    NotificationStreamRestartProtocol.Resolve(
                        replayMissed: false,
                        serviceRestartRequested: restartCoordinator?.IsRestartRequested == true));
            }
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

    private static void ReleaseReplayFrames(IReadOnlyList<SharedNotificationStreamFrame> frames)
    {
        for (int i = 0; i < frames.Count; i++)
        {
            frames[i].Release();
        }
    }

    private async Task PumpConnectionAsync(WebSocket socket, NotificationStreamConnection connection, SemaphoreSlim sendGate, TimeSpan? drillSendDelay, CancellationToken cancellationToken)
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
                    if (connection.IsClosed)
                    {
                        break;
                    }

                    await SendQueuedFrameAsync(socket, connection, frame.Memory, sendGate, drillSendDelay, cancellationToken);
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
                        if (connection.IsClosed)
                        {
                            break;
                        }

                        await SendQueuedFrameAsync(socket, connection, frame.Memory, sendGate, drillSendDelay, cancellationToken);
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
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            await heartbeatCts.CancelAsync();
            await AwaitHeartbeatLoopShutdownAsync(heartbeatTask);
        }

        await CloseSocketAsync(
            socket,
            sendGate,
            connection.IsClosed
                ? connection.CloseInstruction
                : NotificationStreamRestartProtocol.Resolve(
                    replayMissed: false,
                    serviceRestartRequested: restartCoordinator?.IsRestartRequested == true));
    }

    private static async Task SendQueuedFrameAsync(
        WebSocket socket,
        NotificationStreamConnection connection,
        ReadOnlyMemory<byte> frame,
        SemaphoreSlim sendGate,
        TimeSpan? drillSendDelay,
        CancellationToken cancellationToken)
    {
        if (drillSendDelay is { } delay)
        {
            await Task.Delay(delay, cancellationToken);
        }

        long started = Stopwatch.GetTimestamp();
        await SendBinaryAsync(socket, frame, sendGate, cancellationToken);
        connection.RecordSendLatency(Stopwatch.GetElapsedTime(started));
        connection.MarkWriteActivity();
    }

    private async Task RunHeartbeatLoopAsync(WebSocket socket, NotificationStreamConnection connection, SemaphoreSlim sendGate, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(s_heartbeatWindow);
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            if (socket.State != WebSocketState.Open)
            {
                break;
            }

            if (connection.IsIdle(s_heartbeatWindow))
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

    private static async Task CloseSocketAsync(
        WebSocket socket,
        SemaphoreSlim sendGate,
        NotificationStreamCloseInstruction closeInstruction)
    {
        await sendGate.WaitAsync(CancellationToken.None);
        try
        {
            if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(
                    NotificationStreamRestartProtocol.ToWebSocketCloseStatus(closeInstruction),
                    closeInstruction.Reason,
                    CancellationToken.None);
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

    private TimeSpan? ResolveDrillSendDelay(HttpContext context)
    {
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            return null;
        }

        if (!IsEnabled(context.Request.Query["drillSlowConsumer"]))
        {
            return null;
        }

        if (!int.TryParse(context.Request.Query["drillReadDelayMs"], NumberStyles.None, CultureInfo.InvariantCulture, out int delayMs))
        {
            return s_defaultDrillSendDelay;
        }

        long boundedMs = Math.Clamp(delayMs, (int)s_minDrillSendDelay.TotalMilliseconds, (int)s_maxDrillSendDelay.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(boundedMs);
    }

    private int? ResolveDrillQueueCapacity(HttpContext context)
    {
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            return null;
        }

        if (!IsEnabled(context.Request.Query["drillSlowConsumer"]))
        {
            return null;
        }

        if (!int.TryParse(context.Request.Query["drillQueueCapacity"], NumberStyles.None, CultureInfo.InvariantCulture, out int capacity))
        {
            return DefaultDrillQueueCapacity;
        }

        return Math.Clamp(capacity, MinDrillQueueCapacity, MaxDrillQueueCapacity);
    }

    private static bool IsEnabled(string? value)
        => string.Equals(value, "1", StringComparison.Ordinal)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
}
