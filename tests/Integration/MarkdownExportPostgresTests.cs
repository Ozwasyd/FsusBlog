using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;

public sealed class MarkdownExportPostgresTests
{
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

        await Command("delete from public.user_session where digest=$1", SHA256.HashData(Convert.FromHexString(owner)));
        await Read(export, owner, HttpStatusCode.Unauthorized);

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

    private static string PathFor(Draft draft, long selected) =>
        FormattableString.Invariant($"/api/v2/authoring/draft/{draft.Id}/export.md?revision={draft.Revision}&sourceRevision={selected}");
}
