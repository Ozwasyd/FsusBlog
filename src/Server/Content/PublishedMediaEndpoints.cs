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

    internal static bool Configure(WebApplicationBuilder builder, string webRoot,
        FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        var path = capabilities.PublicMediaRoot;
        if (string.IsNullOrEmpty(path)) return false;
        if (!Path.IsPathFullyQualified(path) || string.IsNullOrEmpty(capabilities.PrivateMediaRoot))
            throw new InvalidOperationException("Published media requires a canonical public root and configured private media.");
        var appearance = capabilities.AppearanceRoot;
        builder.Services.AddSingleton(services => new PublishedMediaStore(services.GetRequiredService<MediaFiles>(),
            path, webRoot, string.IsNullOrEmpty(appearance) ? [] : [appearance]));
        if (capabilities.TrustLoopbackProxy) builder.Services.AddSingleton<PublishedMediaProxy>();
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
            ClientMutationHeader.Require(ctx, input.IdempotencyKey);
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

        var proxy = app.Services.GetService<PublishedMediaProxy>();
        app.MapMethods(WireRoutes.PublicArticleMediaFile, [HttpMethods.Get, HttpMethods.Head],
            (HttpContext ctx, int id, long publication, string digest, CancellationToken ct) =>
                ReadImage(ctx, id, publication, digest, publications, media, proxy, app.Logger, ct))
            .RequireRateLimiting(FilePolicy);
    }

    private static async Task ReadImage(HttpContext ctx, int id, long publication, string digest,
        Publications publications, PublishedMediaStore media, PublishedMediaProxy? proxy, ILogger log, CancellationToken ct)
    {
        // Proxy mode reaches this handler only after validating the peer and forwarded client address.
        if (proxy is not null && !proxy.Admit(ctx)) return;
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
        var contentType = MediaImage.ContentType((MediaFormat)image.Format);
        if (proxy is null)
        {
            await PublicResponse.Write(ctx, bytes, contentType);
            return;
        }
        await PublishedMediaProxy.WriteImage(ctx, bytes, contentType,
            () => publications.Snapshot?.PublishedImages(id, publication)?.Contains(image) is true);
    }
}
