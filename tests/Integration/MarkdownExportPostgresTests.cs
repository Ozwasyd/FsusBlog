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
        Assert.Contains("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; form-action 'none'\">", html);
        Assert.Contains("<title>Saved &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; title</title>", html);
        Assert.Contains("<h2>Earlier outline</h2>", html);
        Assert.Contains("<strong>emphasis</strong>", html);
        Assert.Contains("<li>First item</li>", html);
        Assert.Contains("&lt;iframe src=", html);
        Assert.Contains("&lt;img src=", html);
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
        Assert.Contains("<thead>", html, StringComparison.Ordinal);
        Assert.Contains("<tbody>", html, StringComparison.Ordinal);
        Assert.Contains("<td><strong>Saved</strong></td>", html, StringComparison.Ordinal);
        Assert.Contains("<td style=\"text-align: right;\">12</td>", html, StringComparison.Ordinal);
        Assert.Contains("&lt;img src=", html, StringComparison.Ordinal);
        Assert.DoesNotContain("<img", html, StringComparison.Ordinal);
        Assert.Contains("<table>", HtmlDocumentExport.RenderBody("Recorded", source, "PDF", CancellationToken.None), StringComparison.Ordinal);
        var legacy = Encoding.UTF8.GetString(HtmlDocumentExport.Write("Recorded", source, CancellationToken.None, includeTables: false));
        Assert.DoesNotContain("<table>", legacy, StringComparison.Ordinal);
        Assert.Contains("| Item | Units |", legacy, StringComparison.Ordinal);
        Assert.Contains("| --- | ---: |", legacy, StringComparison.Ordinal);

        const string unsafeCell = "| Item | Units |\n| --- | --- |\n| ![Remote](https://export.invalid/) | 12 |";
        Assert.Throws<BusinessException>(() => HtmlDocumentExport.Write("Recorded", unsafeCell, CancellationToken.None));
        Assert.Throws<BusinessException>(() =>
            HtmlDocumentExport.RenderBody("Recorded", unsafeCell, "PDF", CancellationToken.None));
    }

    [PostgresFact]
    public async Task ExportsOnlyTheRequestedSavedOwnerRevisionAsAnUncachedAttachment()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(1));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
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

        using (var shellRequest = new HttpRequestMessage(HttpMethod.Get, "/admin/articles/write"))
        {
            shellRequest.Headers.Host = ServerProcess.DefaultAdminHost;
            using var shell = await server.Client.SendAsync(shellRequest, ct);
            shell.EnsureSuccessStatusCode();
            Assert.DoesNotContain("fsus-pdf-export", await shell.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }
        await ReadPdf(server.Client, PathFor(current, older.Revision, "pdf"), owner, HttpStatusCode.NotFound, ct);

        await Read(PathFor(current, current.Revision), owner, HttpStatusCode.OK, currentTitle, currentBody, current.Revision);
        await Read(export, owner, HttpStatusCode.OK, olderTitle, olderBody, older.Revision);
        var word = export.Replace("export.md", "export.docx", StringComparison.Ordinal);
        await ReadWord(word, owner, HttpStatusCode.OK, olderTitle, "No trailing newline", "<script>literal document text</script>");
        await ReadWord(word, outsider, HttpStatusCode.NotFound);
        await ReadWord(word, null, HttpStatusCode.Unauthorized);
        await ReadWord(word, reader, HttpStatusCode.Unauthorized);
        await ReadWord(PathFor(older, older.Revision).Replace("export.md", "export.docx", StringComparison.Ordinal), owner, HttpStatusCode.Conflict);
        var html = PathFor(current, older.Revision, "html");
        var savedHtml = await ReadHtml(html, owner, HttpStatusCode.OK);
        Assert.Contains("<h1>原文", savedHtml, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;literal document text&lt;/script&gt;", savedHtml, StringComparison.Ordinal);
        Assert.DoesNotContain(currentTitle, savedHtml, StringComparison.Ordinal);
        Assert.Equal(savedHtml, await ReadHtml(html, owner, HttpStatusCode.OK));
        var currentHtml = PathFor(current, current.Revision, "html");
        Assert.Contains(currentTitle, await ReadHtml(currentHtml, owner, HttpStatusCode.OK), StringComparison.Ordinal);
        await ReadHtml(html, null, HttpStatusCode.Unauthorized);
        await ReadHtml(html, outsider, HttpStatusCode.NotFound);
        await ReadHtml(html, reader, HttpStatusCode.Unauthorized);
        await ReadHtml(PathFor(older, older.Revision, "html"), owner, HttpStatusCode.Conflict);
        await ReadHtml(html + "&revision=2", owner, HttpStatusCode.BadRequest);
        var epub = PathFor(current, older.Revision, "epub");
        var savedEpub = await ReadEpub(epub, owner, HttpStatusCode.OK);
        await using (var modification = Store.Sql(db, null, """
            select to_char(happened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
            from public.article_revision where article_id=$1 and revision=$2
            """, older.Id, older.Revision))
        {
            var modified = Assert.IsType<string>(await modification.ExecuteScalarAsync(ct));
            var chapter = EpubDocumentExportTests.AssertFile(savedEpub, olderTitle, modified);
            Assert.Contains("No trailing newline", chapter.Root!.Value, StringComparison.Ordinal);
            Assert.DoesNotContain(currentTitle, chapter.Root.Value, StringComparison.Ordinal);
        }
        Assert.Equal(savedEpub, await ReadEpub(epub, owner, HttpStatusCode.OK));
        await ReadEpub(epub, null, HttpStatusCode.Unauthorized);
        await ReadEpub(epub, outsider, HttpStatusCode.NotFound);
        await ReadEpub(epub, reader, HttpStatusCode.Unauthorized);
        await ReadEpub(PathFor(older, older.Revision, "epub"), owner, HttpStatusCode.Conflict);
        var sourceWithLink = await Save(0, 0, "Unexportable image", "![External](https://export.invalid/no)");
        var linkedHtml = PathFor(sourceWithLink, sourceWithLink.Revision, "html");
        await ReadHtml(linkedHtml, owner, HttpStatusCode.BadRequest, "Offline HTML supports basic text Markdown");
        await ReadEpub(PathFor(sourceWithLink, sourceWithLink.Revision, "epub"), owner, HttpStatusCode.BadRequest);
        await Read(export, null, HttpStatusCode.Unauthorized);
        await Read(export, outsider, HttpStatusCode.NotFound);
        await Read(export, reader, HttpStatusCode.Unauthorized);
        await Read(PathFor(older, older.Revision), owner, HttpStatusCode.Conflict);
        await Read(PathFor(current, current.Revision + 1), owner, HttpStatusCode.BadRequest);
        await Read(export + "&revision=2", owner, HttpStatusCode.BadRequest);
        await Read(export.Replace($"/draft/{current.Id}/", "/draft/0/", StringComparison.Ordinal), owner, HttpStatusCode.BadRequest);

        using var unpublished = await server.Client.GetAsync($"/article/{current.Id}", ct);
        Assert.Equal(HttpStatusCode.NotFound, unpublished.StatusCode);

        using (var remove = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.Delete,
            Wire.EncodeArticleCommand(new(current.Id, current.Revision, Guid.NewGuid(), "", "")), owner, handle: null))
        {
            using var response = await server.Client.SendAsync(remove, ct);
            response.EnsureSuccessStatusCode();
        }
        await Read(export, owner, HttpStatusCode.NotFound);
        await ReadWord(word, owner, HttpStatusCode.NotFound);
        await ReadHtml(html, owner, HttpStatusCode.NotFound);
        await ReadEpub(epub, owner, HttpStatusCode.NotFound);

        await FixtureSql.ExecuteAsync(db, null, ct, "delete from public.admin_session where digest=$1", SHA256.HashData(Convert.FromHexString(owner)));
        await Read(export, owner, HttpStatusCode.Unauthorized);
        await ReadWord(word, owner, HttpStatusCode.Unauthorized);
        await ReadHtml(linkedHtml, owner, HttpStatusCode.Unauthorized);

        async Task<byte[]> ReadEpub(string path, string? token, HttpStatusCode status)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path,
                null, token, null, status, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (status == HttpStatusCode.OK)
            {
                ExportResponseFixture.Attachment(response, "application/epub+zip", "article.epub");
            }
            else
            {
                ExportResponseFixture.AedsWithoutAttachment(response);
                Assert.DoesNotContain("https://export.invalid/no", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
            }
            return bytes;
        }

        async Task<string> ReadHtml(string path, string? token, HttpStatusCode status, string? error = null)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path,
                null, token, null, status, ct);
            if (status != HttpStatusCode.OK)
            {
                ExportResponseFixture.AedsWithoutAttachment(response);
                var message = Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct));
                Assert.DoesNotContain("literal document text", message, StringComparison.Ordinal);
                Assert.DoesNotContain("https://export.invalid/no", message, StringComparison.Ordinal);
                if (error is not null) Assert.Contains(error, message, StringComparison.Ordinal);
                return "";
            }
            ExportResponseFixture.Attachment(response, "text/html", "article.html");
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            Assert.Equal("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                Assert.Single(response.Headers.GetValues("Content-Security-Policy")));
            return await response.Content.ReadAsStringAsync(ct);
        }

        async Task ReadWord(string path, string? token, HttpStatusCode status, params string[] expected)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path,
                null, token, null, status, ct);
            if (status != HttpStatusCode.OK)
            {
                ExportResponseFixture.AedsWithoutAttachment(response);
                return;
            }
            ExportResponseFixture.Attachment(response, FsusBlog.V2.Server.Authoring.WordDocumentExport.ContentType, "article.docx");
            WordDocumentExportTests.AssertFile(await response.Content.ReadAsByteArrayAsync(ct), expected);
        }

        Task<Draft> Save(int id, long revision, string title, string body) =>
            SiteAedsFixture.SaveDraft(server.Client, owner, null, id, revision, title, body, ct);

        async Task Read(string path, string? token, HttpStatusCode status, string? title = null, string? body = null, long revision = 0)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(server.Client, HttpMethod.Get, path,
                null, token, null, status, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (status != HttpStatusCode.OK)
            {
                ExportResponseFixture.AedsWithoutAttachment(response);
                Assert.DoesNotContain(olderTitle, Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
                Assert.DoesNotContain("literal document text", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
                return;
            }
            ExportResponseFixture.Attachment(response, "text/markdown", "article.md");
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            var text = Encoding.UTF8.GetString(bytes);
            var closing = text.IndexOf("\n---\n", StringComparison.Ordinal);
            var fields = text[..closing].Split('\n');
            Assert.Equal(4, fields.Length);
            Assert.Equal("---", fields[0]);
            Assert.Equal("fsusFormat: fsusblog-markdown-v2", fields[1]);
            Assert.Equal(title, JsonSerializer.Deserialize<string>(fields[2]["title: ".Length..]));
            Assert.Equal($"revision: {revision.ToString(CultureInfo.InvariantCulture)}", fields[3]);
            Assert.Equal(Encoding.UTF8.GetBytes(body!), bytes[Encoding.UTF8.GetByteCount(text.AsSpan(0, closing + 5))..]);
        }
    }

    [PdfPostgresFact]
    public async Task PdfExportsOnlyTheAuthorizedSelectedRevision()
    {
        var connection = Environment.GetEnvironmentVariable(ScratchDatabase.Variable);
        Assert.False(string.IsNullOrWhiteSpace(connection), $"Set {ScratchDatabase.Variable} to run PDF integration.");
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_ROOT")), "Set FSUSBLOG_PDF_TOOL_ROOT.");
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FSUSBLOG_PDF_TOOL_SHA256")), "Set FSUSBLOG_PDF_TOOL_SHA256.");
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(connection!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = (await fixture.SignIn("PDF owner", ct, canAuthor: true)).Token;
        var outsider = (await fixture.SignIn("PDF outsider", ct, canAuthor: true)).Token;
        var reader = (await fixture.SignIn("PDF reader", ct, canAuthor: false)).Token;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        using (var request = SiteAedsFixture.AdminRequest(HttpMethod.Get, "/admin/articles/write", owner))
        using (var shell = await server.Client.SendAsync(request, ct))
        {
            shell.EnsureSuccessStatusCode();
            Assert.Contains("name=\"fsus-pdf-export\"", await shell.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        var older = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, "保留的中文标题",
            "## 旧稿保留的段落\n\n打印文字。\n\n| 项目 | 数量 |\n| --- | ---: |\n| 保存的表格 | 12 |", ct);
        var current = await SiteAedsFixture.SaveDraft(server.Client, owner, null, older.Id, older.Revision, "Newer private text", "Current version only.", ct);
        var path = PathFor(current, older.Revision, "pdf");
        var saved = await ReadPdf(server.Client, path, owner, HttpStatusCode.OK, ct);
        var latest = await ReadPdf(server.Client, PathFor(current, current.Revision, "pdf"), owner, HttpStatusCode.OK, ct);
        Assert.False(saved.AsSpan().SequenceEqual(latest));
        await ReadPdf(server.Client, path, null, HttpStatusCode.Unauthorized, ct);
        await ReadPdf(server.Client, path, outsider, HttpStatusCode.NotFound, ct);
        await ReadPdf(server.Client, path, reader, HttpStatusCode.Unauthorized, ct);
        await ReadPdf(server.Client, PathFor(older, older.Revision, "pdf"), owner, HttpStatusCode.Conflict, ct);
        await ReadPdf(server.Client, path + "&revision=2", owner, HttpStatusCode.BadRequest, ct);

        var linked = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, "PDF link fixture", "![Remote](https://export.invalid/no)", ct);
        await ReadPdf(server.Client, PathFor(linked, linked.Revision, "pdf"), owner, HttpStatusCode.BadRequest, ct);
        var glyph = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, "PDF glyph fixture", "Unsupported glyph \U0010FFFD", ct);
        await ReadPdf(server.Client, PathFor(glyph, glyph.Revision, "pdf"), owner, HttpStatusCode.BadRequest, ct);
        var oversized = await SiteAedsFixture.SaveDraft(server.Client, owner, null, 0, 0, "PDF size fixture", new string('字', 256 * 1024 / 3 + 1), ct);
        await ReadPdf(server.Client, PathFor(oversized, oversized.Revision, "pdf"), owner, HttpStatusCode.BadRequest, ct);

        await FixtureSql.ExecuteAsync(db, null, ct, "delete from public.admin_session where digest=$1", SHA256.HashData(Convert.FromHexString(owner)));
        await ReadPdf(server.Client, path, owner, HttpStatusCode.Unauthorized, ct);
    }

    private static async Task<byte[]> ReadPdf(HttpClient client, string path, string? token, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Get, path,
            null, token, null, status, ct);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (status != HttpStatusCode.OK)
        {
            ExportResponseFixture.AedsWithoutAttachment(response);
            var message = Encoding.UTF8.GetString(Aeds.Decode(bytes, FrameType.ApiError));
            Assert.DoesNotContain("旧稿保留的段落", message, StringComparison.Ordinal);
            Assert.DoesNotContain("Newer private text", message, StringComparison.Ordinal);
            Assert.DoesNotContain("https://export.invalid/no", message, StringComparison.Ordinal);
            return bytes;
        }
        ExportResponseFixture.Attachment(response, "application/pdf", "article.pdf");
        Assert.InRange(bytes.Length, 100, 4 * 1024 * 1024);
        Assert.Equal("%PDF-", Encoding.ASCII.GetString(bytes, 0, 5));
        Assert.EndsWith("%%EOF", Encoding.ASCII.GetString(bytes, bytes.Length - 16, 16).TrimEnd(), StringComparison.Ordinal);
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
