using System.IO.Compression;
using System.Text.RegularExpressions;
using static FsusBlog.V2.Integration.Tests.ExportResponseFixture;

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
        using var directory = MediaFixture.OwnedTempDirectory("fsusblog-media-test-");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = directory.FullName, [MediaUploadEndpoints.Setting] = "false" });
        var client = server.Client;
        var png = EncodeImage(SKEncodedImageFormat.Png);
        var jpeg = EncodeImage(SKEncodedImageFormat.Jpeg);
        var command = Guid.NewGuid();
        foreach (var (actor, name, type, bytes, status) in new (MediaFixture.Session, string, string, byte[], HttpStatusCode)[]
        {
            (primary, "sample.svg", "image/svg+xml", "<svg/>"u8.ToArray(), UnsupportedMediaType),
            (primary, "sample.webp", "image/webp", EncodeImage(SKEncodedImageFormat.Webp), UnsupportedMediaType),
            (primary, "sample.png", "image/png", jpeg, BadRequest),
            (primary, "sample.png", "image/png", png[..24], BadRequest),
            (reader, "sample.png", "image/png", png, Unauthorized),
        })
            await CheckStatusAsync(status, Upload(client, actor, command, name, type, bytes, ct));
        Assert.Empty(directory.Directory.EnumerateFiles());

        // Trailing payload/metadata is removed by rendering decoded pixels into a new PNG.
        byte[] source = [.. png, .. "private marker"u8.ToArray()];
        var asset = await UploadAsset(client, primary, command, "sample.png", "image/png", source, ct);
        Assert.Equal(asset, await UploadAsset(client, primary, command, "sample.png", "image/png", source, ct));
        await CheckStatusAsync(Conflict, Upload(client, primary, command, "another.png", "image/png", source, ct));

        using (var list = Ok(await Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, primary, ct)))
        {
            Assert.Equal(asset, First(await list.Content.ReadAsByteArrayAsync(ct), 1));
            Assert.False(list.Headers.Contains(WireHeaders.PrivateMediaResumable));
            Assert.False(list.Headers.Contains(WireHeaders.PrivateMediaWebp));
        }
        Assert.Equal(Guid.Empty, First(await OkBytes(Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, another, ct), ct), 0));

        var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
        foreach (var (method, path, actor) in new (HttpMethod, string, MediaFixture.Session?)[]
        {
            (HttpMethod.Get, raw, null),
            (HttpMethod.Get, raw, another),
            (HttpMethod.Head, raw, reader),
            (HttpMethod.Get, PathFor(WireRoutes.PrivateMediaRead, Guid.NewGuid()), primary),
            (HttpMethod.Get, WireRoutes.PrivateMediaRead.Replace("{id}", "missing", StringComparison.Ordinal), primary),
        })
            await AssertHidden(client, method, path, actor, ct);
        using var content = Ok(await Send(client, HttpMethod.Get, raw, primary, ct));
        Assert.Equal("image/png", content.Content.Headers.ContentType?.MediaType);
        byte[] canonical = await content.Content.ReadAsByteArrayAsync(ct);
        Assert.True(canonical.AsSpan().IndexOf("private marker"u8) < 0);
        AssertDimensions(canonical, 3, 2);
        using var head = Ok(await Send(client, HttpMethod.Head, raw, primary, ct));
        Assert.Equal(canonical.Length, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

        AssertOwnedLeaf(directory.Directory, asset);
        await CheckPost(client, NotFound, WireRoutes.PrivateMediaRemove, asset, another, ct);
        await CheckPost(client, OK, WireRoutes.PrivateMediaRemove, asset, primary, ct);
        await CheckPost(client, OK, WireRoutes.PrivateMediaRemove, asset, primary, ct);
        await AssertHidden(client, HttpMethod.Get, raw, primary, ct);
        Assert.Empty(directory.Directory.EnumerateFiles());

        var jpegId = await UploadAsset(client, primary, Guid.NewGuid(), "sample.jpeg", "image/jpeg", jpeg, ct);
        using var jpegContent = Ok(await Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaRead, jpegId), primary, ct));
        Assert.Equal("image/jpeg", jpegContent.Content.Headers.ContentType?.MediaType);
        AssertDimensions(await jpegContent.Content.ReadAsByteArrayAsync(ct), 3, 2);
    }

    [PostgresFact]
    public async Task CoherentWebpSchemaAdmitsStaticNativeBytesAndResumableReadsOnlyForTheOwner()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        await db.WithConnection(async connection =>
        {
            Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
            await FixtureSql.ExecuteAsync(connection, null, ct, """
                alter table public.private_media drop constraint private_media_format_check,
                  add constraint private_media_format_check check (format between 1 and 3)
                """);
            await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
            await FixtureSql.ExecuteAsync(connection, null, ct, """
                alter table public.private_media_upload drop constraint private_media_upload_format_check,
                  add constraint private_media_upload_format_check check (format between 1 and 3);
                alter table public.article_publication_media drop constraint article_publication_media_format_check,
                  add constraint article_publication_media_format_check check (format between 1 and 3)
                """);
            Assert.True(await CurrentSchema.VerifyAsync(connection, ct));
        }, ct);

        var owner = await MediaFixture.CreateSession(db.DataSource, "webp-owner", ct, canAuthor: true);
        var other = await MediaFixture.CreateSession(db.DataSource, "webp-other", ct, canAuthor: true);
        using var directory = MediaFixture.OwnedTempDirectory("fsusblog-media-webp-");
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = directory.FullName, [MediaUploadEndpoints.Setting] = "true" };
        var key = Guid.NewGuid();
        const int partSize = 65536;
        var image = EncodeImage(SKEncodedImageFormat.Webp, 320, 320);
        Assert.InRange(image.Length, partSize + 1, partSize * 2);
        Guid upload;
        await using (var server = await ServerProcess.Start(db.ConnectionString, ct, settings))
        {
            var client = server.Client;
            using (var list = Ok(await Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct)))
                Assert.Equal("1", Assert.Single(list.Headers.GetValues(WireHeaders.PrivateMediaWebp)));
            var animated = AnimateOnce(EncodeImage(SKEncodedImageFormat.Webp));
            using var codec = SKCodec.Create(new MemoryStream(animated));
            Assert.NotNull(codec);
            Assert.Equal(1, codec.FrameCount);
            foreach (var invalid in new[] { animated, image[..^1], EncodeImage(SKEncodedImageFormat.Png) })
                await CheckStatusAsync(BadRequest, Upload(client, owner, Guid.NewGuid(), "invalid.webp", "image/webp", invalid, ct));
            await CheckStatusAsync(UnsupportedMediaType, Upload(client, owner, Guid.NewGuid(), "missing.png", "image/webp", image, ct));
            Assert.Empty(directory.Directory.EnumerateFiles());
            var rejectedUpload = await BeginState(client, owner, Guid.NewGuid(), "animated.webp", animated, [], ct, type: "image/webp");
            Assert.Equal(rejectedUpload, await PartState(client, owner, rejectedUpload, 0, 0, animated, [0], ct));
            await CheckPost(client, BadRequest, WireRoutes.PrivateMediaUploadFinalize, rejectedUpload, owner, ct);
            await CheckPost(client, OK, WireRoutes.PrivateMediaUploadCancel, rejectedUpload, owner, ct);
            Assert.Empty(directory.Directory.EnumerateFiles());
            upload = await BeginState(client, owner, key, "resumable.webp", image, [], ct, type: "image/webp");
            Assert.Equal(upload, await PartState(client, owner, upload, 0, 0, image[..partSize], [0], ct));
        }

        await using var restarted = await ServerProcess.Start(db.ConnectionString, ct, settings);
        var resumed = restarted.Client;
        Assert.Equal(upload, await BeginState(resumed, owner, key, "resumable.webp", image, [0], ct, type: "image/webp"));
        Assert.Equal(upload, await PartState(resumed, owner, upload, 1, partSize, image[partSize..], [0, 1], ct));
        var frame = await OkBytes(PostId(resumed, WireRoutes.PrivateMediaUploadFinalize, upload, owner, ct), ct);
        var asset = First(frame, 1);
        Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(frame, FrameType.PrivateMediaItems)[25..]));
        var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
        await AssertHidden(resumed, HttpMethod.Get, raw, other, ct);
        await AssertHidden(resumed, HttpMethod.Head, raw, null, ct);
        using var allowed = Ok(await Send(resumed, HttpMethod.Get, raw, owner, ct));
        Assert.Equal("image/webp", allowed.Content.Headers.ContentType?.MediaType);
        var canonical = await allowed.Content.ReadAsByteArrayAsync(ct);
        Assert.True(PublishedArticleImage.MatchesFormat(canonical, 3));
        using var native = SKBitmap.Decode(canonical);
        Assert.Equal((320, 320, (byte)0), (native.Width, native.Height, native.GetPixel(0, 0).Alpha));
        await CheckPost(resumed, OK, WireRoutes.PrivateMediaRemove, asset, owner, ct);
        Assert.Empty(directory.Directory.EnumerateFiles());
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
        using var directory = MediaFixture.OwnedTempDirectory("fsusblog-media-attach-");
        var root = directory.FullName;
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = root, ["FSUSBLOG_DOCUMENT_EXPORT_TASKS"] = "true" };
        if (!pdf) settings["FSUSBLOG_PDF_TOOL_ROOT"] = settings["FSUSBLOG_PDF_TOOL_SHA256"] = "";
        ServerProcess? server = null;
        try
        {
            server = await ServerProcess.Start(db.ConnectionString, ct, settings);
            var client = server.Client;
            var png = EncodeImage(SKEncodedImageFormat.Png);
            const string mediaName = "draft & proof.png";
            var asset = await UploadAsset(client, owner, Guid.NewGuid(), mediaName, "image/png", png, ct);
            var foreign = await UploadAsset(client, outsider, Guid.NewGuid(), "foreign.png", "image/png", png, ct);
            var draft = await CommandDraft(WireRoutes.Save, owner, Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Attachments", "Original body.")));
            var input = new ArticleMediaCommand(draft.Id, draft.Revision, Guid.NewGuid(), asset, true);
            await CheckStatusAsync(NotFound, Command(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input with { AssetId = foreign })));
            await CheckStatusAsync(NotFound, Command(WireRoutes.ArticleMediaCommand, outsider, Wire.EncodeArticleMediaCommand(input)));
            var saved = await CommandDraft(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input));
            Assert.Equal((draft.Revision + 1, draft.Body), (saved.Revision, saved.Body));
            Assert.Equal(saved, await CommandDraft(WireRoutes.ArticleMediaCommand, owner, Wire.EncodeArticleMediaCommand(input)));
            var ticket = await Preview(saved.Revision);
            foreach (var (method, path, actor, token, range) in new (HttpMethod, string, MediaFixture.Session?, string?, bool)[]
            {
                (HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, null, false),
                (HttpMethod.Get, WireRoutes.ArticleMediaPreview, null, ticket, false),
                (HttpMethod.Get, WireRoutes.ArticleMediaPreview, outsider, ticket, false),
                (HttpMethod.Head, WireRoutes.ArticleMediaPreview, owner, ticket[..^2] + (ticket[^2] == 'b' ? 'A' : 'b') + ticket[^1], false),
                (HttpMethod.Get, WireRoutes.ArticleMediaPreview + "?extra=unexpected", owner, ticket, false),
                (HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ticket, true),
            })
                await AssertHidden(client, method, path, actor, ct, token, range);
            var leaf = Path.Combine(root, $"{asset:N}.media");
            var normalized = await File.ReadAllBytesAsync(leaf, ct);
            using (var allowed = Ok(await Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket)))
            {
                Assert.Equal((true, "image/png", "no-referrer"), (allowed.Headers.CacheControl?.NoStore,
                    allowed.Content.Headers.ContentType?.MediaType, Assert.Single(allowed.Headers.GetValues("Referrer-Policy"))));
                Assert.Equal(normalized, await allowed.Content.ReadAsByteArrayAsync(ct));
            }

            var held = leaf + ".held";
            File.Move(leaf, held);
            try { await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket); }
            finally { File.Move(held, leaf); }
            await AssertSaturatedPreviewIsHidden(ticket);

            await CheckPost(client, Conflict, WireRoutes.PrivateMediaRemove, asset, owner, ct);
            var detached = await CommandDraft(WireRoutes.ArticleMediaCommand, owner,
                Wire.EncodeArticleMediaCommand(input with { ExpectedRevision = saved.Revision, IdempotencyKey = Guid.NewGuid(), Attach = false }));
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket);

            using (var exported = Ok(await Export("html", detached.Revision, saved.Revision, owner, asset)))
            {
                Assert.Equal((true, true, "article.html"), (exported.Headers.CacheControl?.NoStore, exported.Headers.CacheControl?.Private,
                    exported.Content.Headers.ContentDisposition?.FileName));
                Assert.Contains("img-src data:", Assert.Single(exported.Headers.GetValues("Content-Security-Policy")));
                var document = await exported.Content.ReadAsStringAsync(ct);
                Assert.Contains("Original body.", document);
                Assert.Contains("img-src data:", document);
                var data = Regex.Match(document, """<img src="data:image/png;base64,([A-Za-z0-9+/=]+)" alt="draft &amp; proof.png" width="3" height="2">""");
                Assert.True(data.Success);
                Assert.Equal(normalized, Convert.FromBase64String(data.Groups[1].Value));
            }
            using (var plain = Ok(await Export("html", detached.Revision, saved.Revision, owner, null)))
            {
                Assert.DoesNotContain("<img", await plain.Content.ReadAsStringAsync(ct));
                Assert.DoesNotContain("img-src data:", Assert.Single(plain.Headers.GetValues("Content-Security-Policy")));
            }
            (HttpStatusCode Status, long Expected, long Selected, MediaFixture.Session? Actor, Guid Image, string? Handle)[] rejectedExports =
            [
                (NotFound, detached.Revision, detached.Revision, owner, asset, null),
                (NotFound, detached.Revision, saved.Revision, owner, foreign, null),
                (NotFound, detached.Revision, saved.Revision, outsider, asset, null),
                (Unauthorized, detached.Revision, saved.Revision, null, asset, null),
                (Conflict, saved.Revision, saved.Revision, owner, asset, null),
                (Conflict, detached.Revision, saved.Revision, owner, asset, outsider.SiteSessionId),
            ];
            foreach (var c in rejectedExports)
                await CheckStatusAsync(c.Status, Export("html", c.Expected, c.Selected, c.Actor, c.Image, c.Handle));

            XNamespace opf = "http://www.idpf.org/2007/opf";
            XNamespace xhtml = "http://www.w3.org/1999/xhtml";
            const string imagePath = "images/attachment.png";
            byte[] epubBytes;
            using (var epub = Ok(await Export("epub", detached.Revision, saved.Revision, owner, asset)))
            {
                ExportResponseFixture.Attachment(epub, "application/epub+zip", "article.epub", noStore: true);
                epubBytes = await epub.Content.ReadAsByteArrayAsync(ct);
                using var archive = OpenZip(epubBytes);
                var resource = Assert.Single(ReadZipXml(archive, "EPUB/package.opf").Descendants(opf + "item"),
                    item => (string?)item.Attribute("id") == "attachment");
                Assert.Equal((imagePath, "image/png"), ((string?)resource.Attribute("href"), (string?)resource.Attribute("media-type")));
                var chapter = ReadZipXml(archive, "EPUB/article.xhtml");
                Assert.Contains("Original body.", chapter.Root!.Value);
                var image = Assert.Single(chapter.Descendants(xhtml + "img"));
                Assert.Equal((imagePath, mediaName, "3", "2", "figure"), ((string?)image.Attribute("src"), (string?)image.Attribute("alt"),
                    (string?)image.Attribute("width"), (string?)image.Attribute("height"), image.Parent?.Name.LocalName));
                Assert.Equal(normalized, await ReadEntry(archive.GetEntry("EPUB/" + imagePath)!));
            }
            Assert.Equal(epubBytes, await OkBytes(Export("epub", detached.Revision, saved.Revision, owner, asset), ct));
            using (var archive = OpenZip(await OkBytes(Export("epub", detached.Revision, saved.Revision, owner, null), ct)))
            {
                Assert.Equal(new[] { "mimetype", "META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml", "EPUB/article.xhtml" },
                    archive.Entries.Select(entry => entry.FullName));
                Assert.Equal(2, ReadZipXml(archive, "EPUB/package.opf").Descendants(opf + "item").Count());
                Assert.Empty(ReadZipXml(archive, "EPUB/article.xhtml").Descendants(xhtml + "img"));
            }
            foreach (var (status, expected, selected, actor, image, handle) in rejectedExports.Append((Conflict, detached.Revision, saved.Revision, owner, asset, "")))
                await ExpectExportFailure("epub", "application/epub+zip", status, expected, selected, actor, image, handle);

            const string wordType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            using (var word = Ok(await Export("docx", detached.Revision, saved.Revision, owner, asset)))
            {
                ExportResponseFixture.Attachment(word, wordType, "article.docx", noStore: true);
                var wordBytes = await word.Content.ReadAsByteArrayAsync(ct);
                using var archive = OpenZip(wordBytes);
                XNamespace packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
                XNamespace documentRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
                XNamespace wordprocessing = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
                XNamespace drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
                var reference = Assert.Single(ReadZipXml(archive, "word/_rels/document.xml.rels").Root!.Elements(packageRelationships + "Relationship"),
                    relation => (string?)relation.Attribute("Id") == "Image");
                Assert.Equal(("media/attachment.png", documentRelationships.NamespaceName + "/image", (string?)null),
                    ((string?)reference.Attribute("Target"), (string?)reference.Attribute("Type"), (string?)reference.Attribute("TargetMode")));
                var document = ReadZipXml(archive, "word/document.xml");
                Assert.Contains("Original body.", document.Root!.Value);
                var blip = Assert.Single(Assert.Single(document.Descendants(wordprocessing + "drawing")).Descendants(drawing + "blip"));
                Assert.Equal(("Image", (string?)null), ((string?)blip.Attribute(documentRelationships + "embed"), (string?)blip.Attribute(documentRelationships + "link")));
                Assert.Equal(normalized, await ReadEntry(archive.GetEntry("word/media/attachment.png")!));
                if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DOCX_IMAGE_FIXTURE") is { Length: > 0 } fixture)
                    await File.WriteAllBytesAsync(fixture, wordBytes, ct);
            }
            foreach (var c in rejectedExports.Where(c => c.Status != Unauthorized))
                await ExpectExportFailure("docx", wordType, c.Status, c.Expected, c.Selected, c.Actor, c.Image, c.Handle);

            var changed = normalized.ToArray();
            changed[^1] ^= 1;
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                await CheckStatusAsync(ServiceUnavailable, Export("html", detached.Revision, saved.Revision, owner, asset));
                await ExpectExportFailure("epub", "application/epub+zip", ServiceUnavailable, detached.Revision, saved.Revision, owner, asset);
                await ExpectExportFailure("docx", wordType, ServiceUnavailable, detached.Revision, saved.Revision, owner, asset);
            }, ct);

            await CheckPost(client, Conflict, WireRoutes.PrivateMediaRemove, asset, owner, ct);
            var restored = await CommandDraft(WireRoutes.DraftRollback, owner,
                Wire.EncodeDraftRollback(new(draft.Id, detached.Revision, saved.Revision, Guid.NewGuid(), "Restore the attached revision")));
            await CheckStatusAsync(OK, Send(client, HttpMethod.Head, WireRoutes.ArticleMediaPreview, owner, ct, await Preview(restored.Revision)));
            var publishedDraft = await CommandDraft(WireRoutes.Publish, owner,
                Wire.EncodeArticleCommand(new(draft.Id, restored.Revision, Guid.NewGuid(), "", "")));
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, null, ct, await Preview(publishedDraft.Revision));
            Assert.DoesNotContain("draft-preview", await OkString(client.GetAsync($"/article/{draft.Id}", ct), ct));
            Assert.Equal(3L, await db.Scalar<long>("SELECT count(*) FROM public.article_revision_media WHERE asset_id=$1", asset));

            var jpeg = pdf ? EncodeImage(SKEncodedImageFormat.Jpeg, 24, 12) : EncodeImage(SKEncodedImageFormat.Jpeg);
            var second = await UploadAsset(client, owner, Guid.NewGuid(), "second.jpg", "image/jpeg", jpeg, ct);
            var secondBytes = await File.ReadAllBytesAsync(Path.Combine(root, $"{second:N}.media"), ct);
            var both = await ChangeSecondImage(publishedDraft.Revision, true);
            var single = await ChangeSecondImage(both.Revision, false);
            var selectedPair = $"{second:D},{asset:D}";
            var markup = await OkString(Export("html", single.Revision, both.Revision, owner, null, selection: selectedPair), ct);
            var bodies = new Dictionary<DocumentExportFormat, byte[]> { [DocumentExportFormat.Html] = Encoding.UTF8.GetBytes(markup) };
            foreach (var (format, extension, resourceDirectory) in new[]
            {
                (DocumentExportFormat.Docx, "docx", "word/media/"),
                (DocumentExportFormat.Epub, "epub", "EPUB/images/")
            })
            {
                var bytes = bodies[format] = await OkBytes(Export(extension, single.Revision, both.Revision, owner, null, selection: selectedPair), ct);
                using var archive = OpenZip(bytes);
                var images = archive.Entries.Where(entry => entry.FullName.StartsWith(resourceDirectory, StringComparison.Ordinal)).ToArray();
                Assert.Equal(new[] { "attachment-1.jpeg", "attachment-2.png" }, images.Select(image => image.Name));
                Assert.Equal(secondBytes, await ReadEntry(images[0]));
                Assert.Equal(normalized, await ReadEntry(images[1]));
            }
            if (pdf)
            {
                using var direct = Ok(await Export("pdf", single.Revision, both.Revision, owner, null, selection: selectedPair));
                bodies.Add(DocumentExportFormat.Pdf, await ReadPdf(direct));
                foreach (var (status, expRev, selRev, sel) in new[]
                {
                    (Conflict, both.Revision, both.Revision, selectedPair),
                    (NotFound, single.Revision, single.Revision, selectedPair),
                    (NotFound, single.Revision, both.Revision, $"{second:D},{foreign:D}"),
                })
                    await ExpectExportFailure("pdf", "application/pdf", status, expRev, selRev, owner, null, selection: sel);
            }
            var figures = Regex.Matches(markup, """<img src="data:image/(jpeg|png);base64,([^"]+)" alt="([^"]+)"[^>]*>""");
            Assert.Equal(new[] { ("jpeg", Convert.ToBase64String(secondBytes), "second.jpg"),
                ("png", Convert.ToBase64String(normalized), "draft &amp; proof.png") },
                figures.Select(image => (image.Groups[1].Value, image.Groups[2].Value, image.Groups[3].Value)));
            foreach (var (format, revision, ids, status) in new[]
            {
                ("html", both.Revision, $"{asset:D},{asset:D}", BadRequest),
                ("html", both.Revision, $"{asset:D},{foreign:D}", NotFound),
                ("html", single.Revision, selectedPair, NotFound),
                ("docx", both.Revision, $"{asset:D},{foreign:D}", NotFound)
            })
                Assert.DoesNotContain("data:image/", await ExpectString(status, Export(format, single.Revision, revision, owner, null, selection: ids), ct));
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                Assert.DoesNotContain("data:image/", await ExpectString(ServiceUnavailable,
                    Export("html", single.Revision, both.Revision, owner, null, selection: selectedPair), ct));
                if (pdf) await ExpectExportFailure("pdf", "application/pdf", ServiceUnavailable,
                    single.Revision, both.Revision, owner, null, selection: selectedPair);
            }, ct);

            var externalDraft = await CommandDraft(WireRoutes.Save, owner, Wire.EncodeArticleCommand(
                new(draft.Id, single.Revision, Guid.NewGuid(), "Edited body", "![remote](https://export.invalid/photo.png)")));
            await ExpectExportFailure("epub", "application/epub+zip", BadRequest, externalDraft.Revision, externalDraft.Revision, owner, asset);
            Assert.Equal(epubBytes, await OkBytes(Export("epub", externalDraft.Revision, saved.Revision, owner, asset), ct));

            var jobInput = new DocumentExportCreate(Guid.NewGuid(), draft.Id, externalDraft.Revision, saved.Revision, DocumentExportFormat.Html);
            var frame = Wire.EncodeDocumentExportCreate(jobInput);
            await DocumentExportPostgresTests.HoldClaim(db, jobInput.Id, ct);
            var receipt = await CommandTask(frame, asset);
            Assert.Equal((jobInput, (byte)3, DocumentExportState.Queued), (receipt.Request, receipt.Provider, receipt.State));
            Assert.Equal(receipt.SourceDigest, (await CommandTask(frame, asset)).SourceDigest);
            await CheckStatusAsync(Conflict, Command(WireRoutes.DocumentExportCreate, owner, frame));
            var plainRequest = jobInput with { Id = Guid.NewGuid() };
            await CheckStatusAsync(NotFound, Command(WireRoutes.DocumentExportCreate, owner, Wire.EncodeDocumentExportCreate(plainRequest), foreign));
            await CheckStatusAsync(NotFound, Command(WireRoutes.DocumentExportCreate, owner,
                Wire.EncodeDocumentExportCreate(plainRequest with { SourceRevision = detached.Revision }), asset));
            Assert.Equal(2, (await CommandTask(Wire.EncodeDocumentExportCreate(plainRequest))).Provider);

            // The plain v2 receipt above already proved that no attachment was selected. Free its owner quota.
            Assert.Equal(1, await db.Exec("delete from public.author_document_export where id=$1", plainRequest.Id));
            // The existing fixture covers queued DOCX separately. Leave a quota slot for the native PDF.
            var bundleTasks = bodies.Keys.Where(format => !pdf || format != DocumentExportFormat.Docx).Select(format => jobInput with
                { Id = Guid.NewGuid(), SourceRevision = both.Revision, Format = format }).ToArray();
            foreach (var task in bundleTasks)
            {
                var bundleFrame = Wire.EncodeDocumentExportCreate(task);
                Assert.Equal(4, (await CommandTask(bundleFrame, selection: selectedPair)).Provider);
                await CheckStatusAsync(Conflict, Command(WireRoutes.DocumentExportCreate, owner, bundleFrame, selection: $"{asset:D},{second:D}"));
            }

            await RestartServer(() => DocumentExportPostgresTests.ReleaseClaim(db, ct));

            var listPath = WireRoutes.DocumentExportTaskList.Replace("{id:int}", draft.Id.ToString(CultureInfo.InvariantCulture));
            DocumentExportTask finished;
            DocumentExportTask[] finishedBundles;
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
            wait.CancelAfter(TimeSpan.FromSeconds(15));
            do
            {
                var rows = Wire.DecodeDocumentExportTaskList(await OkBytes(Send(client, HttpMethod.Get, listPath, owner, wait.Token), wait.Token));
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
                    var pdfReceipt = JsonNode.Parse(await ExportResponseFixture.Receipt(client, task.Request.Id, owner.Token, owner.SiteSessionId, OK, ct))!;
                    Assert.Equal(("Attachments", Digest("Original body."u8.ToArray()), Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_SHA256")),
                        ((string?)pdfReceipt["metadata"]?["title"], (string?)pdfReceipt["bodySha256"], (string?)pdfReceipt["toolchainSha256"]));
                    AssertReceiptAssets(pdfReceipt);
                    if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PDF_IMAGE_EVIDENCE") is { } evidence)
                    {
                        await File.WriteAllBytesAsync(Path.Combine(evidence, "direct.pdf"), bodies[DocumentExportFormat.Pdf], ct);
                        await File.WriteAllBytesAsync(Path.Combine(evidence, "queued.pdf"), bytes, ct);
                    }
                }
                else Assert.Equal(bodies[task.Request.Format], await deliveredBundle.Content.ReadAsByteArrayAsync(ct));
            }
            var batch = Assert.Single(finishedBundles, task => task.Request.Format == DocumentExportFormat.Html);
            var batchReceipt = await ResultReceipt(OK);
            var receiptManifest = JsonNode.Parse(batchReceipt)!;
            Assert.Equal((Convert.ToHexStringLower(batch.SourceDigest), Digest(bodies[DocumentExportFormat.Html])),
                ((string?)receiptManifest["sourceSha256"], (string?)receiptManifest["output"]?["sha256"]));
            AssertReceiptAssets(receiptManifest);
            var download = Wire.EncodeDocumentExportTaskRef(jobInput.Id);
            byte[] renderedBytes;
            using (var rendered = Ok(await Command(WireRoutes.DocumentExportDownload, owner, download)))
            {
                Assert.Equal((true, true), (rendered.Headers.CacheControl?.Private, rendered.Headers.CacheControl?.NoStore));
                Assert.Contains("img-src data:", Assert.Single(rendered.Headers.GetValues("Content-Security-Policy")));
                renderedBytes = await rendered.Content.ReadAsByteArrayAsync(ct);
            }
            Assert.Equal(SHA256.HashData(renderedBytes), finished.OutputDigest);
            var renderedHtml = Encoding.UTF8.GetString(renderedBytes);
            Assert.Contains("Original body.", renderedHtml);
            Assert.DoesNotContain("Edited body", renderedHtml);
            Assert.Contains("data:image/png;base64," + Convert.ToBase64String(normalized), renderedHtml);
            Assert.Equal(asset, await db.Scalar<Guid>("select attachment_id from public.author_document_export where id=$1", jobInput.Id));
            await MediaFixture.WithReplacedReadOnlyFile(leaf, held, changed, async () =>
            {
                await CheckStatusAsync(ServiceUnavailable, Command(WireRoutes.DocumentExportDownload, owner, download));
                await ResultReceipt(ServiceUnavailable);
                foreach (var task in bundleTasks)
                    Assert.DoesNotContain("data:image/", await ExpectString(ServiceUnavailable,
                        Command(WireRoutes.DocumentExportDownload, owner, Wire.EncodeDocumentExportTaskRef(task.Id)), ct));
            }, ct);
            await RestartServer();
            Assert.Equal(renderedBytes, await OkBytes(Command(WireRoutes.DocumentExportDownload, owner, download), ct));
            Assert.Equal(batchReceipt, await ResultReceipt(OK));

            void AssertReceiptAssets(JsonNode manifest) =>
                Assert.Equal(new[] { (second, Digest(secondBytes)), (asset, Digest(normalized)) },
                    manifest["assets"]!.AsArray().Select(entry => (entry!["id"]!.GetValue<Guid>(), (string)entry["sha256"]!)));

            async Task RestartServer(Func<Task>? between = null)
            {
                var prior = server;
                server = null;
                await prior!.DisposeAsync();
                if (between is not null) await between();
                server = await ServerProcess.Start(db.ConnectionString, ct, settings);
                client = server.Client;
            }

            Task<byte[]> ResultReceipt(HttpStatusCode status) =>
                ExportResponseFixture.Receipt(client, batch.Request.Id, owner.Token, owner.SiteSessionId, status, ct);

            static string Digest(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

            Task<Draft> ChangeSecondImage(long current, bool attachImage) => CommandDraft(WireRoutes.ArticleMediaCommand, owner,
                Wire.EncodeArticleMediaCommand(new(draft.Id, current, Guid.NewGuid(), second, attachImage)));

            async Task<Draft> CommandDraft(string path, MediaFixture.Session actor, byte[] bytes) =>
                Wire.DecodeDraft(await OkBytes(Command(path, actor, bytes), ct));

            async Task<DocumentExportTask> CommandTask(byte[] bytes, Guid? image = null, string? selection = null) =>
                Wire.DecodeDocumentExportTask(await OkBytes(Command(WireRoutes.DocumentExportCreate, owner, bytes, image, selection), ct));

            async Task<HttpResponseMessage> Command(string path, MediaFixture.Session actor, byte[] bytes, Guid? image = null, string? selection = null)
            {
                using var request = SiteAedsFixture.Request(HttpMethod.Post, path, bytes, actor.Token, actor.SiteSessionId);
                if ((selection ?? image?.ToString("D")) is { } ids) request.Headers.Add(WireHeaders.HtmlExportAttachment, ids);
                return await client.SendAsync(request, ct);
            }

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
                using var unavailable = Expect(status, await Export(format, expected, selected, actor, image, handle, selection));
                Assert.NotEqual(mediaType, unavailable.Content.Headers.ContentType?.MediaType);
            }

            async Task<byte[]> ReadPdf(HttpResponseMessage response)
            {
                ExportResponseFixture.Attachment(response, "application/pdf", "article.pdf", noStore: true);
                var bytes = await response.Content.ReadAsByteArrayAsync(ct);
                ExportResponseFixture.AssertPdfBytes(bytes);
                return bytes;
            }

            async Task<byte[]> ReadEntry(ZipArchiveEntry entry)
            {
                using var part = entry.Open();
                using var bytes = new MemoryStream();
                await part.CopyToAsync(bytes, ct);
                return bytes.ToArray();
            }

            async Task<string> Preview(long revision)
            {
                var path = WireRoutes.ArticleMedia.Replace("{id:int}", $"{draft.Id}", StringComparison.Ordinal);
                var payload = Aeds.Decode(await OkBytes(Send(client, HttpMethod.Get, $"{path}?revision={revision}", owner, ct), ct), FrameType.ArticleMedia);
                Assert.Equal((1, asset, 91), (BinaryPrimitives.ReadInt32LittleEndian(payload[12..]),
                    new Guid(payload[16..32], bigEndian: true), BinaryPrimitives.ReadInt32LittleEndian(payload[32..])));
                return Encoding.UTF8.GetString(payload[36..]);
            }

            async Task AssertSaturatedPreviewIsHidden(string validTicket)
            {
                await using var blocker = await db.DataSource.OpenConnectionAsync(ct);
                await using var heldRow = await blocker.BeginTransactionAsync(ct);
                Assert.Equal(asset, Assert.IsType<Guid>(await FixtureSql.ScalarAsync(blocker, heldRow, ct,
                    "select id from public.private_media where id=$1 for update", asset)));

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
                    await db.WaitForBlocked(blocker.ProcessID, reads.Length, probe.Token);
                    await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, probe.Token, validTicket);
                }
                finally
                {
                    await heldRow.RollbackAsync(CancellationToken.None);
                    completed = await Task.WhenAll(reads);
                }
                Assert.All(completed, status => Assert.Equal(OK, status));
            }
        }
        finally { if (server is not null) await server.DisposeAsync(); }
    }

    [PostgresFact]
    public async Task ResumablePartsPersistAcrossRestartAndFinalizeOnlyVerifiedPrivateBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "resume-owner", ct, canAuthor: true);
        var foreign = await MediaFixture.CreateSession(db.DataSource, "resume-other", ct, canAuthor: true);
        var reader = await MediaFixture.CreateSession(db.DataSource, "resume-reader", ct, canAuthor: false);
        using var directory = MediaFixture.OwnedTempDirectory("fsusblog-media-parts-");
        var settings = new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = directory.FullName, [MediaUploadEndpoints.Setting] = "true" };
        const int partSize = 65536;
        var image = new byte[partSize + 19];
        EncodeImage(SKEncodedImageFormat.Png).CopyTo(image, 0);
        var key = Guid.NewGuid();
        Guid upload;
        await using (var server = await ServerProcess.Start(db.ConnectionString, ct, settings))
        {
            var client = server.Client;
            await CheckStatusAsync(Unauthorized, Begin(client, reader, key, "resumable.png", image, ct));
            using (var advertised = Ok(await Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct)))
                Assert.Equal("1", Assert.Single(advertised.Headers.GetValues(WireHeaders.PrivateMediaResumable)));
            await CheckStatusAsync(UnsupportedMediaType, Begin(client, owner, key, "resumable.webp",
                EncodeImage(SKEncodedImageFormat.Webp), ct, type: "image/webp"));
            await CheckStatusAsync(Conflict, Begin(client, foreign, key, "resumable.png", image, ct, owner));
            upload = await BeginState(client, owner, key, "resumable.png", image, [], ct);
            await CheckStatusAsync(Conflict, Begin(client, owner, key, "changed.png", image, ct));
            await CheckStatusAsync(NotFound, Send(client, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), foreign, ct));
            await CheckStatusAsync(BadRequest, Part(client, owner, upload, 1, 0, image[partSize..], ct));
            await CheckStatusAsync(BadRequest, Part(client, owner, upload, 1, partSize, image[partSize..], ct, new byte[32]));
            Assert.Equal(upload, await PartState(client, owner, upload, 1, partSize, image[partSize..], [1], ct));
            Assert.Equal(upload, await PartState(client, owner, upload, 1, partSize, image[partSize..], [1], ct));
            await CheckStatusAsync(Conflict, Part(client, owner, upload, 1, partSize, Enumerable.Repeat((byte)9, 19).ToArray(), ct));
            await CheckPost(client, Conflict, WireRoutes.PrivateMediaUploadFinalize, upload, owner, ct);
            Assert.Empty(directory.Directory.EnumerateFiles());
        }

        await using var resumedServer = await ServerProcess.Start(db.ConnectionString, ct, settings);
        var resumed = resumedServer.Client;
        Assert.Equal(upload, await BeginState(resumed, owner, key, "resumable.png", image, [1], ct));
        Assert.Equal(upload, await PartState(resumed, owner, upload, 0, 0, image[..partSize], [0, 1], ct));
        await CheckPost(resumed, NotFound, WireRoutes.PrivateMediaUploadFinalize, upload, foreign, ct);
        var approvals = await Task.WhenAll(
            OkBytes(PostId(resumed, WireRoutes.PrivateMediaUploadFinalize, upload, owner, ct), ct),
            OkBytes(PostId(resumed, WireRoutes.PrivateMediaUploadFinalize, upload, owner, ct), ct));
        var asset = First(approvals[0], 1);
        Assert.Equal(asset, First(approvals[1], 1));
        Assert.Equal(asset, First(await OkBytes(PostId(resumed, WireRoutes.PrivateMediaUploadFinalize, upload, owner, ct), ct), 1));
        Assert.Equal(upload, await StateFrom(Send(resumed, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, upload), owner, ct), [], ct, asset));
        var raw = PathFor(WireRoutes.PrivateMediaRead, asset);
        await AssertHidden(resumed, HttpMethod.Get, raw, foreign, ct);
        AssertDimensions(await OkBytes(Send(resumed, HttpMethod.Get, raw, owner, ct), ct), 3, 2);
        AssertOwnedLeaf(directory.Directory, asset);

        var different = image.ToArray();
        different[^1] = 5;
        var other = await BeginState(resumed, owner, Guid.NewGuid(), "digest.png", different, [], ct);
        await CheckStatusAsync(OK, Part(resumed, owner, other, 0, 0, image[..partSize], ct));
        await CheckStatusAsync(OK, Part(resumed, owner, other, 1, partSize, image[partSize..], ct));
        await CheckPost(resumed, Conflict, WireRoutes.PrivateMediaUploadFinalize, other, owner, ct);
        await CheckPost(resumed, OK, WireRoutes.PrivateMediaUploadCancel, other, owner, ct);
        Assert.Equal(0L, await db.Scalar<long>("SELECT count(*) FROM public.private_media_upload_part"));

        List<Guid> held = [];
        for (var i = 0; i < 4; i++)
            held.Add(await BeginState(resumed, owner, Guid.NewGuid(), "staged.png", image, [], ct));
        await CheckStatusAsync(Conflict, Begin(resumed, owner, Guid.NewGuid(), "held.png", image, ct));
        Assert.Equal(held[0], await PartState(resumed, owner, held[0], 1, partSize, image[partSize..], [1], ct));
        Assert.Equal(1, await db.Exec("UPDATE public.private_media_upload SET expires_at=now()-interval '1 second' WHERE id=$1", held[0]));
        Assert.NotEqual(held[0], await BeginState(resumed, owner, Guid.NewGuid(), "replacement.png", image, [], ct));
        await CheckStatusAsync(NotFound, Send(resumed, HttpMethod.Get, PathFor(WireRoutes.PrivateMediaUploadStatus, held[0]), owner, ct));
        Assert.Equal(0L, await db.Scalar<long>("SELECT count(*) FROM public.private_media_upload_part"));
        Assert.Single(directory.Directory.EnumerateFiles());
    }

    [PostgresFact]
    public async Task PendingUploadCanResumeAndDeletionRefusesUnownedFileBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "media-owner", ct, canAuthor: true);
        using var directory = MediaFixture.OwnedTempDirectory("fsusblog-media-recovery-");
        var storage = directory.FullName;
        var png = EncodeImage(SKEncodedImageFormat.Png);
        var command = Guid.NewGuid();
        Guid reserved;
        using (var files = new MediaFiles(storage, AppContext.BaseDirectory))
        {
            var media = new MediaStore(files);
            var image = await MediaImage.ReadAsync(new MemoryStream(png), png.Length, "pending.png", MediaFormat.Png, ct);
            reserved = await db.InTx((conn, tx) => media.Reserve(conn, tx, owner.Id, command, image, ct), ct);
            // Model a process interrupted after the immutable path exists but before the DB made it readable.
            await files.Materialize(reserved, image, ct);
        }

        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage });
        var raw = PathFor(WireRoutes.PrivateMediaRead, reserved);
        await AssertHidden(server.Client, HttpMethod.Head, raw, owner, ct);
        Assert.Equal(reserved, await UploadAsset(server.Client, owner, command, "pending.png", "image/png", png, ct));

        var leaf = Assert.Single(directory.Directory.EnumerateFiles());
        var original = await File.ReadAllBytesAsync(leaf.FullName, ct);
        var unrelated = new byte[original.Length];
        await MediaFixture.WriteReadOnlyFile(leaf.FullName, unrelated, ct);
        await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);
        await CheckPost(server.Client, InternalServerError, WireRoutes.PrivateMediaRemove, reserved, owner, ct);
        Assert.Equal(unrelated, await File.ReadAllBytesAsync(leaf.FullName, ct));
        await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);

        await MediaFixture.WriteReadOnlyFile(leaf.FullName, original, ct);
        await CheckPost(server.Client, OK, WireRoutes.PrivateMediaRemove, reserved, owner, ct);
        Assert.Empty(directory.Directory.EnumerateFiles());
    }

    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    private static void AssertOwnedLeaf(DirectoryInfo directory, Guid asset)
    {
        var leaf = Assert.Single(directory.EnumerateFiles());
        Assert.Equal(($"{asset:N}.media", UnixFileMode.UserRead), (leaf.Name, File.GetUnixFileMode(leaf.FullName)));
    }

    private static void AssertDimensions(byte[] bytes, int width, int height)
    {
        using var bitmap = SKBitmap.Decode(bytes);
        Assert.Equal((width, height), (bitmap.Width, bitmap.Height));
    }

    private static byte[] EncodeImage(SKEncodedImageFormat format, int width = 3, int height = 2)
    {
        if (width == 3 && height == 2) return MediaFixture.SolidImage(format, SKColors.SteelBlue);
        using var image = new SKBitmap(width, height);
        var random = new Random(233);
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
                image.SetPixel(x, y, new SKColor((uint)random.Next(1 << 24) | 0xff000000));
        image.SetPixel(0, 0, SKColors.Transparent);
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

    private static Task<HttpResponseMessage> PostId(HttpClient client, string route, Guid id, MediaFixture.Session actor, CancellationToken ct) =>
        Send(client, HttpMethod.Post, PathFor(route, id), actor, ct);

    private static Task CheckPost(HttpClient client, HttpStatusCode status, string route, Guid id, MediaFixture.Session actor, CancellationToken ct) =>
        CheckStatusAsync(status, PostId(client, route, id, actor, ct));

    private static async Task<Guid> UploadAsset(HttpClient client, MediaFixture.Session session, Guid key, string name, string type,
        byte[] bytes, CancellationToken ct) => First(await OkBytes(Upload(client, session, key, name, type, bytes, ct), ct), 1);

    private static Task<Guid> BeginState(HttpClient client, MediaFixture.Session actor, Guid key, string name, byte[] image,
        int[] parts, CancellationToken ct, string type = "image/png") =>
        StateFrom(Begin(client, actor, key, name, image, ct, type: type), parts, ct);

    private static Task<Guid> PartState(HttpClient client, MediaFixture.Session actor, Guid id, int part, int offset,
        byte[] bytes, int[] parts, CancellationToken ct) =>
        StateFrom(Part(client, actor, id, part, offset, bytes, ct), parts, ct);

    private static async Task<Guid> StateFrom(Task<HttpResponseMessage> response, int[] parts, CancellationToken ct, Guid? completed = null)
    {
        var payload = Aeds.Decode(await OkBytes(response, ct), FrameType.PrivateMediaUploadState);
        Assert.Equal((65536, completed.HasValue ? (byte)1 : (byte)0), (BinaryPrimitives.ReadInt32LittleEndian(payload[20..]), payload[33]));
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
        using var request = SiteAedsFixture.Request(HttpMethod.Post, $"{path}?offset={offset}", bytes, actor.Token, actor.SiteSessionId);
        request.Headers.Add(WireHeaders.PrivateMediaDigest, Convert.ToHexString(wrongHash ?? SHA256.HashData(bytes)));
        return await client.SendAsync(request, ct);
    }

    private static async Task AssertHidden(HttpClient client, HttpMethod method, string path, MediaFixture.Session? session,
        CancellationToken ct, string? previewTicket = null, bool range = false)
    {
        using var response = Expect(NotFound, await Send(client, method, path, session, ct, previewTicket, range));
        Assert.Equal((0L, (MediaTypeHeaderValue?)null, true, true, "no-cache", "nosniff", "no-referrer"),
            (response.Content.Headers.ContentLength, response.Content.Headers.ContentType, response.Headers.CacheControl?.Private,
                response.Headers.CacheControl?.NoStore, Assert.Single(response.Headers.Pragma).Name,
                Assert.Single(response.Headers.GetValues("X-Content-Type-Options")),
                Assert.Single(response.Headers.GetValues("Referrer-Policy"))));
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
