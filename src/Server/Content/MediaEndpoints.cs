using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.V2.Server.Content;

internal static class MediaEndpoints
{
    internal const string StorageSetting = "FSUSBLOG_PRIVATE_MEDIA_ROOT";
    internal const string WritePolicy = "private-media-upload";
    internal const string ReadPolicy = "private-media-read";
    internal sealed class PrivateRead;

    internal static void AddRateLimits(RateLimiterOptions options)
    {
        options.AddConcurrencyLimiter(WritePolicy, limiter => { limiter.PermitLimit = 2; limiter.QueueLimit = 0; });
        options.AddConcurrencyLimiter(ReadPolicy, limiter => { limiter.PermitLimit = 4; limiter.QueueLimit = 0; });
    }

    internal static void Map(WebApplication app, string cookie)
    {
        app.MapGet(WireRoutes.PrivateMediaList, async (HttpContext ctx, Store store, MediaStore media, CancellationToken token) =>
        {
            var boundary = Position(ctx);
            var rows = await store.WithSession(ctx.Request.Cookies[cookie], true,
                (db, tx, actor) => media.List(db, tx, actor.Id, boundary, token), token);
            var more = rows.Count == 51;
            return Results.Bytes(Wire.EncodePrivateMedia(rows.Take(50).Select(Contract).ToArray(), more), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.PrivateMediaUpload, async (HttpContext ctx, Store store, MediaStore media, CancellationToken token) =>
        {
            var session = ctx.Request.Cookies[cookie];
            await store.WithSession(session, true, (_, _, _) => Task.FromResult(true), token);
            var key = Key(Only(ctx.Request.Headers[WireHeaders.ClientMutationId], 36));
            var name = Only(ctx.Request.Query["name"], 255) ?? throw Invalid("Set an image name.");
            var type = ctx.Request.ContentType ?? string.Empty;
            var length = RequireLength(ctx);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(45));

            try
            {
                var image = await MediaImage.ReadAsync(ctx.Request.Body, length, name, type, deadline.Token);
                var id = await store.WithSession(session, true,
                    (db, tx, actor) => media.Reserve(db, tx, actor.Id, key, image, deadline.Token), deadline.Token);
                var record = await store.WithSession(session, true,
                    (db, tx, actor) => media.Activate(db, tx, actor.Id, id, image, deadline.Token), deadline.Token);
                return Results.Bytes(Wire.EncodePrivateMedia([Contract(record)]), Aeds.ContentType);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                throw new BadHttpRequestException("The private media upload exceeded its deadline.", StatusCodes.Status408RequestTimeout);
            }
        }).RequireRateLimiting(WritePolicy);

        app.MapPost(WireRoutes.PrivateMediaRemove, async (string id, HttpContext ctx, Store store, MediaStore media, CancellationToken token) =>
        {
            var asset = Key(id);
            var session = ctx.Request.Cookies[cookie];
            var found = await store.WithSession(session, true,
                (db, tx, actor) => media.Tombstone(db, tx, actor.Id, asset, token), token);
            if (!found) throw new BusinessException(Rejection.NotFound, "Private media not found.");
            await store.WithSession(session, true, async (db, tx, actor) =>
            {
                await media.FinishRemoval(db, tx, actor.Id, asset, token);
                return true;
            }, token);
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapMethods(WireRoutes.PrivateMediaRead, [HttpMethods.Get, HttpMethods.Head], async (
            string id, HttpContext ctx, Store store, MediaStore media, CancellationToken token) =>
        {
            await Read(ctx, id, store, media, cookie, app.Logger, token);
        }).RequireRateLimiting(ReadPolicy).WithMetadata(new PrivateRead());
    }

    internal static void SetHidden(HttpResponse response)
    {
        response.StatusCode = StatusCodes.Status404NotFound;
        response.ContentLength = 0;
        response.ContentType = null;
        response.Headers.CacheControl = "private,no-store";
        response.Headers.Pragma = "no-cache";
        response.Headers.XContentTypeOptions = "nosniff";
    }

    private static async Task Read(HttpContext ctx, string id, Store store, MediaStore media, string cookie, ILogger logger,
        CancellationToken token)
    {
        SetHidden(ctx.Response);
        if (!Guid.TryParseExact(id, "D", out var asset) || asset == Guid.Empty || ctx.Request.Headers.ContainsKey("Range")) return;
        try
        {
            if (!ctx.Request.IsHttps && (ctx.Connection.RemoteIpAddress is not { } peer || !System.Net.IPAddress.IsLoopback(peer))) return;
            var result = await store.WithSession(ctx.Request.Cookies[cookie], true,
                (db, tx, actor) => media.Read(db, tx, actor.Id, asset, token), token);
            if (result is not { } image) return;
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.ContentType = MediaImage.ContentType(image.Record.Format);
            ctx.Response.ContentLength = image.Record.Length;
            if (!HttpMethods.IsHead(ctx.Request.Method)) await ctx.Response.Body.WriteAsync(image.Bytes, token);
        }
        catch (BusinessException error) when (error.Rejection is Rejection.Forbidden or Rejection.Unauthorized)
        {
            // Do not disclose the account, asset, or storage state to unauthorized readers.
        }
        catch (Exception error) when (!ctx.Response.HasStarted && error is (IOException or UnauthorizedAccessException or Npgsql.NpgsqlException))
        {
            logger.LogWarning(error, "Private media is unavailable for request {TraceId}.", ctx.TraceIdentifier);
            SetHidden(ctx.Response);
        }
    }

    private static PrivateMediaItem Contract(MediaRecord value) => new(value.Id, value.Name, (int)value.Format, value.Length,
        value.Width, value.Height, value.CreatedAt);

    private static MediaPosition? Position(HttpContext ctx)
    {
        var ticks = Only(ctx.Request.Query["before"], 19);
        var id = Only(ctx.Request.Query["beforeId"], 36);
        if (ticks is null && id is null) return null;
        if (!long.TryParse(ticks, NumberStyles.None, CultureInfo.InvariantCulture, out var time) ||
            time < DateTime.MinValue.Ticks || time > DateTime.MaxValue.Ticks)
            throw Invalid("Invalid media pagination cursor.");
        return new(new DateTimeOffset(time, TimeSpan.Zero), Key(id));
    }

    private static int RequireLength(HttpContext ctx)
    {
        if (ctx.Request.ContentLength is not long length)
            throw new BadHttpRequestException("Set Content-Length for private media.", StatusCodes.Status411LengthRequired);
        if (length is < 1 or > MediaImage.MaxBytes)
            throw new BadHttpRequestException("Image exceeds the supported size limit.", StatusCodes.Status413PayloadTooLarge);
        if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = MediaImage.MaxBytes;
        return checked((int)length);
    }

    private static string? Only(Microsoft.Extensions.Primitives.StringValues values, int max) => values.Count switch
    {
        0 => null,
        1 when values[0] is { } value && value.Length <= max => value,
        _ => throw Invalid("Invalid private media parameter.")
    };

    private static Guid Key(string? value) => Guid.TryParseExact(value, "D", out var key) && key != Guid.Empty
        ? key : throw Invalid("Invalid private media identifier.");
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
