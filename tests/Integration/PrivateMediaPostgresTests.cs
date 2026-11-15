using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PrivateMediaPostgresTests
{
    [PostgresFact]
    public async Task NativeImagesRequireAnAuthorAndTheirFilesStayPrivateThroughDeletion()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var primary = await Author(db.DataSource, "media-owner", true, ct);
        var another = await Author(db.DataSource, "media-outsider", true, ct);
        var reader = await Author(db.DataSource, "media-reader", false, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-test-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        // macOS redirects /var to /private/var. Use our owned canonical path.
        var storage = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        try
        {
            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage, [MediaUploadEndpoints.Setting] = "false" });
            var png = EncodeImage(SKEncodedImageFormat.Png);
            var jpeg = EncodeImage(SKEncodedImageFormat.Jpeg);
            var command = Guid.NewGuid();
            using var unsupported = await Upload(server.Client, primary, command, "sample.svg", "image/svg+xml", "<svg/>"u8.ToArray(), ct);
            Assert.Equal(HttpStatusCode.UnsupportedMediaType, unsupported.StatusCode);
            using var webpBeforeUpgrade = await Upload(server.Client, primary, command, "sample.webp", "image/webp",
                EncodeImage(SKEncodedImageFormat.Webp), ct);
            Assert.Equal(HttpStatusCode.UnsupportedMediaType, webpBeforeUpgrade.StatusCode);
            using var wrongType = await Upload(server.Client, primary, command, "sample.png", "image/png", jpeg, ct);
            Assert.Equal(HttpStatusCode.BadRequest, wrongType.StatusCode);
            using var truncated = await Upload(server.Client, primary, command, "sample.png", "image/png", png[..24], ct);
            Assert.Equal(HttpStatusCode.BadRequest, truncated.StatusCode);
            using var unable = await Upload(server.Client, reader, command, "sample.png", "image/png", png, ct);
            Assert.Equal(HttpStatusCode.Forbidden, unable.StatusCode);
            Assert.Empty(directory.EnumerateFiles());

            // Trailing payload/metadata is removed by rendering decoded pixels into a new PNG.
            byte[] source = [.. png, .. "private marker"u8.ToArray()];
            using var created = await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct);
            Assert.Equal(HttpStatusCode.OK, created.StatusCode);
            var asset = First(await created.Content.ReadAsByteArrayAsync(ct), 1);
            using var replay = await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct);
            Assert.Equal(asset, First(await replay.Content.ReadAsByteArrayAsync(ct), 1));
            using var collision = await Upload(server.Client, primary, command, "another.png", "image/png", source, ct);
            Assert.Equal(HttpStatusCode.Conflict, collision.StatusCode);

            using var list = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, primary, ct);
            Assert.Equal(asset, First(await list.Content.ReadAsByteArrayAsync(ct), 1));
            Assert.False(list.Headers.Contains(WireHeaders.PrivateMediaResumable));
            Assert.False(list.Headers.Contains(WireHeaders.PrivateMediaWebp));
            using var otherList = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, another, ct);
            Assert.Equal(Guid.Empty, First(await otherList.Content.ReadAsByteArrayAsync(ct), 0));

            var raw = WireRoutes.PrivateMediaRead.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
            await AssertHidden(server.Client, HttpMethod.Get, raw, null, ct);
            await AssertHidden(server.Client, HttpMethod.Get, raw, another, ct);
            await AssertHidden(server.Client, HttpMethod.Head, raw, reader, ct);
            await AssertHidden(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaRead.Replace("{id}", Guid.NewGuid().ToString("D"), StringComparison.Ordinal), primary, ct);
            await AssertHidden(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaRead.Replace("{id}", "missing", StringComparison.Ordinal), primary, ct);
            using var content = await Send(server.Client, HttpMethod.Get, raw, primary, ct);
            Assert.Equal(HttpStatusCode.OK, content.StatusCode);
            Assert.Equal("image/png", content.Content.Headers.ContentType?.MediaType);
            byte[] canonical = await content.Content.ReadAsByteArrayAsync(ct);
            Assert.True(canonical.AsSpan().IndexOf("private marker"u8) < 0);
            using var bitmap = SKBitmap.Decode(canonical);
            Assert.Equal((3, 2), (bitmap.Width, bitmap.Height));
            using var head = await Send(server.Client, HttpMethod.Head, raw, primary, ct);
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
            Assert.Equal(canonical.Length, head.Content.Headers.ContentLength);
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

            var leaf = Assert.Single(directory.EnumerateFiles());
            Assert.Equal($"{asset:N}.media", leaf.Name);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(leaf.FullName));
            var remove = WireRoutes.PrivateMediaRemove.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
            using var foreignRemove = await Send(server.Client, HttpMethod.Post, remove, another, ct);
            Assert.Equal(HttpStatusCode.NotFound, foreignRemove.StatusCode);
            using var removed = await Send(server.Client, HttpMethod.Post, remove, primary, ct);
            Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
            using var repeat = await Send(server.Client, HttpMethod.Post, remove, primary, ct);
            Assert.Equal(HttpStatusCode.OK, repeat.StatusCode);
            await AssertHidden(server.Client, HttpMethod.Get, raw, primary, ct);
            Assert.Empty(directory.EnumerateFiles());

            using var jpegUpload = await Upload(server.Client, primary, Guid.NewGuid(), "sample.jpeg", "image/jpeg", jpeg, ct);
            Assert.Equal(HttpStatusCode.OK, jpegUpload.StatusCode);
            var jpegId = First(await jpegUpload.Content.ReadAsByteArrayAsync(ct), 1);
            var jpegPath = WireRoutes.PrivateMediaRead.Replace("{id}", jpegId.ToString("D"), StringComparison.Ordinal);
            using var jpegContent = await Send(server.Client, HttpMethod.Get, jpegPath, primary, ct);
            Assert.Equal(HttpStatusCode.OK, jpegContent.StatusCode);
            Assert.Equal("image/jpeg", jpegContent.Content.Headers.ContentType?.MediaType);
            using var jpegBitmap = SKBitmap.Decode(await jpegContent.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((3, 2), (jpegBitmap.Width, jpegBitmap.Height));
        }
        finally { directory.Delete(recursive: true); }
    }

    [PostgresFact]
    public async Task CoherentWebpSchemaAdmitsStaticNativeBytesAndResumableReadsOnlyForTheOwner()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        {
            Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
            await using (var first = db.DataSource.CreateCommand("""
                alter table public.private_media drop constraint private_media_format_check,
                  add constraint private_media_format_check check (format between 1 and 3)
                """)) await first.ExecuteNonQueryAsync(ct);
            await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
            await using (var rest = db.DataSource.CreateCommand("""
                alter table public.private_media_upload drop constraint private_media_upload_format_check,
                  add constraint private_media_upload_format_check check (format between 1 and 3);
                alter table public.article_publication_media drop constraint article_publication_media_format_check,
                  add constraint article_publication_media_format_check check (format between 1 and 3)
                """)) await rest.ExecuteNonQueryAsync(ct);
            Assert.True(await CurrentSchema.VerifyAsync(connection, ct));
        }

        var owner = await Author(db.DataSource, "webp-owner", true, ct);
        var other = await Author(db.DataSource, "webp-other", true, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-webp-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var root = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root, [MediaUploadEndpoints.Setting] = "true" };
        var key = Guid.NewGuid();
        const int partSize = 65536;
        var image = EncodeImage(SKEncodedImageFormat.Webp, 320, 320);
        Assert.InRange(image.Length, partSize + 1, partSize * 2);
        Guid upload;
        try
        {
            await using (var server = await ServerProcess.Start(db.ConnectionString, ct, settings))
            {
                using var list = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct);
                Assert.Equal("1", Assert.Single(list.Headers.GetValues(WireHeaders.PrivateMediaWebp)));
                var animated = AnimateOnce(EncodeImage(SKEncodedImageFormat.Webp));
                using var codec = SKCodec.Create(new MemoryStream(animated));
                Assert.NotNull(codec);
                Assert.Equal(1, codec.FrameCount);
                foreach (var invalid in new[] { animated, image[..^1], EncodeImage(SKEncodedImageFormat.Png) })
                {
                    using var rejected = await Upload(server.Client, owner, Guid.NewGuid(), "invalid.webp", "image/webp", invalid, ct);
                    Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
                }
                using var unknown = await Upload(server.Client, owner, Guid.NewGuid(), "missing.png", "image/webp", image, ct);
                Assert.Equal(HttpStatusCode.UnsupportedMediaType, unknown.StatusCode);
                Assert.Empty(directory.EnumerateFiles());
                using var animatedUpload = await Begin(server.Client, owner, Guid.NewGuid(), "animated.webp", animated, ct, type: "image/webp");
                var rejectedUpload = await State(animatedUpload, [], ct);
                using var animatedPart = await Part(server.Client, owner, rejectedUpload, 0, 0, animated, ct);
                Assert.Equal(rejectedUpload, await State(animatedPart, [0], ct));
                using var rejectedFinalize = await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, rejectedUpload), owner, ct);
                Assert.Equal(HttpStatusCode.BadRequest, rejectedFinalize.StatusCode);
                using var cancelled = await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadCancel, rejectedUpload), owner, ct);
                Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
                Assert.Empty(directory.EnumerateFiles());
                using var started = await Begin(server.Client, owner, key, "resumable.webp", image, ct, type: "image/webp");
                upload = await State(started, [], ct);
                using var one = await Part(server.Client, owner, upload, 0, 0, image[..partSize], ct);
                Assert.Equal(upload, await State(one, [0], ct));
            }

            await using var restarted = await ServerProcess.Start(db.ConnectionString, ct, settings);
            using var retry = await Begin(restarted.Client, owner, key, "resumable.webp", image, ct, type: "image/webp");
            Assert.Equal(upload, await State(retry, [0], ct));
            using var two = await Part(restarted.Client, owner, upload, 1, partSize, image[partSize..], ct);
            Assert.Equal(upload, await State(two, [0, 1], ct));
            using var completed = await Send(restarted.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, upload), owner, ct);
            Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
            var frame = await completed.Content.ReadAsByteArrayAsync(ct);
            var asset = First(frame, 1);
            Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(frame, FrameType.PrivateMediaItems)[25..]));
            var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
            await AssertHidden(restarted.Client, HttpMethod.Get, raw, other, ct);
            await AssertHidden(restarted.Client, HttpMethod.Head, raw, null, ct);
            using var allowed = await Send(restarted.Client, HttpMethod.Get, raw, owner, ct);
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
            Assert.Equal("image/webp", allowed.Content.Headers.ContentType?.MediaType);
            var canonical = await allowed.Content.ReadAsByteArrayAsync(ct);
            Assert.True(PublishedArticleImage.MatchesFormat(canonical, 3));
            using var native = SKBitmap.Decode(canonical);
            Assert.Equal((320, 320), (native.Width, native.Height));
            Assert.Equal(0, native.GetPixel(0, 0).Alpha);
            using var deleted = await Send(restarted.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct);
            Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
            Assert.Empty(directory.EnumerateFiles());
        }
        finally { directory.Delete(recursive: true); }
    }

    [PostgresFact]
    public async Task DraftAttachmentsPinPrivateImagesAndTicketsRequireCurrentRevisionAndSession()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await Author(db.DataSource, "attachment-owner", true, ct);
        var outsider = await Author(db.DataSource, "attachment-other", true, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-attach-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var root = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        try
        {
            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root });
            var client = server.Client;
            var png = EncodeImage(SKEncodedImageFormat.Png);
            using var upload = await Upload(client, owner, Guid.NewGuid(), "draft.png", "image/png", png, ct);
            var asset = First(await upload.Content.ReadAsByteArrayAsync(ct), 1);
            using var elsewhere = await Upload(client, outsider, Guid.NewGuid(), "foreign.png", "image/png", png, ct);
            var foreign = First(await elsewhere.Content.ReadAsByteArrayAsync(ct), 1);
            using var create = await Command(WireRoutes.Save, owner, Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Attachments", "Original body.")));
            Assert.Equal(HttpStatusCode.OK, create.StatusCode);
            var draft = Wire.DecodeDraft(await create.Content.ReadAsByteArrayAsync(ct));
            var input = new ArticleMediaCommand(draft.Id, draft.Revision, Guid.NewGuid(), asset, true);
            using var crossAsset = await Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input with { AssetId = foreign }));
            Assert.Equal(HttpStatusCode.NotFound, crossAsset.StatusCode);
            using var unauthorized = await Command(WireRoutes.ArticleMediaCommand, outsider, Wire.EncodeArticleMediaCommand(input));
            Assert.Equal(HttpStatusCode.NotFound, unauthorized.StatusCode);
            using var attach = await Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input));
            Assert.Equal(HttpStatusCode.OK, attach.StatusCode);
            var saved = Wire.DecodeDraft(await attach.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(draft.Revision + 1, saved.Revision);
            Assert.Equal(draft.Body, saved.Body);
            using var repeated = await Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input));
            Assert.Equal(saved, Wire.DecodeDraft(await repeated.Content.ReadAsByteArrayAsync(ct)));
            var ticket = await Preview(saved.Revision);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, null, ct, ticket);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, outsider, ct, ticket);
            await AssertHidden(client, HttpMethod.Head, WireRoutes.ArticleMediaPreview, owner, ct,
                ticket[..^2] + (ticket[^2] == 'b' ? 'A' : 'b') + ticket[^1]);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview + "?extra=unexpected", owner, ct, ticket);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket, range: true);
            using var allowed = await Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket);
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
            Assert.True(allowed.Headers.CacheControl?.NoStore);
            Assert.Equal("image/png", allowed.Content.Headers.ContentType?.MediaType);
            Assert.Equal("no-referrer", Assert.Single(allowed.Headers.GetValues("Referrer-Policy")));
            var leaf = Path.Combine(root, $"{asset:N}.media");
            Assert.Equal(await File.ReadAllBytesAsync(leaf, ct), await allowed.Content.ReadAsByteArrayAsync(ct));

            var held = leaf + ".held";
            File.Move(leaf, held);
            try { await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket); }
            finally { File.Move(held, leaf); }
            await AssertSaturatedPreviewIsHidden(ticket);

            using var cannotRemove = await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct);
            Assert.Equal(HttpStatusCode.Conflict, cannotRemove.StatusCode);
            using var detach = await Command(WireRoutes.ArticleMediaCommand, owner,
                Wire.EncodeArticleMediaCommand(input with { ExpectedRevision = saved.Revision, IdempotencyKey = Guid.NewGuid(), Attach = false }));
            Assert.Equal(HttpStatusCode.OK, detach.StatusCode);
            var detached = Wire.DecodeDraft(await detach.Content.ReadAsByteArrayAsync(ct));
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket);
            using var historyStillPins = await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct);
            Assert.Equal(HttpStatusCode.Conflict, historyStillPins.StatusCode);
            using var restore = await Command(WireRoutes.DraftRollback,
                owner, Wire.EncodeDraftRollback(new(draft.Id, detached.Revision, saved.Revision, Guid.NewGuid(), "Restore the attached revision")));
            Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
            var restored = Wire.DecodeDraft(await restore.Content.ReadAsByteArrayAsync(ct));
            using var restoredBytes = await Send(client, HttpMethod.Head, WireRoutes.ArticleMediaPreview, owner, ct, await Preview(restored.Revision));
            Assert.Equal(HttpStatusCode.OK, restoredBytes.StatusCode);
            using var published = await Command(WireRoutes.Publish, owner,
                Wire.EncodeArticleCommand(new(draft.Id, restored.Revision, Guid.NewGuid(), "", "")));
            Assert.Equal(HttpStatusCode.OK, published.StatusCode);
            var publishedDraft = Wire.DecodeDraft(await published.Content.ReadAsByteArrayAsync(ct));
            var publicCandidateTicket = await Preview(publishedDraft.Revision);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, null, ct, publicCandidateTicket);
            using var html = await client.GetAsync($"/article/{draft.Id}", ct);
            Assert.Equal(HttpStatusCode.OK, html.StatusCode);
            Assert.DoesNotContain("draft-preview", await html.Content.ReadAsStringAsync(ct));
            await using var pin = db.DataSource.CreateCommand("SELECT count(*) FROM public.article_revision_media WHERE asset_id=$1");
            pin.Parameters.AddWithValue(asset);
            Assert.Equal(3L, await pin.ExecuteScalarAsync(ct));

            async Task<HttpResponseMessage> Command(string path, SessionFixture actor, byte[] bytes)
            {
                using var request = Request(HttpMethod.Post, path, actor);
                request.Content = new ByteArrayContent(bytes);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
                return await client.SendAsync(request, ct);
            }

            async Task<string> Preview(long revision)
            {
                var path = WireRoutes.ArticleMedia.Replace("{id:int}", $"{draft.Id}", StringComparison.Ordinal);
                using var response = await Send(client, HttpMethod.Get, $"{path}?revision={revision}", owner, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                var payload = Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), FrameType.ArticleMedia);
                Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(payload[12..]));
                Assert.Equal(asset, new Guid(payload[16..32], bigEndian: true));
                Assert.Equal(91, BinaryPrimitives.ReadInt32LittleEndian(payload[32..]));
                return System.Text.Encoding.UTF8.GetString(payload[36..]);
            }

            async Task AssertSaturatedPreviewIsHidden(string validTicket)
            {
                await using var blocker = await db.DataSource.OpenConnectionAsync(ct);
                await using var heldRow = await blocker.BeginTransactionAsync(ct);
                await using var acquire = new NpgsqlCommand("select id from public.private_media where id=$1 for update", blocker, heldRow);
                acquire.Parameters.AddWithValue(asset);
                Assert.Equal(asset, Assert.IsType<Guid>(await acquire.ExecuteScalarAsync(ct)));

                // These real GETs wait for the asset lock after authorization and hold all four read permits.
                var reads = Enumerable.Range(0, 4).Select(async _ =>
                {
                    using var delivered = await Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, validTicket);
                    return delivered.StatusCode;
                }).ToArray();
                HttpStatusCode[] completed;
                try
                {
                    using var probe = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    probe.CancelAfter(TimeSpan.FromSeconds(10));
                    await using var observe = db.DataSource.CreateCommand("""
                        select count(*) from pg_catalog.pg_stat_activity
                        where datname=current_database() and wait_event_type='Lock'
                          and query like '%FROM public.private_media WHERE owner_id=%FOR SHARE'
                        """);
                    while ((long)(await observe.ExecuteScalarAsync(probe.Token))! != reads.Length)
                        await Task.Delay(25, probe.Token);
                    await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, probe.Token, validTicket);
                }
                finally
                {
                    await heldRow.RollbackAsync(CancellationToken.None);
                    completed = await Task.WhenAll(reads);
                }
                Assert.All(completed, status => Assert.Equal(HttpStatusCode.OK, status));
            }
        }
        finally { directory.Delete(recursive: true); }
    }

    [PostgresFact]
    public async Task ResumablePartsPersistAcrossRestartAndFinalizeOnlyVerifiedPrivateBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await Author(db.DataSource, "resume-owner", true, ct);
        var foreign = await Author(db.DataSource, "resume-other", true, ct);
        var reader = await Author(db.DataSource, "resume-reader", false, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-parts-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var root = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root, [MediaUploadEndpoints.Setting] = "true" };
        const int partSize = 65536;
        var png = EncodeImage(SKEncodedImageFormat.Png);
        var image = new byte[partSize + 19];
        png.CopyTo(image, 0);
        var key = Guid.NewGuid();
        Guid upload;
        try
        {
            await using (var server = await ServerProcess.Start(db.ConnectionString, ct, settings))
            {
                using var auth = await Begin(server.Client, reader, key, "resumable.png", image, ct);
                Assert.Equal(HttpStatusCode.Forbidden, auth.StatusCode);
                using var advertised = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct);
                Assert.Equal("1", Assert.Single(advertised.Headers.GetValues(WireHeaders.PrivateMediaResumable)));
                using var webpBeforeUpgrade = await Begin(server.Client, owner, key, "resumable.webp",
                    EncodeImage(SKEncodedImageFormat.Webp), ct, type: "image/webp");
                Assert.Equal(HttpStatusCode.UnsupportedMediaType, webpBeforeUpgrade.StatusCode);
                using var stale = await Begin(server.Client, foreign, key, "resumable.png", image, ct, owner);
                Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
                using var created = await Begin(server.Client, owner, key, "resumable.png", image, ct);
                upload = await State(created, [], ct);
                using var conflict = await Begin(server.Client, owner, key, "changed.png", image, ct);
                Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
                using var hidden = await Send(server.Client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), foreign, ct);
                Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
                using var wrongOffset = await Part(server.Client, owner, upload, 1, 0, image[partSize..], ct);
                Assert.Equal(HttpStatusCode.BadRequest, wrongOffset.StatusCode);
                using var wrongDigest = await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct, new byte[32]);
                Assert.Equal(HttpStatusCode.BadRequest, wrongDigest.StatusCode);
                using var valid = await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct);
                Assert.Equal(upload, await State(valid, [1], ct));
                using var retry = await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct);
                Assert.Equal(upload, await State(retry, [1], ct));
                using var conflictPart = await Part(server.Client, owner, upload, 1, partSize, Enumerable.Repeat((byte)9, 19).ToArray(), ct);
                Assert.Equal(HttpStatusCode.Conflict, conflictPart.StatusCode);
                using var incomplete = await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, upload), owner, ct);
                Assert.Equal(HttpStatusCode.Conflict, incomplete.StatusCode);
                Assert.Empty(directory.EnumerateFiles());
            }

            await using var resumedServer = await ServerProcess.Start(db.ConnectionString, ct, settings);
            var client = resumedServer.Client;
            using var repeatedBegin = await Begin(client, owner, key, "resumable.png", image, ct);
            Assert.Equal(upload, await State(repeatedBegin, [1], ct));
            using var finalPart = await Part(client, owner, upload, 0, 0, image[..partSize], ct);
            Assert.Equal(upload, await State(finalPart, [0, 1], ct));
            var finalize = PathFor(WireRoutes.PrivateMediaUploadFinalize, upload);
            using var wrongOwner = await Send(client, HttpMethod.Post, finalize, foreign, ct);
            Assert.Equal(HttpStatusCode.NotFound, wrongOwner.StatusCode);
            var approvals = await Task.WhenAll(
                Send(client, HttpMethod.Post, finalize, owner, ct),
                Send(client, HttpMethod.Post, finalize, owner, ct));
            using var committed = approvals[0];
            using var simultaneous = approvals[1];
            Assert.Equal(HttpStatusCode.OK, committed.StatusCode);
            var asset = First(await committed.Content.ReadAsByteArrayAsync(ct), 1);
            Assert.Equal(HttpStatusCode.OK, simultaneous.StatusCode);
            Assert.Equal(asset, First(await simultaneous.Content.ReadAsByteArrayAsync(ct), 1));
            using var retryFinalize = await Send(client, HttpMethod.Post, finalize, owner, ct);
            Assert.Equal(HttpStatusCode.OK, retryFinalize.StatusCode);
            Assert.Equal(asset, First(await retryFinalize.Content.ReadAsByteArrayAsync(ct), 1));
            using var completed = await Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), owner, ct);
            Assert.Equal(upload, await State(completed, [], ct, asset));
            var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
            await AssertHidden(client, HttpMethod.Get, raw, foreign, ct);
            using var read = await Send(client, HttpMethod.Get, raw, owner, ct);
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
            using var decoded = SKBitmap.Decode(await read.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((3, 2), (decoded.Width, decoded.Height));
            var leaf = Assert.Single(directory.EnumerateFiles());
            Assert.Equal($"{asset:N}.media", leaf.Name);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(leaf.FullName));

            var different = image.ToArray();
            different[^1] = 5;
            using var second = await Begin(client, owner, Guid.NewGuid(), "digest.png", different, ct);
            var other = await State(second, [], ct);
            using var a = await Part(client, owner, other, 0, 0, image[..partSize], ct);
            using var b = await Part(client, owner, other, 1, partSize, image[partSize..], ct);
            Assert.Equal(HttpStatusCode.OK, a.StatusCode);
            Assert.Equal(HttpStatusCode.OK, b.StatusCode);
            using var mismatch = await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, other), owner, ct);
            Assert.Equal(HttpStatusCode.Conflict, mismatch.StatusCode);
            using var remove = await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadCancel, other), owner, ct);
            Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
            await using var check = db.DataSource.CreateCommand("SELECT count(*) FROM public.private_media_upload_part");
            Assert.Equal(0L, await check.ExecuteScalarAsync(ct));

            List<Guid> held = [];
            for (var i = 0; i < 4; i++)
            {
                using var staged = await Begin(client, owner, Guid.NewGuid(), "staged.png", image, ct);
                held.Add(await State(staged, [], ct));
            }
            using var overBudget = await Begin(client, owner, Guid.NewGuid(), "held.png", image, ct);
            Assert.Equal(HttpStatusCode.Conflict, overBudget.StatusCode);
            using var willExpire = await Part(client, owner, held[0], 1, partSize, image[partSize..], ct);
            Assert.Equal(held[0], await State(willExpire, [1], ct));
            await using (var expire = db.DataSource.CreateCommand("UPDATE public.private_media_upload SET expires_at=now()-interval '1 second' WHERE id=$1"))
            {
                expire.Parameters.AddWithValue(held[0]);
                Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));
            }
            using var replacement = await Begin(client, owner, Guid.NewGuid(), "replacement.png", image, ct);
            Assert.NotEqual(held[0], await State(replacement, [], ct));
            using var expired = await Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, held[0]), owner, ct);
            Assert.Equal(HttpStatusCode.NotFound, expired.StatusCode);
            Assert.Equal(0L, await check.ExecuteScalarAsync(ct));
            Assert.Single(directory.EnumerateFiles());
        }
        finally { directory.Delete(recursive: true); }
    }

    [PostgresFact]
    public async Task PendingUploadCanResumeAndDeletionRefusesUnownedFileBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await Author(db.DataSource, "media-owner", true, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-recovery-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var storage = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        try
        {
            var png = EncodeImage(SKEncodedImageFormat.Png);
            var command = Guid.NewGuid();
            Guid reserved;
            using (var files = new MediaFiles(storage, AppContext.BaseDirectory))
            {
                var media = new MediaStore(files);
                var image = await MediaImage.ReadAsync(new MemoryStream(png), png.Length, "pending.png", MediaFormat.Png, ct);
                await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
                await using (var transaction = await connection.BeginTransactionAsync(ct))
                {
                    reserved = await media.Reserve(connection, transaction, owner.Id, command, image, ct);
                    await transaction.CommitAsync(ct);
                }
                // Model a process interrupted after the immutable path exists but before the DB made it readable.
                await files.Materialize(reserved, image, ct);
            }

            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage });
            var raw = WireRoutes.PrivateMediaRead.Replace("{id}", reserved.ToString("D"), StringComparison.Ordinal);
            await AssertHidden(server.Client, HttpMethod.Head, raw, owner, ct);
            using var resumed = await Upload(server.Client, owner, command, "pending.png", "image/png", png, ct);
            Assert.Equal(reserved, First(await resumed.Content.ReadAsByteArrayAsync(ct), 1));

            var leaf = Assert.Single(directory.EnumerateFiles());
            var original = await File.ReadAllBytesAsync(leaf.FullName, ct);
            var unrelated = new byte[original.Length];
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await File.WriteAllBytesAsync(leaf.FullName, unrelated, ct);
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead);
            await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);
            var remove = WireRoutes.PrivateMediaRemove.Replace("{id}", reserved.ToString("D"), StringComparison.Ordinal);
            using var blocked = await Send(server.Client, HttpMethod.Post, remove, owner, ct);
            Assert.Equal(HttpStatusCode.InternalServerError, blocked.StatusCode);
            Assert.Equal(unrelated, await File.ReadAllBytesAsync(leaf.FullName, ct));
            await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);

            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await File.WriteAllBytesAsync(leaf.FullName, original, ct);
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead);
            using var retry = await Send(server.Client, HttpMethod.Post, remove, owner, ct);
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
            Assert.Empty(directory.EnumerateFiles());
        }
        finally { directory.Delete(recursive: true); }
    }

    private static byte[] EncodeImage(SKEncodedImageFormat format, int width = 3, int height = 2)
    {
        using var image = new SKBitmap(width, height);
        if (width == 3 && height == 2) image.Erase(SKColors.SteelBlue);
        else
        {
            var random = new Random(233);
            for (var y = 0; y < height; y++)
                for (var x = 0; x < width; x++)
                    image.SetPixel(x, y, new SKColor((uint)random.Next(1 << 24) | 0xff000000));
            image.SetPixel(0, 0, SKColors.Transparent);
        }
        using var encoded = image.Encode(format, 90);
        return encoded.ToArray();
    }

    private static byte[] AnimateOnce(byte[] still)
    {
        using var file = new MemoryStream();
        using var writer = new BinaryWriter(file);
        writer.Write("RIFF"u8);
        writer.Write(0);
        writer.Write("WEBP"u8);
        writer.Write("VP8X"u8);
        writer.Write(10);
        writer.Write(new byte[] { 2, 0, 0, 0, 2, 0, 0, 1, 0, 0 });
        writer.Write("ANIM"u8);
        writer.Write(6);
        writer.Write(new byte[6]);
        writer.Write("ANMF"u8);
        writer.Write(16 + still.Length - 12);
        writer.Write(new byte[] { 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 100, 0, 0, 0 });
        writer.Write(still.AsSpan(12));
        var bytes = file.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4), bytes.Length - 8);
        return bytes;
    }

    private static string PathFor(string route, Guid id) => route.Replace("{id}", id.ToString("D"), StringComparison.Ordinal);

    private static async Task<HttpResponseMessage> Begin(HttpClient client, SessionFixture actor, Guid key, string name, byte[] image,
        CancellationToken ct, SessionFixture? expected = null, string type = "image/png")
    {
        using var request = Request(HttpMethod.Post,
            $"{WireRoutes.PrivateMediaUploadBegin}?name={Uri.EscapeDataString(name)}&type={Uri.EscapeDataString(type)}&length={image.Length}&partSize=65536", actor);
        request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
        if (expected is not null)
        {
            request.Headers.Remove(WireHeaders.CurrentSession);
            request.Headers.Add(WireHeaders.CurrentSession, expected.SiteSessionId);
        }
        request.Headers.Add(WireHeaders.PrivateMediaDigest, Convert.ToHexString(SHA256.HashData(image)));
        return await client.SendAsync(request, ct);
    }

    private static async Task<HttpResponseMessage> Part(HttpClient client, SessionFixture actor, Guid id, int part, int offset,
        byte[] bytes, CancellationToken ct, byte[]? wrongHash = null)
    {
        var path = PathFor(WireRoutes.PrivateMediaUploadPart, id).Replace("{part:int}", $"{part}", StringComparison.Ordinal);
        using var request = Request(HttpMethod.Post, $"{path}?offset={offset}", actor);
        request.Headers.Add(WireHeaders.PrivateMediaDigest, Convert.ToHexString(wrongHash ?? SHA256.HashData(bytes)));
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new(Aeds.ContentType);
        return await client.SendAsync(request, ct);
    }

    private static async Task<Guid> State(HttpResponseMessage response, int[] parts, CancellationToken ct, Guid? completed = null)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var frame = await response.Content.ReadAsByteArrayAsync(ct);
        var payload = Aeds.Decode(frame, FrameType.PrivateMediaUploadState);
        Assert.Equal(65536, BinaryPrimitives.ReadInt32LittleEndian(payload[20..]));
        Assert.Equal(completed.HasValue ? 1 : 0, payload[33]);
        var list = payload[34..];
        if (completed is Guid asset)
        {
            Assert.Equal(asset, new Guid(list[..16], bigEndian: true));
            list = list[16..];
        }
        Assert.Equal(parts.Length, BinaryPrimitives.ReadInt32LittleEndian(list));
        for (var index = 0; index < parts.Length; index++)
            Assert.Equal(parts[index], BinaryPrimitives.ReadInt32LittleEndian(list[(4 + 4 * index)..]));
        return new Guid(payload[..16], bigEndian: true);
    }

    private static async Task AssertHidden(HttpClient client, HttpMethod method, string path, SessionFixture? session,
        CancellationToken ct, string? previewTicket = null, bool range = false)
    {
        using var response = await Send(client, method, path, session, ct, previewTicket, range);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, response.Content.Headers.ContentLength);
        Assert.Null(response.Content.Headers.ContentType);
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal("no-cache", Assert.Single(response.Headers.Pragma).Name);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static Guid First(byte[] frame, int total)
    {
        var page = Aeds.Decode(frame, FrameType.PrivateMediaItems);
        Assert.Equal(total, BinaryPrimitives.ReadInt32LittleEndian(page[5..]));
        return total == 0 ? Guid.Empty : new Guid(page[9..25], bigEndian: true);
    }

    private static async Task<HttpResponseMessage> Upload(HttpClient client, SessionFixture session, Guid key, string name, string type,
        byte[] bytes, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, WireRoutes.PrivateMediaUpload + "?name=" + Uri.EscapeDataString(name), session);
        request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return await client.SendAsync(request, ct);
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, SessionFixture? session,
        CancellationToken ct, string? previewTicket = null, bool range = false)
    {
        using var request = Request(method, path, session);
        if (previewTicket is not null) request.Headers.Authorization = new("Bearer", previewTicket);
        if (range) request.Headers.Range = new RangeHeaderValue(0, 0);
        return await client.SendAsync(request, ct);
    }

    private static HttpRequestMessage Request(HttpMethod method, string path, SessionFixture? session)
    {
        var request = new HttpRequestMessage(method, path);
        if (session is not null)
        {
            request.Headers.Add("Cookie", $"fsus-v2-session={session.Token}");
            request.Headers.Add(WireHeaders.CurrentSession, session.SiteSessionId);
        }
        return request;
    }

    private static async Task<SessionFixture> Author(NpgsqlDataSource source, string name, bool canAuthor, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var bytes = RandomNumberGenerator.GetBytes(32);
        await using (var user = source.CreateCommand("INSERT INTO public.blog_user VALUES ($1,$2,$3,true,1)"))
        {
            user.Parameters.AddWithValue(id);
            user.Parameters.AddWithValue(name);
            user.Parameters.AddWithValue(canAuthor);
            await user.ExecuteNonQueryAsync(ct);
        }
        await using var session = source.CreateCommand("""
            INSERT INTO public.user_session (digest,user_id,generation,expires_at) VALUES ($1,$2,1,now()+interval '5 minutes')
            """);
        session.Parameters.AddWithValue(SHA256.HashData(bytes));
        session.Parameters.AddWithValue(id);
        await session.ExecuteNonQueryAsync(ct);
        return new(id, Convert.ToHexStringLower(bytes));
    }

    private sealed record SessionFixture(Guid Id, string Token)
    {
        internal string SiteSessionId => SiteSessions.Id(Id, SHA256.HashData(Convert.FromHexString(Token)));
    }
}
