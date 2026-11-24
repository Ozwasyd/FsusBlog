using System.IO.Compression;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PrivateMediaPostgresTests
{
    [PostgresFact]
    public async Task NativeImagesRequireAnAuthorAndTheirFilesStayPrivateThroughDeletion()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var primary = await MediaFixture.CreateSession(db.DataSource, "media-owner", ct, canAuthor: true);
        var another = await MediaFixture.CreateSession(db.DataSource, "media-outsider", ct, canAuthor: true);
        var reader = await MediaFixture.CreateSession(db.DataSource, "media-reader", ct, canAuthor: false);
        var directory = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-media-test-");
        var storage = directory.FullName;
        using (new MediaFixture.DirectoryCleanup(directory))
        {
            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage, [MediaUploadEndpoints.Setting] = "false" });
            var png = EncodeImage(SKEncodedImageFormat.Png);
            var jpeg = EncodeImage(SKEncodedImageFormat.Jpeg);
            var command = Guid.NewGuid();
            using var unsupported = Expect(UnsupportedMediaType, await Upload(server.Client, primary, command, "sample.svg", "image/svg+xml", "<svg/>"u8.ToArray(), ct));
            using var webpBeforeUpgrade = Expect(UnsupportedMediaType, await Upload(server.Client, primary, command, "sample.webp", "image/webp",
                EncodeImage(SKEncodedImageFormat.Webp), ct));
            using var wrongType = Expect(BadRequest, await Upload(server.Client, primary, command, "sample.png", "image/png", jpeg, ct));
            using var truncated = Expect(BadRequest, await Upload(server.Client, primary, command, "sample.png", "image/png", png[..24], ct));
            using var unable = Expect(Unauthorized, await Upload(server.Client, reader, command, "sample.png", "image/png", png, ct));
            Assert.Empty(directory.EnumerateFiles());

            // Trailing payload/metadata is removed by rendering decoded pixels into a new PNG.
            byte[] source = [.. png, .. "private marker"u8.ToArray()];
            using var created = Ok(await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct));
            var asset = First(await created.Content.ReadAsByteArrayAsync(ct), 1);
            using var replay = await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct);
            Assert.Equal(asset, First(await replay.Content.ReadAsByteArrayAsync(ct), 1));
            using var collision = Expect(Conflict, await Upload(server.Client, primary, command, "another.png", "image/png", source, ct));

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
            using var content = Ok(await Send(server.Client, HttpMethod.Get, raw, primary, ct));
            Assert.Equal("image/png", content.Content.Headers.ContentType?.MediaType);
            byte[] canonical = await content.Content.ReadAsByteArrayAsync(ct);
            Assert.True(canonical.AsSpan().IndexOf("private marker"u8) < 0);
            using var bitmap = SKBitmap.Decode(canonical);
            Assert.Equal((3, 2), (bitmap.Width, bitmap.Height));
            using var head = Ok(await Send(server.Client, HttpMethod.Head, raw, primary, ct));
            Assert.Equal(canonical.Length, head.Content.Headers.ContentLength);
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

            var leaf = Assert.Single(directory.EnumerateFiles());
            Assert.Equal($"{asset:N}.media", leaf.Name);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(leaf.FullName));
            var remove = WireRoutes.PrivateMediaRemove.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
            using var foreignRemove = Expect(NotFound, await Send(server.Client, HttpMethod.Post, remove, another, ct));
            using var removed = Ok(await Send(server.Client, HttpMethod.Post, remove, primary, ct));
            using var repeat = Ok(await Send(server.Client, HttpMethod.Post, remove, primary, ct));
            await AssertHidden(server.Client, HttpMethod.Get, raw, primary, ct);
            Assert.Empty(directory.EnumerateFiles());

            using var jpegUpload = Ok(await Upload(server.Client, primary, Guid.NewGuid(), "sample.jpeg", "image/jpeg", jpeg, ct));
            var jpegId = First(await jpegUpload.Content.ReadAsByteArrayAsync(ct), 1);
            var jpegPath = WireRoutes.PrivateMediaRead.Replace("{id}", jpegId.ToString("D"), StringComparison.Ordinal);
            using var jpegContent = Ok(await Send(server.Client, HttpMethod.Get, jpegPath, primary, ct));
            Assert.Equal("image/jpeg", jpegContent.Content.Headers.ContentType?.MediaType);
            using var jpegBitmap = SKBitmap.Decode(await jpegContent.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((3, 2), (jpegBitmap.Width, jpegBitmap.Height));
        }
    }

    [PostgresFact]
    public async Task CoherentWebpSchemaAdmitsStaticNativeBytesAndResumableReadsOnlyForTheOwner()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
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

        var owner = await MediaFixture.CreateSession(db.DataSource, "webp-owner", ct, canAuthor: true);
        var other = await MediaFixture.CreateSession(db.DataSource, "webp-other", ct, canAuthor: true);
        var directory = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-media-webp-");
        var root = directory.FullName;
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root, [MediaUploadEndpoints.Setting] = "true" };
        var key = Guid.NewGuid();
        const int partSize = 65536;
        var image = EncodeImage(SKEncodedImageFormat.Webp, 320, 320);
        Assert.InRange(image.Length, partSize + 1, partSize * 2);
        Guid upload;
        using (new MediaFixture.DirectoryCleanup(directory))
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
                    using var rejected = Expect(BadRequest, await Upload(server.Client, owner, Guid.NewGuid(), "invalid.webp", "image/webp", invalid, ct));
                }
                using var unknown = Expect(UnsupportedMediaType, await Upload(server.Client, owner, Guid.NewGuid(), "missing.png", "image/webp", image, ct));
                Assert.Empty(directory.EnumerateFiles());
                using var animatedUpload = await Begin(server.Client, owner, Guid.NewGuid(), "animated.webp", animated, ct, type: "image/webp");
                var rejectedUpload = await State(animatedUpload, [], ct);
                using var animatedPart = await Part(server.Client, owner, rejectedUpload, 0, 0, animated, ct);
                Assert.Equal(rejectedUpload, await State(animatedPart, [0], ct));
                using var rejectedFinalize = Expect(BadRequest, await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, rejectedUpload), owner, ct));
                using var cancelled = Ok(await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadCancel, rejectedUpload), owner, ct));
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
            using var completed = Ok(await Send(restarted.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, upload), owner, ct));
            var frame = await completed.Content.ReadAsByteArrayAsync(ct);
            var asset = First(frame, 1);
            Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(frame, FrameType.PrivateMediaItems)[25..]));
            var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
            await AssertHidden(restarted.Client, HttpMethod.Get, raw, other, ct);
            await AssertHidden(restarted.Client, HttpMethod.Head, raw, null, ct);
            using var allowed = Ok(await Send(restarted.Client, HttpMethod.Get, raw, owner, ct));
            Assert.Equal("image/webp", allowed.Content.Headers.ContentType?.MediaType);
            var canonical = await allowed.Content.ReadAsByteArrayAsync(ct);
            Assert.True(PublishedArticleImage.MatchesFormat(canonical, 3));
            using var native = SKBitmap.Decode(canonical);
            Assert.Equal((320, 320), (native.Width, native.Height));
            Assert.Equal(0, native.GetPixel(0, 0).Alpha);
            using var deleted = Ok(await Send(restarted.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct));
            Assert.Empty(directory.EnumerateFiles());
        }
    }

    [PostgresFact]
    public Task DraftAttachmentsPinPrivateImagesAndTicketsRequireCurrentRevisionAndSession() => CheckDraftAttachments(pdf: false);

    [PdfPostgresFact]
    public Task PdfIncludesOnlyApprovedSavedImagesAndPinsTheirOrder() => CheckDraftAttachments(pdf: true);

    private async Task CheckDraftAttachments(bool pdf)
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "attachment-owner", ct, canAuthor: true);
        var outsider = await MediaFixture.CreateSession(db.DataSource, "attachment-other", ct, canAuthor: true);
        var directory = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-media-attach-");
        var root = directory.FullName;
        var settings = new Dictionary<string, string>
        {
            [MediaEndpoints.StorageSetting] = root, ["FSUSBLOG_DOCUMENT_EXPORT_TASKS"] = "true",
        };
        if (!pdf) settings["FSUSBLOG_PDF_TOOL_ROOT"] = settings["FSUSBLOG_PDF_TOOL_SHA256"] = "";
        ServerProcess? server = null;
        try
        {
            server = await ServerProcess.Start(db.ConnectionString, ct, settings);
            var client = server.Client;
            var png = EncodeImage(SKEncodedImageFormat.Png);
            const string mediaName = "draft & proof.png";
            using var upload = await Upload(client, owner, Guid.NewGuid(), mediaName, "image/png", png, ct);
            var asset = First(await upload.Content.ReadAsByteArrayAsync(ct), 1);
            using var elsewhere = await Upload(client, outsider, Guid.NewGuid(), "foreign.png", "image/png", png, ct);
            var foreign = First(await elsewhere.Content.ReadAsByteArrayAsync(ct), 1);
            using var create = Ok(await Command(WireRoutes.Save, owner, Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Attachments", "Original body."))));
            var draft = Wire.DecodeDraft(await create.Content.ReadAsByteArrayAsync(ct));
            var input = new ArticleMediaCommand(draft.Id, draft.Revision, Guid.NewGuid(), asset, true);
            using var crossAsset = Expect(NotFound, await Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input with { AssetId = foreign })));
            using var unauthorized = Expect(NotFound, await Command(WireRoutes.ArticleMediaCommand, outsider, Wire.EncodeArticleMediaCommand(input)));
            using var attach = Ok(await Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input)));
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
            using var allowed = Ok(await Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket));
            Assert.True(allowed.Headers.CacheControl?.NoStore);
            Assert.Equal("image/png", allowed.Content.Headers.ContentType?.MediaType);
            Assert.Equal("no-referrer", Assert.Single(allowed.Headers.GetValues("Referrer-Policy")));
            var leaf = Path.Combine(root, $"{asset:N}.media");
            var normalized = await File.ReadAllBytesAsync(leaf, ct);
            Assert.Equal(normalized, await allowed.Content.ReadAsByteArrayAsync(ct));

            var held = leaf + ".held";
            File.Move(leaf, held);
            try { await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket); }
            finally { File.Move(held, leaf); }
            await AssertSaturatedPreviewIsHidden(ticket);

            using var cannotRemove = Expect(Conflict, await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct));
            using var detach = Ok(await Command(WireRoutes.ArticleMediaCommand, owner,
                Wire.EncodeArticleMediaCommand(input with { ExpectedRevision = saved.Revision, IdempotencyKey = Guid.NewGuid(), Attach = false })));
            var detached = Wire.DecodeDraft(await detach.Content.ReadAsByteArrayAsync(ct));
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket);

            using (var exported = Ok(await ExportHtml(detached.Revision, saved.Revision, owner, asset)))
            {
                Assert.True(exported.Headers.CacheControl?.NoStore);
                Assert.True(exported.Headers.CacheControl?.Private);
                Assert.Contains("img-src data:", Assert.Single(exported.Headers.GetValues("Content-Security-Policy")));
                Assert.Equal("article.html", exported.Content.Headers.ContentDisposition?.FileName);
                var document = await exported.Content.ReadAsStringAsync(ct);
                Assert.Contains("Original body.", document);
                Assert.Contains("img-src data:", document);
                var data = System.Text.RegularExpressions.Regex.Match(document,
                    """<img src="data:image/png;base64,([A-Za-z0-9+/=]+)" alt="draft &amp; proof.png" width="3" height="2">""");
                Assert.True(data.Success);
                Assert.Equal(normalized, Convert.FromBase64String(data.Groups[1].Value));
            }
            using (var plain = Ok(await ExportHtml(detached.Revision, saved.Revision, owner, null)))
            {
                Assert.DoesNotContain("<img", await plain.Content.ReadAsStringAsync(ct));
                Assert.DoesNotContain("img-src data:", Assert.Single(plain.Headers.GetValues("Content-Security-Policy")));
            }
            CheckStatus(NotFound, await ExportHtml(detached.Revision, detached.Revision, owner, asset));
            CheckStatus(NotFound, await ExportHtml(detached.Revision, saved.Revision, owner, foreign));
            CheckStatus(NotFound, await ExportHtml(detached.Revision, saved.Revision, outsider, asset));
            CheckStatus(Unauthorized, await ExportHtml(detached.Revision, saved.Revision, null, asset));
            CheckStatus(Conflict, await ExportHtml(saved.Revision, saved.Revision, owner, asset));
            CheckStatus(Conflict, await ExportHtml(detached.Revision, saved.Revision, owner, asset, outsider.SiteSessionId));

            XNamespace opf = "http://www.idpf.org/2007/opf";
            XNamespace xhtml = "http://www.w3.org/1999/xhtml";
            const string imagePath = "images/attachment.png";
            using var epub = Ok(await Export("epub", detached.Revision, saved.Revision, owner, asset));
            Assert.Equal("application/epub+zip", epub.Content.Headers.ContentType?.MediaType);
            Assert.Equal("article.epub", epub.Content.Headers.ContentDisposition?.FileName);
            Assert.True(epub.Headers.CacheControl?.Private);
            Assert.True(epub.Headers.CacheControl?.NoStore);
            var epubBytes = await epub.Content.ReadAsByteArrayAsync(ct);
            using (var archive = new ZipArchive(new MemoryStream(epubBytes)))
            {
                var manifest = ReadPart(archive, "EPUB/package.opf").Descendants(opf + "item");
                var resource = Assert.Single(manifest, item => (string?)item.Attribute("id") == "attachment");
                Assert.Equal((imagePath, "image/png"), ((string?)resource.Attribute("href"), (string?)resource.Attribute("media-type")));
                var chapter = ReadPart(archive, "EPUB/article.xhtml");
                Assert.Contains("Original body.", chapter.Root!.Value);
                var image = Assert.Single(chapter.Descendants(xhtml + "img"));
                Assert.Equal((imagePath, mediaName, "3", "2"),
                    ((string?)image.Attribute("src"), (string?)image.Attribute("alt"),
                     (string?)image.Attribute("width"), (string?)image.Attribute("height")));
                Assert.Equal("figure", image.Parent?.Name.LocalName);
                Assert.Equal(normalized, await ReadEntry(archive.GetEntry("EPUB/" + imagePath)!));
            }
            using (var repeatEpub = Ok(await Export("epub", detached.Revision, saved.Revision, owner, asset)))
            {
                Assert.Equal(epubBytes, await repeatEpub.Content.ReadAsByteArrayAsync(ct));
            }
            using (var plainEpub = Ok(await Export("epub", detached.Revision, saved.Revision, owner, null)))
            {
                using var archive = new ZipArchive(new MemoryStream(await plainEpub.Content.ReadAsByteArrayAsync(ct)));
                Assert.Equal(new[] { "mimetype", "META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml", "EPUB/article.xhtml" },
                    archive.Entries.Select(entry => entry.FullName));
                Assert.Equal(2, ReadPart(archive, "EPUB/package.opf").Descendants(opf + "item").Count());
                Assert.Empty(ReadPart(archive, "EPUB/article.xhtml").Descendants(xhtml + "img"));
            }
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.NotFound, detached.Revision, detached.Revision, owner, asset);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.NotFound, detached.Revision, saved.Revision, owner, foreign);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.NotFound, detached.Revision, saved.Revision, outsider, asset);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.Unauthorized, detached.Revision, saved.Revision, null, asset);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.Conflict, saved.Revision, saved.Revision, owner, asset);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.Conflict, detached.Revision, saved.Revision, owner, asset, outsider.SiteSessionId);
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.Conflict, detached.Revision, saved.Revision, owner, asset, "");

            const string wordType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            using (var word = Ok(await Export("docx", detached.Revision, saved.Revision, owner, asset)))
            {
                Assert.Equal(wordType, word.Content.Headers.ContentType?.MediaType);
                Assert.Equal("article.docx", word.Content.Headers.ContentDisposition?.FileName);
                Assert.True(word.Headers.CacheControl?.Private);
                Assert.True(word.Headers.CacheControl?.NoStore);
                var wordBytes = await word.Content.ReadAsByteArrayAsync(ct);
                using var archive = new ZipArchive(new MemoryStream(wordBytes));
                XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
                XNamespace documentRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
                XNamespace wordprocessing = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
                XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
                var relationships = ReadPart(archive, "word/_rels/document.xml.rels").Root!.Elements(packageRelationships + "Relationship");
                var reference = Assert.Single(relationships, relation => (string?)relation.Attribute("Id") == "Image");
                Assert.Equal("media/attachment.png", (string?)reference.Attribute("Target"));
                Assert.Equal(documentRelationships.NamespaceName + "/image", (string?)reference.Attribute("Type"));
                Assert.Null(reference.Attribute("TargetMode"));
                var document = ReadPart(archive, "word/document.xml");
                Assert.Contains("Original body.", document.Root!.Value);
                var picture = Assert.Single(document.Descendants(wordprocessing + "drawing"));
                var blip = Assert.Single(picture.Descendants(drawing + "blip"));
                Assert.Equal("Image", (string?)blip.Attribute(documentRelationships + "embed"));
                Assert.Null(blip.Attribute(documentRelationships + "link"));
                Assert.Equal(normalized, await ReadEntry(archive.GetEntry("word/media/attachment.png")!));
                if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DOCX_IMAGE_FIXTURE") is { Length: > 0 } fixture)
                    await File.WriteAllBytesAsync(fixture, wordBytes, ct);
            }
            await ExpectExportFailure("docx", wordType, HttpStatusCode.NotFound, detached.Revision, detached.Revision, owner, asset);
            await ExpectExportFailure("docx", wordType, HttpStatusCode.NotFound, detached.Revision, saved.Revision, owner, foreign);
            await ExpectExportFailure("docx", wordType, HttpStatusCode.NotFound, detached.Revision, saved.Revision, outsider, asset);
            await ExpectExportFailure("docx", wordType, HttpStatusCode.Conflict, saved.Revision, saved.Revision, owner, asset);
            await ExpectExportFailure("docx", wordType, HttpStatusCode.Conflict, detached.Revision, saved.Revision, owner, asset, outsider.SiteSessionId);

            var changed = normalized.ToArray();
            changed[^1] ^= 1;
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                using var corrupt = Expect(ServiceUnavailable, await ExportHtml(detached.Revision, saved.Revision, owner, asset));
                await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.ServiceUnavailable, detached.Revision, saved.Revision, owner, asset);
                await ExpectExportFailure("docx", wordType, HttpStatusCode.ServiceUnavailable, detached.Revision, saved.Revision, owner, asset);
            }, ct);

            using var historyStillPins = Expect(Conflict, await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct));
            using var restore = Ok(await Command(WireRoutes.DraftRollback,
                owner, Wire.EncodeDraftRollback(new(draft.Id, detached.Revision, saved.Revision, Guid.NewGuid(), "Restore the attached revision"))));
            var restored = Wire.DecodeDraft(await restore.Content.ReadAsByteArrayAsync(ct));
            using var restoredBytes = Ok(await Send(client, HttpMethod.Head, WireRoutes.ArticleMediaPreview, owner, ct, await Preview(restored.Revision)));
            using var published = Ok(await Command(WireRoutes.Publish, owner,
                Wire.EncodeArticleCommand(new(draft.Id, restored.Revision, Guid.NewGuid(), "", ""))));
            var publishedDraft = Wire.DecodeDraft(await published.Content.ReadAsByteArrayAsync(ct));
            var publicCandidateTicket = await Preview(publishedDraft.Revision);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, null, ct, publicCandidateTicket);
            using var html = Ok(await client.GetAsync($"/article/{draft.Id}", ct));
            Assert.DoesNotContain("draft-preview", await html.Content.ReadAsStringAsync(ct));
            await using var pin = db.DataSource.CreateCommand("SELECT count(*) FROM public.article_revision_media WHERE asset_id=$1");
            pin.Parameters.AddWithValue(asset);
            Assert.Equal(3L, await pin.ExecuteScalarAsync(ct));

            var jpeg = pdf ? EncodeImage(SKEncodedImageFormat.Jpeg, 24, 12) : EncodeImage(SKEncodedImageFormat.Jpeg);
            using var secondUpload = Ok(await Upload(client, owner, Guid.NewGuid(), "second.jpg", "image/jpeg", jpeg, ct));
            var second = First(await secondUpload.Content.ReadAsByteArrayAsync(ct), 1);
            var secondBytes = await File.ReadAllBytesAsync(Path.Combine(root, $"{second:N}.media"), ct);
            var both = await ChangeSecondImage(publishedDraft.Revision, true);
            var single = await ChangeSecondImage(both.Revision, false);
            var selectedPair = $"{second:D},{asset:D}";
            using var bundle = Ok(await Export("html", single.Revision, both.Revision, owner, null, selection: selectedPair));
            var markup = await bundle.Content.ReadAsStringAsync(ct);
            var bodies = new Dictionary<DocumentExportFormat, byte[]> { [DocumentExportFormat.Html] = System.Text.Encoding.UTF8.GetBytes(markup) };
            foreach (var (format, extension, resourceDirectory) in new[]
            {
                (DocumentExportFormat.Docx, "docx", "word/media/"),
                (DocumentExportFormat.Epub, "epub", "EPUB/images/")
            })
            {
                using var portable = Ok(await Export(extension, single.Revision, both.Revision, owner, null, selection: selectedPair));
                var bytes = bodies[format] = await portable.Content.ReadAsByteArrayAsync(ct);
                using var archive = new ZipArchive(new MemoryStream(bytes));
                var images = archive.Entries.Where(entry => entry.FullName.StartsWith(resourceDirectory, StringComparison.Ordinal)).ToArray();
                Assert.Equal(new[] { "attachment-1.jpeg", "attachment-2.png" }, images.Select(image => image.Name));
                Assert.Equal(secondBytes, await ReadEntry(images[0]));
                Assert.Equal(normalized, await ReadEntry(images[1]));
            }
            if (pdf)
            {
                using var direct = Ok(await Export("pdf", single.Revision, both.Revision, owner, null, selection: selectedPair));
                bodies.Add(DocumentExportFormat.Pdf, await ReadPdf(direct));
                await ExpectExportFailure("pdf", "application/pdf", HttpStatusCode.Conflict, both.Revision, both.Revision, owner, null, selection: selectedPair);
                await ExpectExportFailure("pdf", "application/pdf", HttpStatusCode.NotFound, single.Revision, single.Revision, owner, null, selection: selectedPair);
                await ExpectExportFailure("pdf", "application/pdf", HttpStatusCode.NotFound, single.Revision, both.Revision, owner, null, selection: $"{second:D},{foreign:D}");
            }
            var figures = System.Text.RegularExpressions.Regex.Matches(markup, """<img src="data:image/(jpeg|png);base64,([^"]+)" alt="([^"]+)"[^>]*>""");
            Assert.Equal(new[] { ("jpeg", Convert.ToBase64String(secondBytes), "second.jpg"),
                ("png", Convert.ToBase64String(normalized), "draft &amp; proof.png") },
                figures.Select(image => (image.Groups[1].Value, image.Groups[2].Value, image.Groups[3].Value)));
            foreach (var (format, revision, ids, status) in new[]
            {
                ("html", both.Revision, $"{asset:D},{asset:D}", HttpStatusCode.BadRequest),
                ("html", both.Revision, $"{asset:D},{foreign:D}", HttpStatusCode.NotFound),
                ("html", single.Revision, selectedPair, HttpStatusCode.NotFound),
                ("docx", both.Revision, $"{asset:D},{foreign:D}", HttpStatusCode.NotFound)
            })
            {
                using var denied = await Export(format, single.Revision, revision, owner, null, selection: ids);
                Assert.Equal(status, denied.StatusCode);
                Assert.DoesNotContain("data:image/", await denied.Content.ReadAsStringAsync(ct));
            }
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                using var badBundle = Expect(ServiceUnavailable, await Export("html", single.Revision, both.Revision, owner, null, selection: selectedPair));
                Assert.DoesNotContain("data:image/", await badBundle.Content.ReadAsStringAsync(ct));
                if (pdf) await ExpectExportFailure("pdf", "application/pdf", HttpStatusCode.ServiceUnavailable,
                    single.Revision, both.Revision, owner, null, selection: selectedPair);
            }, ct);

            using var saveExternal = Ok(await Command(WireRoutes.Save, owner, Wire.EncodeArticleCommand(
                new(draft.Id, single.Revision, Guid.NewGuid(), "Edited body", "![remote](https://export.invalid/photo.png)"))));
            var externalDraft = Wire.DecodeDraft(await saveExternal.Content.ReadAsByteArrayAsync(ct));
            await ExpectExportFailure("epub", "application/epub+zip", HttpStatusCode.BadRequest, externalDraft.Revision, externalDraft.Revision, owner, asset);
            using var priorEpub = Ok(await Export("epub", externalDraft.Revision, saved.Revision, owner, asset));
            Assert.Equal(epubBytes, await priorEpub.Content.ReadAsByteArrayAsync(ct));

            var jobInput = new DocumentExportCreate(Guid.NewGuid(), draft.Id, externalDraft.Revision, saved.Revision, DocumentExportFormat.Html);
            var frame = Wire.EncodeDocumentExportCreate(jobInput);
            await using var gate = await db.DataSource.OpenConnectionAsync(ct);
            await DocumentExportPostgresTests.HoldClaim(gate, jobInput.Id, ct);
            using var taskCreated = Ok(await Command(WireRoutes.DocumentExportCreate, owner, frame, asset));
            var receipt = Wire.DecodeDocumentExportTask(await taskCreated.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((jobInput, (byte)3), (receipt.Request, receipt.Provider));
            Assert.Equal(DocumentExportState.Queued, receipt.State);
            using var replay = Ok(await Command(WireRoutes.DocumentExportCreate, owner, frame, asset));
            Assert.Equal(receipt.SourceDigest, Wire.DecodeDocumentExportTask(await replay.Content.ReadAsByteArrayAsync(ct)).SourceDigest);
            using var changedSelection = Expect(Conflict, await Command(WireRoutes.DocumentExportCreate, owner, frame));
            var plainRequest = jobInput with { Id = Guid.NewGuid() };
            using var foreignAsset = Expect(NotFound, await Command(WireRoutes.DocumentExportCreate, owner, Wire.EncodeDocumentExportCreate(plainRequest), foreign));
            using var detachedAsset = Expect(NotFound, await Command(WireRoutes.DocumentExportCreate, owner,
                Wire.EncodeDocumentExportCreate(plainRequest with { SourceRevision = detached.Revision }), asset));
            using var textTask = Ok(await Command(WireRoutes.DocumentExportCreate, owner, Wire.EncodeDocumentExportCreate(plainRequest)));
            Assert.Equal(2, Wire.DecodeDocumentExportTask(await textTask.Content.ReadAsByteArrayAsync(ct)).Provider);

            // The plain v2 receipt above already proved that no attachment was selected. Free its owner quota.
            await using var remove = db.DataSource.CreateCommand("delete from public.author_document_export where id=$1");
            remove.Parameters.AddWithValue(plainRequest.Id);
            Assert.Equal(1, await remove.ExecuteNonQueryAsync(ct));
            // The existing fixture covers queued DOCX separately. Leave a quota slot for the native PDF.
            var bundleTasks = bodies.Keys.Where(format => !pdf || format != DocumentExportFormat.Docx).Select(format => jobInput with
                { Id = Guid.NewGuid(), SourceRevision = both.Revision, Format = format }).ToArray();
            foreach (var task in bundleTasks)
            {
                var bundleFrame = Wire.EncodeDocumentExportCreate(task);
                using var queueBundle = Ok(await Command(WireRoutes.DocumentExportCreate, owner, bundleFrame, selection: selectedPair));
                Assert.Equal(4, Wire.DecodeDocumentExportTask(await queueBundle.Content.ReadAsByteArrayAsync(ct)).Provider);
                using var reordered = Expect(Conflict, await Command(WireRoutes.DocumentExportCreate, owner, bundleFrame,
                    selection: $"{asset:D},{second:D}"));
            }

            var queuedServer = server;
            server = null;
            await queuedServer.DisposeAsync();
            await DocumentExportPostgresTests.ReleaseClaim(gate, ct);
            server = await ServerProcess.Start(db.ConnectionString, ct, settings);
            client = server.Client;

            var listPath = WireRoutes.DocumentExportTaskList.Replace("{id:int}", draft.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
            DocumentExportTask finished;
            DocumentExportTask[] finishedBundles;
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
            wait.CancelAfter(TimeSpan.FromSeconds(15));
            do
            {
                using var tasks = await Send(client, HttpMethod.Get, listPath, owner, wait.Token);
                var rows = Wire.DecodeDocumentExportTaskList(await tasks.Content.ReadAsByteArrayAsync(wait.Token));
                finished = Assert.Single(rows, value => value.Request.Id == jobInput.Id);
                finishedBundles = bundleTasks.Select(task => Assert.Single(rows, value => value.Request.Id == task.Id)).ToArray();
                if (finishedBundles.Append(finished).All(task => task.State is not (DocumentExportState.Queued or DocumentExportState.Running))) break;
                await Task.Delay(50, wait.Token);
            } while (true);
            Assert.Equal(DocumentExportState.Succeeded, finished.State);
            foreach (var task in finishedBundles)
            {
                Assert.Equal(DocumentExportState.Succeeded, task.State);
                using var deliveredBundle = Ok(await Command(WireRoutes.DocumentExportDownload, owner, Wire.EncodeDocumentExportTaskRef(task.Request.Id)));
                if (task.Request.Format == DocumentExportFormat.Pdf)
                {
                    var bytes = await ReadPdf(deliveredBundle);
                    Assert.Equal(task.OutputDigest, SHA256.HashData(bytes));
                    var pdfReceipt = JsonNode.Parse(await ExportResponseFixture.Receipt(client, task.Request.Id,
                        owner.Token, owner.SiteSessionId, HttpStatusCode.OK, ct))!;
                    Assert.Equal("Attachments", (string?)pdfReceipt["metadata"]?["title"]);
                    Assert.Equal(Digest("Original body."u8.ToArray()), (string?)pdfReceipt["bodySha256"]);
                    Assert.Equal(Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_SHA256"), (string?)pdfReceipt["toolchainSha256"]);
                    Assert.Equal(new[] { (second, Digest(secondBytes)), (asset, Digest(normalized)) }, pdfReceipt["assets"]!.AsArray()
                        .Select(image => (image!["id"]!.GetValue<Guid>(), (string)image["sha256"]!)));
                    if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PDF_IMAGE_EVIDENCE") is { } evidence)
                    {
                        await File.WriteAllBytesAsync(Path.Combine(evidence, "direct.pdf"), bodies[DocumentExportFormat.Pdf], ct);
                        await File.WriteAllBytesAsync(Path.Combine(evidence, "queued.pdf"), bytes, ct);
                    }
                }
                else Assert.Equal(bodies[task.Request.Format], await deliveredBundle.Content.ReadAsByteArrayAsync(ct));
            }
            var batch = Assert.Single(finishedBundles, task => task.Request.Format == DocumentExportFormat.Html);
            var batchReceipt = await ResultReceipt(HttpStatusCode.OK);
            var receiptManifest = JsonNode.Parse(batchReceipt)!;
            Assert.Equal(Convert.ToHexStringLower(batch.SourceDigest), (string?)receiptManifest["sourceSha256"]);
            Assert.Equal(Digest(bodies[DocumentExportFormat.Html]), (string?)receiptManifest["output"]?["sha256"]);
            Assert.Equal(new[] { (second, Digest(secondBytes)), (asset, Digest(normalized)) },
                receiptManifest["assets"]!.AsArray().Select(entry => (entry!["id"]!.GetValue<Guid>(), (string)entry["sha256"]!)));
            var download = Wire.EncodeDocumentExportTaskRef(jobInput.Id);
            using var rendered = Ok(await Command(WireRoutes.DocumentExportDownload, owner, download));
            Assert.True(rendered.Headers.CacheControl?.Private);
            Assert.True(rendered.Headers.CacheControl?.NoStore);
            Assert.Contains("img-src data:", Assert.Single(rendered.Headers.GetValues("Content-Security-Policy")));
            var renderedBytes = await rendered.Content.ReadAsByteArrayAsync(ct);
            Assert.Equal(SHA256.HashData(renderedBytes), finished.OutputDigest);
            var renderedHtml = System.Text.Encoding.UTF8.GetString(renderedBytes);
            Assert.Contains("Original body.", renderedHtml);
            Assert.DoesNotContain("Edited body", renderedHtml);
            Assert.Contains("data:image/png;base64," + Convert.ToBase64String(normalized), renderedHtml);
            using (var savedAsset = db.DataSource.CreateCommand("select attachment_id from public.author_document_export where id=$1"))
            {
                savedAsset.Parameters.AddWithValue(jobInput.Id);
                Assert.Equal(asset, await savedAsset.ExecuteScalarAsync(ct));
            }
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                using var corruptDownload = Expect(ServiceUnavailable, await Command(WireRoutes.DocumentExportDownload, owner, download));
                await ResultReceipt(HttpStatusCode.ServiceUnavailable);
                foreach (var task in bundleTasks)
                {
                    using var corruptBundle = Expect(ServiceUnavailable, await Command(WireRoutes.DocumentExportDownload, owner, Wire.EncodeDocumentExportTaskRef(task.Id)));
                    Assert.DoesNotContain("data:image/", await corruptBundle.Content.ReadAsStringAsync(ct));
                }
            }, ct);
            var priorServer = server;
            server = null;
            await priorServer.DisposeAsync();
            server = await ServerProcess.Start(db.ConnectionString, ct, settings);
            client = server.Client;
            using var reloaded = Ok(await Command(WireRoutes.DocumentExportDownload, owner, download));
            Assert.Equal(renderedBytes, await reloaded.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(batchReceipt, await ResultReceipt(HttpStatusCode.OK));

            Task<byte[]> ResultReceipt(HttpStatusCode status) =>
                ExportResponseFixture.Receipt(client, batch.Request.Id, owner.Token, owner.SiteSessionId, status, ct);

            static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

            async Task<Draft> ChangeSecondImage(long current, bool attachImage)
            {
                using var result = Ok(await Command(WireRoutes.ArticleMediaCommand, owner,
                    Wire.EncodeArticleMediaCommand(new(draft.Id, current, Guid.NewGuid(), second, attachImage))));
                return Wire.DecodeDraft(await result.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<HttpResponseMessage> Command(string path, MediaFixture.Session actor, byte[] bytes, Guid? image = null,
                string? selection = null)
            {
                using var request = Request(HttpMethod.Post, path, actor);
                if ((selection ?? image?.ToString("D")) is { } ids) request.Headers.Add(WireHeaders.HtmlExportAttachment, ids);
                request.Content = new ByteArrayContent(bytes);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
                return await client.SendAsync(request, ct);
            }

            Task<HttpResponseMessage> ExportHtml(long expected, long selected, MediaFixture.Session? actor, Guid? image,
                string? handle = null) => Export("html", expected, selected, actor, image, handle);

            async Task<HttpResponseMessage> Export(string format, long expected, long selected, MediaFixture.Session? actor, Guid? image,
                string? handle = null, string? selection = null)
            {
                using var request = Request(HttpMethod.Get,
                    $"/api/v2/authoring/draft/{draft.Id}/export.{format}?revision={expected}&sourceRevision={selected}", actor);
                if ((selection ?? image?.ToString("D")) is { } ids) request.Headers.Add(WireHeaders.HtmlExportAttachment, ids);
                if (handle is not null)
                {
                    request.Headers.Remove(WireHeaders.CurrentSession);
                    if (handle.Length > 0) request.Headers.Add(WireHeaders.CurrentSession, handle);
                }
                return await client.SendAsync(request, ct);
            }

            async Task ExpectExportFailure(string format, string mediaType, HttpStatusCode status, long expected, long selected,
                MediaFixture.Session? actor, Guid? image, string? handle = null, string? selection = null)
            {
                using var unavailable = await Export(format, expected, selected, actor, image, handle, selection);
                Assert.Equal(status, unavailable.StatusCode);
                Assert.NotEqual(mediaType, unavailable.Content.Headers.ContentType?.MediaType);
            }

            async Task<byte[]> ReadPdf(HttpResponseMessage response)
            {
                ExportResponseFixture.Attachment(response, "application/pdf", "article.pdf");
                Assert.True(response.Headers.CacheControl?.NoStore);
                var bytes = await response.Content.ReadAsByteArrayAsync(ct);
                Assert.Equal("%PDF-", Encoding.ASCII.GetString(bytes, 0, 5));
                Assert.EndsWith("%%EOF", Encoding.ASCII.GetString(bytes[^16..]).TrimEnd(), StringComparison.Ordinal);
                return bytes;
            }

            async Task<byte[]> ReadEntry(ZipArchiveEntry entry)
            {
                using var part = entry.Open();
                using var bytes = new MemoryStream();
                await part.CopyToAsync(bytes, ct);
                return bytes.ToArray();
            }

            static XDocument ReadPart(ZipArchive archive, string path)
            {
                using var part = archive.GetEntry(path)!.Open();
                return XDocument.Load(part);
            }

            async Task<string> Preview(long revision)
            {
                var path = WireRoutes.ArticleMedia.Replace("{id:int}", $"{draft.Id}", StringComparison.Ordinal);
                using var response = Ok(await Send(client, HttpMethod.Get, $"{path}?revision={revision}", owner, ct));
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
        finally
        {
            try { if (server is not null) await server.DisposeAsync(); }
            finally { directory.Delete(recursive: true); }
        }
    }

    [PostgresFact]
    public async Task ResumablePartsPersistAcrossRestartAndFinalizeOnlyVerifiedPrivateBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "resume-owner", ct, canAuthor: true);
        var foreign = await MediaFixture.CreateSession(db.DataSource, "resume-other", ct, canAuthor: true);
        var reader = await MediaFixture.CreateSession(db.DataSource, "resume-reader", ct, canAuthor: false);
        var directory = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-media-parts-");
        var root = directory.FullName;
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root, [MediaUploadEndpoints.Setting] = "true" };
        const int partSize = 65536;
        var png = EncodeImage(SKEncodedImageFormat.Png);
        var image = new byte[partSize + 19];
        png.CopyTo(image, 0);
        var key = Guid.NewGuid();
        Guid upload;
        using (new MediaFixture.DirectoryCleanup(directory))
        {
            await using (var server = await ServerProcess.Start(db.ConnectionString, ct, settings))
            {
                using var auth = Expect(Unauthorized, await Begin(server.Client, reader, key, "resumable.png", image, ct));
                using var advertised = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct);
                Assert.Equal("1", Assert.Single(advertised.Headers.GetValues(WireHeaders.PrivateMediaResumable)));
                using var webpBeforeUpgrade = Expect(UnsupportedMediaType, await Begin(server.Client, owner, key, "resumable.webp",
                    EncodeImage(SKEncodedImageFormat.Webp), ct, type: "image/webp"));
                using var stale = Expect(Conflict, await Begin(server.Client, foreign, key, "resumable.png", image, ct, owner));
                using var created = await Begin(server.Client, owner, key, "resumable.png", image, ct);
                upload = await State(created, [], ct);
                using var conflict = Expect(Conflict, await Begin(server.Client, owner, key, "changed.png", image, ct));
                using var hidden = Expect(NotFound, await Send(server.Client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), foreign, ct));
                using var wrongOffset = Expect(BadRequest, await Part(server.Client, owner, upload, 1, 0, image[partSize..], ct));
                using var wrongDigest = Expect(BadRequest, await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct, new byte[32]));
                using var valid = await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct);
                Assert.Equal(upload, await State(valid, [1], ct));
                using var retry = await Part(server.Client, owner, upload, 1, partSize, image[partSize..], ct);
                Assert.Equal(upload, await State(retry, [1], ct));
                using var conflictPart = Expect(Conflict, await Part(server.Client, owner, upload, 1, partSize, Enumerable.Repeat((byte)9, 19).ToArray(), ct));
                using var incomplete = Expect(Conflict, await Send(server.Client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, upload), owner, ct));
                Assert.Empty(directory.EnumerateFiles());
            }

            await using var resumedServer = await ServerProcess.Start(db.ConnectionString, ct, settings);
            var client = resumedServer.Client;
            using var repeatedBegin = await Begin(client, owner, key, "resumable.png", image, ct);
            Assert.Equal(upload, await State(repeatedBegin, [1], ct));
            using var finalPart = await Part(client, owner, upload, 0, 0, image[..partSize], ct);
            Assert.Equal(upload, await State(finalPart, [0, 1], ct));
            var finalize = PathFor(WireRoutes.PrivateMediaUploadFinalize, upload);
            using var wrongOwner = Expect(NotFound, await Send(client, HttpMethod.Post, finalize, foreign, ct));
            var approvals = await Task.WhenAll(
                Send(client, HttpMethod.Post, finalize, owner, ct),
                Send(client, HttpMethod.Post, finalize, owner, ct));
            using var committed = approvals[0];
            using var simultaneous = approvals[1];
            Assert.Equal(HttpStatusCode.OK, committed.StatusCode);
            var asset = First(await committed.Content.ReadAsByteArrayAsync(ct), 1);
            Assert.Equal(HttpStatusCode.OK, simultaneous.StatusCode);
            Assert.Equal(asset, First(await simultaneous.Content.ReadAsByteArrayAsync(ct), 1));
            using var retryFinalize = Ok(await Send(client, HttpMethod.Post, finalize, owner, ct));
            Assert.Equal(asset, First(await retryFinalize.Content.ReadAsByteArrayAsync(ct), 1));
            using var completed = await Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), owner, ct);
            Assert.Equal(upload, await State(completed, [], ct, asset));
            var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
            await AssertHidden(client, HttpMethod.Get, raw, foreign, ct);
            using var read = Ok(await Send(client, HttpMethod.Get, raw, owner, ct));
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
            using var mismatch = Expect(Conflict, await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadFinalize, other), owner, ct));
            using var remove = Ok(await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaUploadCancel, other), owner, ct));
            await using var check = db.DataSource.CreateCommand("SELECT count(*) FROM public.private_media_upload_part");
            Assert.Equal(0L, await check.ExecuteScalarAsync(ct));

            List<Guid> held = [];
            for (var i = 0; i < 4; i++)
            {
                using var staged = await Begin(client, owner, Guid.NewGuid(), "staged.png", image, ct);
                held.Add(await State(staged, [], ct));
            }
            using var overBudget = Expect(Conflict, await Begin(client, owner, Guid.NewGuid(), "held.png", image, ct));
            using var willExpire = await Part(client, owner, held[0], 1, partSize, image[partSize..], ct);
            Assert.Equal(held[0], await State(willExpire, [1], ct));
            await using (var expire = db.DataSource.CreateCommand("UPDATE public.private_media_upload SET expires_at=now()-interval '1 second' WHERE id=$1"))
            {
                expire.Parameters.AddWithValue(held[0]);
                Assert.Equal(1, await expire.ExecuteNonQueryAsync(ct));
            }
            using var replacement = await Begin(client, owner, Guid.NewGuid(), "replacement.png", image, ct);
            Assert.NotEqual(held[0], await State(replacement, [], ct));
            using var expired = Expect(NotFound, await Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, held[0]), owner, ct));
            Assert.Equal(0L, await check.ExecuteScalarAsync(ct));
            Assert.Single(directory.EnumerateFiles());
        }
    }

    [PostgresFact]
    public async Task PendingUploadCanResumeAndDeletionRefusesUnownedFileBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "media-owner", ct, canAuthor: true);
        var directory = MediaFixture.CreateOwnedTemporaryDirectory("fsusblog-media-recovery-");
        var storage = directory.FullName;
        using (new MediaFixture.DirectoryCleanup(directory))
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
            using var blocked = Expect(InternalServerError, await Send(server.Client, HttpMethod.Post, remove, owner, ct));
            Assert.Equal(unrelated, await File.ReadAllBytesAsync(leaf.FullName, ct));
            await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);

            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await File.WriteAllBytesAsync(leaf.FullName, original, ct);
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead);
            using var retry = Ok(await Send(server.Client, HttpMethod.Post, remove, owner, ct));
            Assert.Empty(directory.EnumerateFiles());
        }
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

    private static async Task<HttpResponseMessage> Begin(HttpClient client, MediaFixture.Session actor, Guid key, string name, byte[] image,
        CancellationToken ct, MediaFixture.Session? expected = null, string type = "image/png")
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

    private static async Task<HttpResponseMessage> Part(HttpClient client, MediaFixture.Session actor, Guid id, int part, int offset,
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

    private static async Task AssertHidden(HttpClient client, HttpMethod method, string path, MediaFixture.Session? session,
        CancellationToken ct, string? previewTicket = null, bool range = false)
    {
        using var response = Expect(NotFound, await Send(client, method, path, session, ct, previewTicket, range));
        Assert.Equal(0, response.Content.Headers.ContentLength);
        Assert.Null(response.Content.Headers.ContentType);
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal("no-cache", Assert.Single(response.Headers.Pragma).Name);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static Guid First(byte[] frame, int total) => MediaFixture.FirstListedAsset(frame, total);

    private static Task<HttpResponseMessage> Upload(HttpClient client, MediaFixture.Session session, Guid key, string name, string type,
        byte[] bytes, CancellationToken ct) => MediaFixture.Upload(client, session, key, name, type, bytes, ct);

    private static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, MediaFixture.Session? session,
        CancellationToken ct, string? previewTicket = null, bool range = false)
    {
        using var request = Request(method, path, session, SiteAedsFixture.IsHttps(client));
        if (previewTicket is not null) request.Headers.Authorization = new("Bearer", previewTicket);
        if (range) request.Headers.Range = new RangeHeaderValue(0, 0);
        return await client.SendAsync(request, ct);
    }

    private static HttpRequestMessage Request(HttpMethod method, string path, MediaFixture.Session? session, bool secure = false) =>
        SiteAedsFixture.Request(method, path, frame: null, session?.Token, session?.SiteSessionId, secure);
}
