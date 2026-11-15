using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

public sealed class PluginPreviewPostgresTests
{
    [PostgresFact]
    public async Task PreviewIsAbsentByDefault()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        using var shell = await server.Client.GetAsync("/user/manage/article/write", ct);
        shell.EnsureSuccessStatusCode();
        Assert.DoesNotContain("fsus-author-plugin-preview", await shell.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        using var response = await server.Client.PostAsync(PathFor(1, 1), null, ct);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [LinuxPluginPreviewFact]
    public async Task SignedWorkerPreviewsOnlyTheCurrentSavedAuthorRevisionOverHttps()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new Store(fixture.DataSource);
        var owner = await Login(db, store, "Preview owner", true, ct);
        var peer = await Login(db, store, "Preview peer", true, ct);
        var reader = await Login(db, store, "Preview reader", false, ct);
        var first = await Save(0, 0, "Body from an older revision");
        const string currentBody = "# 原文 📝\r\n\r\nSaved current Markdown.\n";
        var current = await Save(first.Id, first.Revision, currentBody);
        var large = await Save(0, 0, new string('ä', 8193));

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        var origin = FormattableString.Invariant($"https://127.0.0.1:{port}");
        var certificate = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PLUGIN_PREVIEW_CERT")!;
        using var pin = X509CertificateLoader.LoadPkcs12FromFile(certificate, "");
        var digest = pin.GetCertHash(HashAlgorithmName.SHA256);
        using var handler = new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false };
        handler.ServerCertificateCustomValidationCallback = (_, cert, _, errors) => cert is not null &&
            (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) == SslPolicyErrors.None &&
            CryptographicOperations.FixedTimeEquals(digest, cert.GetCertHash(HashAlgorithmName.SHA256));
        using var https = new HttpClient(handler) { BaseAddress = new Uri(origin) };
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["ASPNETCORE_URLS"] = "http://127.0.0.1:0;" + origin,
            ["Kestrel__Certificates__Default__Path"] = certificate,
            ["FSUSBLOG_PUBLIC_ORIGIN"] = origin,
            ["FSUSBLOG_AUTHOR_PLUGIN_PREVIEW_ID"] = "fixture.site.render",
        });
        using (var shell = await https.GetAsync("/user/manage/article/write", ct))
        {
            shell.EnsureSuccessStatusCode();
            Assert.Contains("<meta name=\"fsus-author-plugin-preview\" content=\"1\">", await shell.Content.ReadAsStringAsync(ct), StringComparison.Ordinal);
        }

        await Preview(https, current, owner, HttpStatusCode.Forbidden);
        var consent = await Grant(current);
        await Preview(https, large, owner, HttpStatusCode.Forbidden, grant: consent);
        await Preview(https, current, peer, HttpStatusCode.NotFound, grant: consent);
        await Preview(https, current, owner, HttpStatusCode.OK, grant: consent);
        await Preview(https, current, owner, HttpStatusCode.Forbidden, grant: consent);
        var registry = Environment.GetEnvironmentVariable("FSUSBLOG_PLATFORM_PLUGIN_ROOT")!;
        var approval = Path.Combine(registry, "platform-plugin.json");
        var withdrawn = Path.Combine(registry, "withdrawn-plugin.json");
        var beforeWithdrawal = await Grant(current);
        File.Move(approval, withdrawn);
        try { await Preview(https, current, owner, HttpStatusCode.ServiceUnavailable, grant: beforeWithdrawal); }
        finally { File.Move(withdrawn, approval); }
        var beforeRestore = await Grant(current);
        File.Move(approval, withdrawn);
        File.Move(withdrawn, approval);
        await Preview(https, current, owner, HttpStatusCode.ServiceUnavailable, grant: beforeRestore);
        await Preview(https, current, owner, HttpStatusCode.OK, grant: await Grant(current));
        var canceled = await Grant(current);
        await Preview(https, current, peer, HttpStatusCode.NotFound, grant: canceled, withdraw: true);
        await Preview(https, large, owner, HttpStatusCode.Forbidden, grant: canceled, withdraw: true);
        await Preview(https, current, owner, HttpStatusCode.Forbidden, sendOrigin: false, grant: canceled, withdraw: true);
        await Preview(https, current, owner, HttpStatusCode.NoContent, grant: canceled, withdraw: true);
        await Preview(https, current, owner, HttpStatusCode.Forbidden, grant: canceled);
        var firstOffer = await Grant(current);
        var latestOffer = await Grant(current);
        await Preview(https, current, owner, HttpStatusCode.Forbidden, grant: firstOffer, withdraw: true);
        await Preview(https, current, owner, HttpStatusCode.Forbidden, grant: firstOffer);
        await Preview(https, current, owner, HttpStatusCode.OK, grant: latestOffer);
        var beforeChange = await Grant(current);
        File.Move(approval, withdrawn);
        try
        {
            await File.WriteAllTextAsync(approval, (await File.ReadAllTextAsync(withdrawn, ct)) + "\n", ct);
            if (OperatingSystem.IsLinux()) File.SetUnixFileMode(approval, File.GetUnixFileMode(withdrawn));
            await Preview(https, current, owner, HttpStatusCode.ServiceUnavailable, grant: beforeChange);
            await Preview(https, current, owner, HttpStatusCode.OK, grant: await Grant(current));
        }
        finally { File.Move(withdrawn, approval, overwrite: true); }
        await Preview(https, current, null, HttpStatusCode.Unauthorized);
        await Preview(https, current, peer, HttpStatusCode.NotFound);
        await Preview(https, current, reader, HttpStatusCode.Forbidden);
        await Preview(https, current, owner with { Handle = peer.Handle }, HttpStatusCode.Conflict);
        await Preview(https, current, owner with { Handle = null }, HttpStatusCode.Conflict);
        await Preview(https, first, owner, HttpStatusCode.Conflict);
        await Preview(https, large, owner, HttpStatusCode.BadRequest, grant: await Grant(large));
        await Preview(https, current, owner, HttpStatusCode.BadRequest, body: new byte[] { 1 });
        await Preview(https, current, owner, HttpStatusCode.Forbidden, sendOrigin: false);
        await Preview(server.Client, current, owner, HttpStatusCode.Forbidden, sendOrigin: false);
        using (var unpublished = await https.GetAsync($"/article/{current.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, unpublished.StatusCode);

        await Execute(db, "delete from public.user_session where digest=$1", ct, Store.TokenDigest(owner.Token)!);
        await Preview(https, current, owner, HttpStatusCode.Unauthorized);
        await using var state = Store.Sql(db, null, "select body from public.article_revision where article_id=$1 and revision=$2", current.Id, current.Revision);
        Assert.Equal(currentBody, await state.ExecuteScalarAsync(ct));

        async Task<ArticleState> Save(int id, long revision, string markdown) =>
            (await store.WithSession(owner.Token, true, (connection, tx, actor) => Store.Execute(connection, tx, actor, ArticleAction.Save,
                new(id, revision, Guid.NewGuid(), "Private preview title", markdown), ct), ct)).Article;

        async Task<string> Grant(ArticleState article)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, PathFor(article.Id, article.Revision) + "&consent=1");
            request.Headers.Add("Cookie", $"fsus-v2-session={owner.Token}");
            request.Headers.Add(WireHeaders.CurrentSession, owner.Handle);
            request.Headers.Add("Origin", origin);
            using var response = await https.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
            Assert.True(response.Headers.CacheControl is { Private: true, NoStore: true });
            Assert.Equal("fixture.site.render", Assert.Single(response.Headers.GetValues("X-Fsus-Plugin-Id")));
            Assert.Matches("^[0-9]+\\.[0-9]+\\.[0-9]+$", Assert.Single(response.Headers.GetValues("X-Fsus-Plugin-Version")));
            Assert.Matches("^[0-9a-f]{64}$", Assert.Single(response.Headers.GetValues("X-Fsus-Plugin-Digest")));
            var permission = Assert.Single(response.Headers.GetValues("X-Fsus-Plugin-Consent"));
            Assert.Matches("^[0-9a-f]{64}$", permission);
            return permission;
        }

        async Task Preview(HttpClient client, ArticleState article, Actor? caller, HttpStatusCode expected, byte[]? body = null,
            bool sendOrigin = true, string? grant = null, bool withdraw = false)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post,
                PathFor(article.Id, article.Revision) + (withdraw ? "&consent=0" : ""));
            if (caller is not null) request.Headers.Add("Cookie", $"fsus-v2-session={caller.Token}");
            if (caller?.Handle is { } handle) request.Headers.Add(WireHeaders.CurrentSession, handle);
            if (sendOrigin) request.Headers.Add("Origin", origin);
            if (grant is not null) request.Headers.Add("X-Fsus-Plugin-Consent", grant);
            if (body is not null) request.Content = new ByteArrayContent(body);
            using var response = await client.SendAsync(request, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            if (expected == HttpStatusCode.OK)
            {
                Assert.True(response.Headers.CacheControl?.Private);
                Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
                Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
                Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
                Assert.Equal("same-origin", Assert.Single(response.Headers.GetValues("Cross-Origin-Resource-Policy")));
                Assert.Equal(Encoding.UTF8.GetBytes("# Signed preview\n" + currentBody), bytes);
            }
            else if (expected == HttpStatusCode.NoContent) Assert.Empty(bytes);
            else Assert.DoesNotContain("Saved current Markdown.", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
        }
    }

    private static async Task<Actor> Login(NpgsqlConnection db, Store store, string name, bool canAuthor, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Execute(db, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", ct, id, name, canAuthor);
        await Execute(db, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
            ct, SHA256.HashData(ticket), id);
        var token = (await store.SignIn(Convert.ToHexStringLower(ticket), ct)).Token;
        return new(token, SiteSessions.Id(id, Store.TokenDigest(token)!));
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct, params object[] values)
    {
        await using var command = Store.Sql(db, null, sql, values);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static string PathFor(int article, long revision) =>
        FormattableString.Invariant($"/api/v2/authoring/draft/{article}/plugin-preview.md?revision={revision}");

    private sealed record Actor(string Token, string? Handle);
}

internal sealed class LinuxPluginPreviewFactAttribute : FactAttribute
{
    public LinuxPluginPreviewFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("FSUSBLOG_TEST_PLUGIN_PREVIEW") != "1")
            Skip = "Requires an operator-staged Linux ARM64 plugin worker, signed test package, HTTPS certificate and disposable PostgreSQL.";
    }
}
