using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;

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

    [PostgresFact]
    public async Task ExportsOnlyTheRequestedSavedOwnerRevisionAsAnUncachedAttachment()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new Store(fixture.DataSource);
        var owner = await Account("Markdown owner", true);
        var outsider = await Account("Markdown outsider", true);
        var reader = await Account("Markdown reader", false);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        const string olderTitle = "'---: &foo # [x] \\";
        const string olderBody = "\r\n---\r\n# 原文 📝\n<script>literal document text</script>\r\nNo trailing newline";
        var older = await Save(0, 0, olderTitle, olderBody);
        const string currentTitle = "Updated private title";
        const string currentBody = "Body from saved revision\n\n";
        var current = await Save(older.Id, older.Revision, currentTitle, currentBody);
        var export = PathFor(current, older.Revision);

        await Read(PathFor(current, current.Revision), owner, HttpStatusCode.OK, currentTitle, currentBody, current.Revision);
        await Read(export, owner, HttpStatusCode.OK, olderTitle, olderBody, older.Revision);
        var word = export.Replace("export.md", "export.docx", StringComparison.Ordinal);
        await ReadWord(word, owner, HttpStatusCode.OK, olderTitle, "No trailing newline", "<script>literal document text</script>");
        await ReadWord(word, outsider, HttpStatusCode.NotFound);
        await ReadWord(word, null, HttpStatusCode.Unauthorized);
        await ReadWord(word, reader, HttpStatusCode.Forbidden);
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
        await ReadHtml(html, reader, HttpStatusCode.Forbidden);
        await ReadHtml(PathFor(older, older.Revision, "html"), owner, HttpStatusCode.Conflict);
        await ReadHtml(html + "&revision=2", owner, HttpStatusCode.BadRequest);
        var sourceWithLink = await Save(0, 0, "Unexportable image", "![External](https://export.invalid/no)");
        var linkedHtml = PathFor(sourceWithLink, sourceWithLink.Revision, "html");
        await ReadHtml(linkedHtml, owner, HttpStatusCode.BadRequest, "Offline HTML supports basic text Markdown");
        await Read(export, null, HttpStatusCode.Unauthorized);
        await Read(export, outsider, HttpStatusCode.NotFound);
        await Read(export, reader, HttpStatusCode.Forbidden);
        await Read(PathFor(older, older.Revision), owner, HttpStatusCode.Conflict);
        await Read(PathFor(current, current.Revision + 1), owner, HttpStatusCode.BadRequest);
        await Read(export + "&revision=2", owner, HttpStatusCode.BadRequest);
        await Read(export.Replace($"/draft/{current.Id}/", "/draft/0/", StringComparison.Ordinal), owner, HttpStatusCode.BadRequest);

        using var unpublished = await server.Client.GetAsync($"/article/{current.Id}", ct);
        Assert.Equal(HttpStatusCode.NotFound, unpublished.StatusCode);

        using (var remove = new HttpRequestMessage(HttpMethod.Post, WireRoutes.Delete)
        {
            Content = new ByteArrayContent(Wire.EncodeArticleCommand(new(current.Id, current.Revision, Guid.NewGuid(), "", "")))
        })
        {
            remove.Headers.Add("Cookie", $"fsus-v2-session={owner}");
            remove.Content.Headers.ContentType = new(Aeds.ContentType);
            using var response = await server.Client.SendAsync(remove, ct);
            response.EnsureSuccessStatusCode();
        }
        await Read(export, owner, HttpStatusCode.NotFound);
        await ReadWord(word, owner, HttpStatusCode.NotFound);
        await ReadHtml(html, owner, HttpStatusCode.NotFound);

        await Command("delete from public.user_session where digest=$1", SHA256.HashData(Convert.FromHexString(owner)));
        await Read(export, owner, HttpStatusCode.Unauthorized);
        await ReadWord(word, owner, HttpStatusCode.Unauthorized);
        await ReadHtml(linkedHtml, owner, HttpStatusCode.Unauthorized);

        async Task<string> ReadHtml(string path, string? token, HttpStatusCode status, string? error = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            if (status != HttpStatusCode.OK)
            {
                Assert.Null(response.Content.Headers.ContentDisposition);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                var message = Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct));
                Assert.DoesNotContain("literal document text", message, StringComparison.Ordinal);
                Assert.DoesNotContain("https://export.invalid/no", message, StringComparison.Ordinal);
                if (error is not null) Assert.Contains(error, message, StringComparison.Ordinal);
                return "";
            }
            Assert.True(response.Headers.CacheControl?.Private);
            Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
            Assert.Equal("article.html", response.Content.Headers.ContentDisposition?.FileNameStar);
            Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
            Assert.Equal("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                Assert.Single(response.Headers.GetValues("Content-Security-Policy")));
            return await response.Content.ReadAsStringAsync(ct);
        }

        async Task ReadWord(string path, string? token, HttpStatusCode status, params string[] expected)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            if (status != HttpStatusCode.OK)
            {
                Assert.Null(response.Content.Headers.ContentDisposition);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                return;
            }
            Assert.True(response.Headers.CacheControl?.Private);
            Assert.Equal(FsusBlog.V2.Server.Authoring.WordDocumentExport.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
            Assert.Equal("article.docx", response.Content.Headers.ContentDisposition?.FileNameStar);
            Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
            WordDocumentExportTests.AssertFile(await response.Content.ReadAsByteArrayAsync(ct), expected);
        }

        async Task<Draft> Save(int id, long revision, string title, string body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, WireRoutes.Save)
            {
                Content = new ByteArrayContent(Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body)))
            };
            request.Headers.Add("Cookie", $"fsus-v2-session={owner}");
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            using var response = await server.Client.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();
            return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task Read(string path, string? token, HttpStatusCode status, string? title = null, string? body = null, long revision = 0)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (status != HttpStatusCode.OK)
            {
                Assert.Null(response.Content.Headers.ContentDisposition);
                Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                Assert.DoesNotContain(olderTitle, Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
                Assert.DoesNotContain("literal document text", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
                return;
            }
            Assert.True(response.Headers.CacheControl?.Private);
            Assert.Equal("text/markdown", response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
            Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
            Assert.Equal("article.md", response.Content.Headers.ContentDisposition?.FileNameStar);
            Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
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

        async Task<string> Account(string name, bool canAuthor)
        {
            var id = Guid.NewGuid();
            await Command("insert into public.blog_user (id,name,can_author,enabled,generation) values ($1,$2,$3,true,1)", id, name, canAuthor);
            var ticket = RandomNumberGenerator.GetBytes(32);
            await Command("insert into public.login_ticket values ($1,$2,now()+interval '2 minutes')", SHA256.HashData(ticket), id);
            return (await store.SignIn(Convert.ToHexStringLower(ticket), ct)).Token;
        }

        async Task Command(string sql, params object[] values)
        {
            await using var command = Store.Sql(db, null, sql, values);
            await command.ExecuteNonQueryAsync(ct);
        }
    }

    private static string PathFor(Draft draft, long selected, string format = "md") =>
        FormattableString.Invariant($"/api/v2/authoring/draft/{draft.Id}/export.{format}?revision={draft.Revision}&sourceRevision={selected}");
}
