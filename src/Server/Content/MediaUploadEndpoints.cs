namespace FsusBlog.V2.Server.Content;

internal static class MediaUploadEndpoints
{
    internal const string Setting = "FSUSBLOG_PRIVATE_MEDIA_RESUMABLE";
    private const int DefaultPartSize = 512 * 1024;
    private const int MinPartSize = 64 * 1024;
    private const int MaxPartSize = 2 * 1024 * 1024;

    internal static void Map(WebApplication app, string cookie, SiteCapabilities capabilities)
    {
        if (!capabilities.PrivateMediaResumable) return;

        app.MapPost(WireRoutes.PrivateMediaUploadBegin, async (HttpContext ctx, Store store, InstanceLease lease, CancellationToken ct) =>
        {
            NoBody(ctx);
            var session = ctx.Request.Cookies[cookie];
            return await store.WithSession(session, true, async (db, tx, actor) =>
            {
                RequireCurrent(ctx, actor.Id, session);
                var name = Query(ctx, "name", 255) ?? throw Invalid("Set an image name.");
                var kind = MediaImage.FormatFor(name, Query(ctx, "type", 16) ?? "", lease.WebpMedia);
                var length = Number(Query(ctx, "length", 8), 1, MediaImage.MaxBytes);
                var partSize = Query(ctx, "partSize", 7) is { } size ? Number(size, MinPartSize, MaxPartSize) : DefaultPartSize;
                var key = MediaEndpoints.Key(MediaEndpoints.Only(ctx.Request.Headers[WireHeaders.ClientMutationId], 36));
                var uploader = new MediaUploadStore(db, tx, actor.Id);
                var upload = await uploader.Begin(new(key, name, kind, length, partSize, Digest(ctx)), ct);
                return State(upload, await uploader.Received(upload, ct));
            }, ct);
        }).RequireRateLimiting(MediaEndpoints.WritePolicy);

        app.MapGet(WireRoutes.PrivateMediaUploadStatus, async (string id, HttpContext ctx, Store store, CancellationToken ct) =>
            await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var uploader = new MediaUploadStore(db, tx, actor.Id);
                var upload = await uploader.Find(MediaEndpoints.Key(id), false, ct);
                return State(upload, await uploader.Received(upload, ct));
            }, ct)).RequireRateLimiting(MediaEndpoints.ReadPolicy);

        app.MapPost(WireRoutes.PrivateMediaUploadPart, (string id, int part, HttpContext ctx, Store store, CancellationToken ct) =>
            WithDeadline(async deadline =>
            {
                var session = ctx.Request.Cookies[cookie];
                var uploadId = MediaEndpoints.Key(id);
                int offset = Number(Query(ctx, "offset", 8), 0, MediaImage.MaxBytes - 1);
                int expected = await store.WithSession(session, true, async (db, tx, actor) =>
                {
                    RequireCurrent(ctx, actor.Id, session);
                    var upload = await new MediaUploadStore(db, tx, actor.Id).Find(uploadId, false, deadline);
                    if (upload.AssetId.HasValue) throw new BusinessException(Rejection.Conflict, "The private image is already reserved.");
                    return upload.PartLength(part, offset);
                }, deadline);
                var digest = Digest(ctx);
                var bytes = await ReadPart(ctx, expected, deadline);
                if (!MediaUploadStore.Same(SHA256.HashData(bytes), digest)) throw Invalid("The media part digest is incorrect.");
                return await store.WithSession(session, true, async (db, tx, actor) =>
                {
                    var uploader = new MediaUploadStore(db, tx, actor.Id);
                    var upload = await uploader.Find(uploadId, true, deadline);
                    await uploader.AddPart(upload, part, offset, digest, bytes, deadline);
                    return State(upload, await uploader.Received(upload, deadline));
                }, deadline);
            }, ct)).RequireRateLimiting(MediaEndpoints.WritePolicy);

        app.MapPost(WireRoutes.PrivateMediaUploadFinalize, (string id, HttpContext ctx, Store store, MediaStore media, CancellationToken ct) =>
            WithDeadline(async deadline =>
            {
                NoBody(ctx);
                var session = ctx.Request.Cookies[cookie];
                var uploadId = MediaEndpoints.Key(id);
                var source = await store.WithSession(session, true, async (db, tx, actor) =>
                {
                    RequireCurrent(ctx, actor.Id, session);
                    var uploader = new MediaUploadStore(db, tx, actor.Id);
                    var upload = await uploader.Find(uploadId, false, deadline);
                    return (upload, bytes: upload.Complete ? null : await uploader.Assemble(upload, deadline));
                }, deadline);

                // Parts are immutable. Cancel/expiry changes session identity before any later locked step.
                MediaImage? image = source.bytes is { } data ? MediaImage.Normalize(source.upload.Input.Name,
                    source.upload.Input.Format, data, deadline) : null;
                if (image is not null && source.upload.AssetId is null)
                    await store.WithSession(session, true, async (db, tx, actor) =>
                    {
                        var uploader = new MediaUploadStore(db, tx, actor.Id);
                        var upload = await uploader.Find(uploadId, true, deadline);
                        if (upload.AssetId is null)
                        {
                            var asset = await media.Reserve(db, tx, actor.Id, upload.Id, image, deadline);
                            await uploader.Reserve(upload, asset, deadline);
                        }
                        return true;
                    }, deadline);

                var record = await store.WithSession(session, true, async (db, tx, actor) =>
                {
                    var uploader = new MediaUploadStore(db, tx, actor.Id);
                    var upload = await uploader.Find(uploadId, true, deadline);
                    if (upload.AssetId is not { } asset) throw new InvalidOperationException("Private upload has no reserved asset.");
                    if (upload.Complete) return await media.VerifyReady(db, tx, actor.Id, asset, deadline);
                    if (image is null) throw new InvalidOperationException("Private upload bytes were not captured.");
                    var ready = await media.Activate(db, tx, actor.Id, asset, image, deadline);
                    await uploader.Finish(upload, deadline);
                    return ready;
                }, deadline);
                return ServerHttp.Frame(Wire.EncodePrivateMedia([MediaEndpoints.Contract(record)]));
            }, ct)).RequireRateLimiting(MediaEndpoints.WritePolicy);

        app.MapPost(WireRoutes.PrivateMediaUploadCancel, async (string id, HttpContext ctx, Store store, MediaStore media, CancellationToken ct) =>
        {
            NoBody(ctx);
            var session = ctx.Request.Cookies[cookie];
            return await store.WithSession(session, true, async (db, tx, actor) =>
            {
                RequireCurrent(ctx, actor.Id, session);
                var uploader = new MediaUploadStore(db, tx, actor.Id);
                var upload = await uploader.Find(MediaEndpoints.Key(id), true, ct);
                if (upload.Complete) throw new BusinessException(Rejection.Conflict, "Private upload already has a private asset.");
                if (upload.AssetId is { } asset)
                {
                    await media.Tombstone(db, tx, actor.Id, asset, ct);
                    await media.FinishRemoval(db, tx, actor.Id, asset, ct);
                }
                await uploader.Cancel(upload, ct);
                return ServerHttp.EmptyFrame();
            }, ct);
        }).RequireRateLimiting(MediaEndpoints.WritePolicy);
    }

    private static IResult State(MediaUpload upload, List<int> received) => ServerHttp.Frame(Wire.EncodePrivateMediaUpload(
        upload.Id, upload.Input.Length, upload.Input.PartSize, upload.ExpiresAt.ToUnixTimeMilliseconds(), upload.AssetId.HasValue,
        upload.Complete ? upload.AssetId : null, received));

    private static async Task<IResult> WithDeadline(Func<CancellationToken, Task<IResult>> operation, CancellationToken client)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(client);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        try { return await operation(deadline.Token); }
        catch (OperationCanceledException) when (!client.IsCancellationRequested)
        {
            throw new BadHttpRequestException("The private media upload exceeded its deadline.", StatusCodes.Status408RequestTimeout);
        }
    }

    private static void NoBody(HttpContext ctx)
    {
        if (ctx.Features.Get<IHttpRequestBodyDetectionFeature>() is { CanHaveBody: true }) throw Invalid("This operation does not accept a body.");
    }

    private static async Task<byte[]> ReadPart(HttpContext ctx, int expected, CancellationToken ct)
    {
        if (ctx.Request.ContentType != Aeds.ContentType)
            throw new BadHttpRequestException("Expected an octet-stream media segment.", StatusCodes.Status415UnsupportedMediaType);
        if (ctx.Request.ContentLength is not long length)
            throw new BadHttpRequestException("Set Content-Length for the media part.", StatusCodes.Status411LengthRequired);
        if (length != expected) throw Invalid("Invalid media part length.");
        if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = expected;
        var bytes = new byte[expected];
        try { await ctx.Request.Body.ReadExactlyAsync(bytes, ct); }
        catch (EndOfStreamException) { throw Invalid("Media part ended early."); }
        return bytes;
    }

    private static byte[] Digest(HttpContext ctx)
    {
        var hash = MediaEndpoints.Only(ctx.Request.Headers[WireHeaders.PrivateMediaDigest], 64);
        return hash is { Length: 64 } && hash.All(char.IsAsciiHexDigit)
            ? Convert.FromHexString(hash) : throw Invalid("Set the SHA-256 digest for this upload operation.");
    }

    private static string? Query(HttpContext ctx, string name, int length) => MediaEndpoints.Only(ctx.Request.Query[name], length);
    private static void RequireCurrent(HttpContext ctx, Guid account, string? session) => SiteSessions.RequireCurrent(account,
        Store.TokenDigest(session)!, MediaEndpoints.Only(ctx.Request.Headers[WireHeaders.CurrentSession], WireLimits.SiteSessionIdBytes));
    private static int Number(string? input, int min, int max) =>
        int.TryParse(input, NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number >= min && number <= max
            ? number : throw Invalid("Invalid media upload numeric parameter.");
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}
