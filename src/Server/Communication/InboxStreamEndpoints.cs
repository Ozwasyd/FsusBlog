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
            async (HttpContext ctx, Store store, InboxWake wake, InstanceLease lease) =>
        {
            VerifyHandshake(ctx);
            var token = ctx.Request.Cookies[cookie];
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, lease.Stopped);
            var cancellation = lifetime.Token;
            var pulse = wake.Changed;
            long position;
            try { position = await Position(store, token, cancellation); }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new PublicUnavailableException(); }
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
                    var next = await Position(store, token, cancellation);
                    if (next != position)
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
            catch (BusinessException failure) when (failure.Rejection == Rejection.Unauthorized)
            {
                await Close(socket, WebSocketCloseStatus.PolicyViolation, cancellation);
            }
            catch (Exception failure) when (failure is NpgsqlException or PublicUnavailableException)
            {
                await Close(socket, WebSocketCloseStatus.EndpointUnavailable, cancellation);
            }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
            {
                await Close(socket, WebSocketCloseStatus.EndpointUnavailable, cancellation);
            }
            catch (Exception failure) when (failure is WebSocketException or OperationCanceledException) { }
            finally
            {
                if (socket.State == WebSocketState.CloseReceived)
                    await Close(socket, WebSocketCloseStatus.NormalClosure, ctx.RequestAborted);
                await lifetime.CancelAsync();
                await receive;
            }
        }).RequireRateLimiting("inbox-stream");
    }

    private static async Task<long> Position(Store store, string? token, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        return await store.WithSession(token, false, (db, tx, actor) =>
            new InboxStore(db, tx, actor.Id).ReplayPositionAsync(deadline.Token), deadline.Token);
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
}
