using System.Net;
using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.V2.Server.Content;

internal static class PublishedMediaEndpoints
{
    internal const string StorageSetting = "FSUSBLOG_PUBLIC_MEDIA_ROOT";
    internal const string PathPrefix = "/public-media";
    private const string FilePolicy = "published-media-file";

    internal static bool Configure(WebApplicationBuilder builder, string webRoot)
    {
        var path = builder.Configuration[StorageSetting];
        if (string.IsNullOrEmpty(path)) return false;
        if (!Path.IsPathFullyQualified(path) || string.IsNullOrEmpty(builder.Configuration[MediaEndpoints.StorageSetting]))
            throw new InvalidOperationException("Published media requires a canonical public root and configured private media.");
        var appearance = builder.Configuration[AppearanceAssets.RootSetting];
        builder.Services.AddSingleton(services => new PublishedMediaStore(services.GetRequiredService<MediaFiles>(),
            path, webRoot, string.IsNullOrEmpty(appearance) ? [] : [appearance]));
        return true;
    }

    internal static void AddRateLimit(RateLimiterOptions options) =>
        options.AddPolicy(FilePolicy, context => RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress ?? IPAddress.None, _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 600,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));

    internal static void SetHeaders(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers.AcceptRanges = "none";
    }

    internal static void Map(WebApplication app, string cookie, Publications publications, PublishedMediaStore media,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapPost(WireRoutes.ArticlePublishImages, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeArticlePublishImages(await readFrame(ctx, ArticlePublishImages.MaxFrameBytes, ct));
            if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
                (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var key) || key != input.IdempotencyKey))
                throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
            var result = await publications.PublishWithImages(store, ctx.Request.Cookies[cookie], SiteSessions.Requested(ctx),
                media, input.ArticleId, input.ExpectedRevision, input.IdempotencyKey, input.AssetIds, ct);
            var saved = result.Article;
            return Results.Bytes(Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body,
                saved.PublishedRevision is not null)), Aeds.ContentType);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.PublicArticleMedia, (HttpContext ctx, int id, long publication) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
            var images = snapshot.PublishedImages(id, publication);
            if (images is null) return Results.NotFound();
            var frame = Wire.EncodePublicArticleMedia(new(id, publication, images));
            if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
            return Results.Bytes(frame, Aeds.ContentType);
        }).RequireRateLimiting("query");

        app.MapMethods(WireRoutes.PublicArticleMediaFile, [HttpMethods.Get, HttpMethods.Head],
            (HttpContext ctx, int id, long publication, string digest, CancellationToken ct) =>
                ReadImage(ctx, id, publication, digest, publications, media, app.Logger, ct))
            .RequireRateLimiting(FilePolicy);
    }

    private static async Task ReadImage(HttpContext ctx, int id, long publication, string digest,
        Publications publications, PublishedMediaStore media, ILogger log, CancellationToken ct)
    {
        if (!PublishedArticleImage.ValidDigest(digest) || id <= 0 || publication <= 0 ||
            !string.Equals(ctx.Request.Path.Value, PublishedMediaProjection.ImagePath(id, publication, digest), StringComparison.Ordinal) ||
            ctx.Request.QueryString.HasValue)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (ctx.Request.Headers.ContainsKey("Range"))
        {
            ctx.Response.StatusCode = StatusCodes.Status416RangeNotSatisfiable;
            return;
        }

        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        var images = snapshot.PublishedImages(id, publication);
        var image = images?.FirstOrDefault(entry => entry.Digest == digest);
        if (image is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        using var read = media.AdmitRead();
        if (!read.IsAcquired)
        {
            ctx.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            return;
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));
        byte[]? bytes;
        try { bytes = await media.ReadPublic(image, deadline.Token); }
        catch (IOException error)
        {
            log.LogWarning(error, "A current publication media object could not be verified.");
            bytes = null;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new PublicUnavailableException();
        }

        if (!ReferenceEquals(snapshot, publications.Snapshot)) throw new PublicUnavailableException();
        if (bytes is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        await PublicResponse.Write(ctx, bytes, MediaImage.ContentType((MediaFormat)image.Format));
    }
}
