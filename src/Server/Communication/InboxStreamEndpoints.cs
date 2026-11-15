using System.Net;
using System.Net.WebSockets;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Communication;

internal static class InboxStreamEndpoints
{
    private const string Protocol = "fsus-inbox-wake.v2";
    private static readonly TimeSpan Recheck = TimeSpan.FromSeconds(4);
    private static readonly byte[] Wake = Wire.EncodeEmptySuccess();

    internal static void Map(WebApplication app, string cookie)
    {
        app.MapMethods(WireRoutes.InboxStream, [HttpMethods.Get, HttpMethods.Connect],
            (HttpContext ctx, Store store, InboxWake wake, InstanceLease lease) =>
        {
            var token = ctx.Request.Cookies[cookie];
            return Open(ctx, wake, lease, ct => store.WithSession(token, false, (db, tx, actor) =>
                new InboxStore(db, tx, actor.Id).ReplayPositionAsync(ct), ct));
        }).RequireRateLimiting("inbox-stream");
    }

    internal static async Task Open<T>(HttpContext ctx, InboxWake wake, InstanceLease lease,
        Func<CancellationToken, Task<T>> readPosition) where T : IEquatable<T>
    {
        VerifyHandshake(ctx);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, lease.Stopped);
        var cancellation = lifetime.Token;
        var pulse = wake.Changed;
        var position = await Position();
        using var socket = await ctx.WebSockets.AcceptWebSocketAsync(Protocol);
        var receive = Receive(socket, lifetime);
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                // Bound checks even if the DB notification listener is disconnected or busy.
                try { await pulse.WaitAsync(Recheck, cancellation); }
                catch (TimeoutException) { }
                pulse = wake.Changed;
                var next = await Position();
                if (!next.Equals(position))
                {
                    lease.RequireCurrent();
                    using var send = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                    send.CancelAfter(TimeSpan.FromSeconds(1));
                    await socket.SendAsync(Wake.AsMemory(), WebSocketMessageType.Binary, true, send.Token);
                    position = next;
                }
                // Coalesce bursts and cap the read rate for each admitted connection.
                await Task.Delay(TimeSpan.FromMilliseconds(250), cancellation);
            }
        }
        catch (BusinessException failure) when (failure.Rejection is Rejection.Unauthorized or Rejection.Forbidden)
        {
            await CloseAndDrain(socket, receive, WebSocketCloseStatus.PolicyViolation, cancellation);
        }
        catch (Exception failure) when (failure is NpgsqlException or PublicUnavailableException or
            BusinessException { Rejection: Rejection.NotFound })
        {
            await CloseAndDrain(socket, receive, WebSocketCloseStatus.EndpointUnavailable, cancellation);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            await CloseAndDrain(socket, receive, WebSocketCloseStatus.EndpointUnavailable, cancellation);
        }
        catch (Exception failure) when (failure is WebSocketException or OperationCanceledException) { }
        finally
        {
            if (socket.State == WebSocketState.CloseReceived)
                await Close(socket, WebSocketCloseStatus.NormalClosure, ctx.RequestAborted);
            await lifetime.CancelAsync();
            await receive;
        }

        async Task<T> Position()
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            deadline.CancelAfter(TimeSpan.FromSeconds(2));
            try { return await readPosition(deadline.Token); }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new PublicUnavailableException(); }
        }
    }

    private static void VerifyHandshake(HttpContext ctx)
    {
        var request = ctx.Request;
        var origin = request.Headers.Origin;
        if ((!request.IsHttps && (ctx.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer))) ||
            origin.Count != 1 ||
            !string.Equals(origin[0], $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase) ||
            (request.Headers.TryGetValue("Sec-Fetch-Site", out var site) && site.ToString() != "same-origin"))
            throw new BusinessException(Rejection.Forbidden, "This inbox stream requires a same-origin connection.");
        if (request.QueryString.HasValue || !ctx.WebSockets.IsWebSocketRequest ||
            ctx.WebSockets.WebSocketRequestedProtocols is not [Protocol])
            throw new BusinessException(Rejection.Invalid, "Invalid inbox stream handshake.");
    }

    private static async Task Receive(WebSocket socket, CancellationTokenSource lifetime)
    {
        try
        {
            var received = await socket.ReceiveAsync(new byte[1].AsMemory(), lifetime.Token);
            if (received.MessageType != WebSocketMessageType.Close)
                socket.Abort();
        }
        catch (Exception failure) when (failure is WebSocketException or OperationCanceledException) { }
        finally { await lifetime.CancelAsync(); }
    }

    private static async Task Close(WebSocket socket, WebSocketCloseStatus status, CancellationToken cancellation)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived)) return;
        using var close = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        close.CancelAfter(TimeSpan.FromSeconds(1));
        try { await socket.CloseOutputAsync(status, null, close.Token); }
        catch (Exception failure) when (failure is WebSocketException or OperationCanceledException) { }
    }

    private static async Task CloseAndDrain(WebSocket socket, Task receive, WebSocketCloseStatus status, CancellationToken cancellation)
    {
        await Close(socket, status, cancellation);
        if (socket.State != WebSocketState.CloseSent) return;
        // Cancelling the still-pending receive aborts the transport and can discard the close frame.
        try { await receive.WaitAsync(TimeSpan.FromSeconds(1), cancellation); }
        catch (Exception failure) when (failure is TimeoutException or OperationCanceledException) { }
    }
}
