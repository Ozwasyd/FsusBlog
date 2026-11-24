public sealed class MarkdownExportPostgresTests
{
    [Fact]
    public void OfflineHtmlRendersSafeMarkdownWithoutExecutableOrLoadingElements()
    {
        const string title = "Saved </title><script>alert(1)</script> & title";
        const string source = """
            ## Earlier outline

            A paragraph with **emphasis** and a literal &.

            - First item
            - Second item

            ```html
            <iframe src="https://export.invalid/blocked"></iframe>
            ```

            <img src="https://export.invalid/blocked" onerror="alert(1)">
            """;
        var bytes = HtmlDocumentExport.Write(title, source, CancellationToken.None);
        Assert.Equal(bytes, HtmlDocumentExport.Write(title, source, CancellationToken.None));
        var html = Encoding.UTF8.GetString(bytes);
        Assert.StartsWith("<!doctype html>\n<html>", html, StringComparison.Ordinal);
        foreach (var expected in new[]
        {
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; form-action 'none'\">",
            "<title>Saved &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; title</title>",
            "<h2>Earlier outline</h2>",
            "<strong>emphasis</strong>",
            "<li>First item</li>",
            "&lt;iframe src=",
            "&lt;img src=",
        })
            Assert.Contains(expected, html);
        foreach (var element in new[] { "<script", "<iframe", "<img", "<a ", "<link", "<style", "<base", "<form" })
            Assert.DoesNotContain(element, html, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("[outside](https://export.invalid/no)")]
    [InlineData("[fragment](#local)")]
    [InlineData("<https://export.invalid/no>")]
    [InlineData("<author@export.invalid>")]
    [InlineData("![local](/api/v2/authoring/media/sample)")]
    [InlineData("![referenced][image]\n\n[image]: https://export.invalid/no")]
    [InlineData("[unused]: https://export.invalid/no")]
    [InlineData("```MERMAID\ngraph TD; A --> B;\n```")]
    [InlineData("~~~katex\nx = 1\n~~~")]
    public void OfflineHtmlRejectsRecognizedUnsupportedSource(string markdown)
    {
        var error = Assert.Throws<BusinessException>(() => HtmlDocumentExport.Write("Saved", markdown, CancellationToken.None));
        Assert.Equal(Rejection.Invalid, error.Rejection);
    }

    [Fact]
    public void OfflineHtmlRejectsOversizedInputOutputAndCancellation()
    {
        Assert.Throws<BusinessException>(() => HtmlDocumentExport.Write("Saved", new string('x', WireLimits.BodyBytes + 1), CancellationToken.None));
        var escapedOutput = Assert.Throws<BusinessException>(() =>
            HtmlDocumentExport.Write("Saved", new string('&', WireLimits.BodyBytes), CancellationToken.None));
        Assert.Equal("This revision exceeds the offline HTML size limit.", escapedOutput.Message);
        Assert.Throws<OperationCanceledException>(() => HtmlDocumentExport.Write("Saved", "Body", new CancellationToken(true)));
    }

    [Fact]
    public void OfflineHtmlAndPdfRenderPipeTablesWithoutLoadingElements()
    {
        const string source = """
            | Item | Units |
            | --- | ---: |
            | **Saved** | 12 |
            | <img src="https://export.invalid/"> | |
            """;
        var html = Encoding.UTF8.GetString(HtmlDocumentExport.Write("Recorded", source, CancellationToken.None));
        foreach (var expected in new[] { "<thead>", "<tbody>", "<td><strong>Saved</strong></td>", "<td style=\"text-align: right;\">12</td>", "&lt;img src=" })
            Assert.Contains(expected, html, StringComparison.Ordinal);
        Assert.DoesNotContain("<img", html, StringComparison.Ordinal);
        Assert.Contains("<table>", HtmlDocumentExport.RenderBody("Recorded", source, "PDF", CancellationToken.None), StringComparison.Ordinal);
        var legacy = Encoding.UTF8.GetString(HtmlDocumentExport.Write("Recorded", source, CancellationToken.None, includeTables: false));
        Assert.DoesNotContain("<table>", legacy, StringComparison.Ordinal);
        Assert.Contains("| Item | Units |", legacy, StringComparison.Ordinal);
        Assert.Contains("| --- | ---: |", legacy, StringComparison.Ordinal);

        const string unsafeCell = "| Item | Units |\n| --- | --- |\n| ![Remote](https://export.invalid/) | 12 |";
        Assert.Throws<BusinessException>(() => HtmlDocumentExport.Write("Recorded", unsafeCell, CancellationToken.None));
        Assert.Throws<BusinessException>(() => HtmlDocumentExport.RenderBody("Recorded", unsafeCell, "PDF", CancellationToken.None));
    }

    [PostgresFact]
    public async Task ExportsOnlyTheRequestedSavedOwnerRevisionAsAnUncachedAttachment()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var owner = (await fixture.SignIn("Markdown owner", ct, canAuthor: true)).Token;
        var outsider = (await fixture.SignIn("Markdown outsider", ct, canAuthor: true)).Token;
        var reader = (await fixture.SignIn("Markdown reader", ct, canAuthor: false)).Token;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_PDF_TOOL_ROOT"] = "",
            ["FSUSBLOG_PDF_TOOL_SHA256"] = "",
        });

        const string olderTitle = "'---: &foo # [x] \\";
        const string olderBody = "\r\n---\r\n# 原文 📝\n<script>literal document text</script>\r\nNo trailing newline";
        var older = await Save(0, 0, olderTitle, olderBody);
        const string currentTitle = "Updated private title";
        const string currentBody = "Body from saved revision\n\n";
        var current = await Save(older.Id, older.Revision, currentTitle, currentBody);
        var export = PathFor(current, older.Revision);

        Assert.DoesNotContain("fsus-pdf-export",
            await OkString(SiteAedsFixture.AdminSend(server.Client, HttpMethod.Get, "/admin/articles/write", null, ct), ct),
            StringComparison.Ordinal);
        await ReadPdf(server.Client, PathFor(current, older.Revision, "pdf"), owner, NotFound, ct);

        await ReadMarkdown(PathFor(current, current.Revision), owner, OK, currentTitle, currentBody, current.Revision);
        await ReadMarkdown(export, owner, OK, olderTitle, olderBody, older.Revision);
        var word = PathFor(current, older.Revision, "docx");
        var wordBytes = await ReadExport(word, owner, OK, WordDocumentExport.ContentType, "article.docx");
        WordDocumentExportTests.AssertFile(wordBytes, olderTitle, "No trailing newline", "<script>literal document text</script>");
        var html = PathFor(current, older.Revision, "html");
        var savedHtml = await ReadHtml(html, owner, OK);
        Assert.Contains("<h1>原文", savedHtml, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;literal document text&lt;/script&gt;", savedHtml, StringComparison.Ordinal);
        Assert.DoesNotContain(currentTitle, savedHtml, StringComparison.Ordinal);
        Assert.Equal(savedHtml, await ReadHtml(html, owner, OK));
        Assert.Contains(currentTitle, await ReadHtml(PathFor(current, current.Revision, "html"), owner, OK), StringComparison.Ordinal);
        var epub = PathFor(current, older.Revision, "epub");
        var savedEpub = await ReadExport(epub, owner, OK, "application/epub+zip", "article.epub");
        var modified = await fixture.Scalar<string>("""
            select to_char(happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
            from public.article_revision where article_id=$1 and revision=$2
            """, older.Id, older.Revision);
        var chapter = EpubDocumentExportTests.AssertFile(savedEpub, olderTitle, modified);
        Assert.Contains("No trailing newline", chapter.Root!.Value, StringComparison.Ordinal);
        Assert.DoesNotContain(currentTitle, chapter.Root.Value, StringComparison.Ordinal);
        Assert.Equal(savedEpub, await ReadExport(epub, owner, OK, "application/epub+zip", "article.epub"));

        foreach (var format in new[] { "md", "docx", "html", "epub" })
        {
            var path = PathFor(current, older.Revision, format);
            foreach (var (target, token, status) in new (string, string?, HttpStatusCode)[]
            {
                (path, null, Unauthorized),
                (path, outsider, NotFound),
                (path, reader, Unauthorized),
                (PathFor(older, older.Revision, format), owner, Conflict),
            })
                await ReadExport(target, token, status, "", "");
        }
        await ReadExport(html + "&revision=2", owner, BadRequest, "", "");
        var sourceWithLink = await Save(0, 0, "Unexportable image", "![External](https://export.invalid/no)");
        var linkedHtml = PathFor(sourceWithLink, sourceWithLink.Revision, "html");
        await ReadExport(linkedHtml, owner, BadRequest, "", "", "Offline HTML supports basic text Markdown");
        await ReadExport(PathFor(sourceWithLink, sourceWithLink.Revision, "epub"), owner, BadRequest, "", "");
        foreach (var bad in new[] { PathFor(current, current.Revision + 1), export + "&revision=2", export.Replace($"/draft/{current.Id}/", "/draft/0/", StringComparison.Ordinal) })
            await ReadExport(bad, owner, BadRequest, "", "");

        await CheckStatusAsync(NotFound, server.Client.GetAsync($"/article/{current.Id}", ct));
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Post, WireRoutes.Delete,
            Wire.EncodeArticleCommand(new(current.Id, current.Revision, Guid.NewGuid(), "", "")), owner, null, OK, ct);
        foreach (var deletedPath in new[] { export, word, html, epub })
            await ReadExport(deletedPath, owner, NotFound, "", "");

        await fixture.Exec("delete from public.admin_session where digest=$1", Store.TokenDigest(owner)!);
        foreach (var unauthPath in new[] { export, word, linkedHtml })
            await ReadExport(unauthPath, owner, Unauthorized, "", "");

        async Task<string> ReadHtml(string path, string? token, HttpStatusCode status)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path, null, token, null, status, ct);
            ExportResponseFixture.Attachment(response, "text/html", "article.html");
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            Assert.Equal("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                Assert.Single(response.Headers.GetValues("Content-Security-Policy")));
            return await response.Content.ReadAsStringAsync(ct);
        }

        async Task<byte[]> ReadExport(string path, string? token, HttpStatusCode status, string mediaType, string fileName, string? error = null)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path, null, token, null, status, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (status != OK)
            {
                ExportResponseFixture.AedsWithoutAttachment(response);
                var message = Encoding.UTF8.GetString(bytes);
                foreach (var secret in new[] { olderTitle, "literal document text", "https://export.invalid/no" })
                    Assert.DoesNotContain(secret, message, StringComparison.Ordinal);
                if (error is not null) Assert.Contains(error, message, StringComparison.Ordinal);
                return bytes;
            }
            ExportResponseFixture.Attachment(response, mediaType, fileName);
            return bytes;
        }

        Task<Draft> Save(int id, long revision, string title, string body) =>
            SiteAedsFixture.SaveDraft(server.Client, owner, null, id, revision, title, body, ct);

        async Task ReadMarkdown(string path, string? token, HttpStatusCode status, string title, string body, long revision)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path, null, token, null, status, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            ExportResponseFixture.Attachment(response, "text/markdown", "article.md");
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            var text = Encoding.UTF8.GetString(bytes);
            var closing = text.IndexOf("\n---\n", StringComparison.Ordinal);
            var fields = text[..closing].Split('\n');
            Assert.Equal(4, fields.Length);
            Assert.Equal(("---", "fsusFormat: fsusblog-markdown-v2", title, $"revision: {revision.ToString(CultureInfo.InvariantCulture)}"),
                (fields[0], fields[1], JsonSerializer.Deserialize<string>(fields[2]["title: ".Length..]), fields[3]));
            Assert.Equal(Encoding.UTF8.GetBytes(body), bytes[Encoding.UTF8.GetByteCount(text.AsSpan(0, closing + 5))..]);
        }
    }

    [PdfPostgresFact]
    public async Task PdfExportsOnlyTheAuthorizedSelectedRevision()
    {
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)), $"Set {ScratchDatabase.Variable} to run PDF integration.");
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_ROOT")), "Set FSUSBLOG_PDF_TOOL_ROOT.");
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_SHA256")), "Set FSUSBLOG_PDF_TOOL_SHA256.");
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        var owner = (await fixture.SignIn("PDF owner", ct, canAuthor: true)).Token;
        var outsider = (await fixture.SignIn("PDF outsider", ct, canAuthor: true)).Token;
        var reader = (await fixture.SignIn("PDF reader", ct, canAuthor: false)).Token;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        Assert.Contains("name=\"fsus-pdf-export\"",
            await OkString(SiteAedsFixture.AdminSend(server.Client, HttpMethod.Get, "/admin/articles/write", owner, ct), ct),
            StringComparison.Ordinal);

        var older = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, "保留的中文标题",
            "## 旧稿保留的段落\n\n打印文字。\n\n| 项目 | 数量 |\n| --- | ---: |\n| 保存的表格 | 12 |", ct);
        var current = await SiteAedsFixture.SaveDraft(server.Client, owner, null, older.Id, older.Revision, "Newer private text", "Current version only.", ct);
        var path = PathFor(current, older.Revision, "pdf");
        var saved = await ReadPdf(server.Client, path, owner, OK, ct);
        var latest = await ReadPdf(server.Client, PathFor(current, current.Revision, "pdf"), owner, OK, ct);
        Assert.False(saved.AsSpan().SequenceEqual(latest));
        foreach (var (target, token, status) in new (string, string?, HttpStatusCode)[]
        {
            (path, null, Unauthorized), (path, outsider, NotFound), (path, reader, Unauthorized),
            (PathFor(older, older.Revision, "pdf"), owner, Conflict), (path + "&revision=2", owner, BadRequest),
        })
            await ReadPdf(server.Client, target, token, status, ct);

        foreach (var (title, body) in new[]
        {
            ("PDF link fixture", "![Remote](https://export.invalid/no)"),
            ("PDF glyph fixture", "Unsupported glyph \U0010FFFD"),
            ("PDF size fixture", new string('字', 256 * 1024 / 3 + 1)),
        })
        {
            var bad = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, title, body, ct);
            await ReadPdf(server.Client, PathFor(bad, bad.Revision, "pdf"), owner, BadRequest, ct);
        }

        await fixture.Exec("delete from public.admin_session where digest=$1", Store.TokenDigest(owner)!);
        await ReadPdf(server.Client, path, owner, Unauthorized, ct);
    }

    private static async Task<byte[]> ReadPdf(HttpClient client, string path, string? token, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Get, path, null, token, null, status, ct);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (status != OK)
        {
            ExportResponseFixture.AedsWithoutAttachment(response);
            var message = Encoding.UTF8.GetString(Aeds.Decode(bytes, FrameType.ApiError));
            foreach (var secret in new[] { "旧稿保留的段落", "Newer private text", "https://export.invalid/no" })
                Assert.DoesNotContain(secret, message, StringComparison.Ordinal);
            return bytes;
        }
        ExportResponseFixture.Attachment(response, "application/pdf", "article.pdf");
        Assert.InRange(bytes.Length, 100, 4 * 1024 * 1024);
        ExportResponseFixture.AssertPdfBytes(bytes);
        return bytes;
    }

    private static string PathFor(Draft draft, long selected, string format = "md") =>
        FormattableString.Invariant($"/api/v2/authoring/draft/{draft.Id}/export.{format}?revision={draft.Revision}&sourceRevision={selected}");
}

internal sealed class PdfPostgresFactAttribute : FactAttribute
{
    public PdfPostgresFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PDF") != "1")
            Skip = "Set FSUSBLOG_TEST_PDF=1 to run PDF integration with the pinned macOS renderer.";
    }
}
