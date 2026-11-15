using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSummaryPostgresTests
{
    [PostgresFact]
    public async Task SummaryUsesTheOwnedSavedRevisionAndPublishesOnlyItsImmutableValue()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var store = new Store(db.DataSource);
        var owner = await SignIn("Summary owner");
        var stranger = await SignIn("Summary stranger");
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);

        const string title = "Draft title";
        const string body = "body-prefix-fallback 中文";
        const string marker = "summaryonlyword";
        const string manual = marker + " 🧭 e\u0301\n二行";
        var first = await Change(ArticleAction.Save, 0, 0, title, body);
        Assert.Equal(new ArticleSummary(first.Id, first.Revision, ""), await Read(first.Id, first.Revision));

        var command = new ArticleSummaryCommand(first.Id, first.Revision, Guid.NewGuid(), "  " + manual + " \n");
        var packet = Wire.EncodeArticleSummaryCommand(command);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, HttpStatusCode.NotFound, stranger);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet, HttpStatusCode.Conflict, owner with { Handle = null });
        var saved = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet));
        Assert.Equal(new Draft(first.Id, first.Revision + 1, title, body, false), saved);
        Assert.Equal(packet, Wire.EncodeArticleSummaryCommand(Wire.DecodeArticleSummaryCommand(packet)));
        Assert.Equal(saved, Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, packet)));
        Assert.Equal(new ArticleSummary(saved.Id, saved.Revision, manual), await Read(saved.Id, saved.Revision));
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, first.Revision), null, HttpStatusCode.Conflict);
        await Send(HttpMethod.Get, SummaryUrl(saved.Id, saved.Revision), null, HttpStatusCode.NotFound, stranger);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { Text = "changed" }),
            HttpStatusCode.Conflict);
        await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(command with { IdempotencyKey = Guid.NewGuid() }),
            HttpStatusCode.Conflict);
        Assert.Equal(1, await Count("title-summary"));
        Assert.Equal(0, await Count("title"));
        Assert.DoesNotContain(marker, await PublicIndex());

        var edited = await Change(ArticleAction.Save, saved.Id, saved.Revision, title, body + " second source");
        Assert.Equal(manual, (await Read(edited.Id, edited.Revision)).Text);
        var published = await Change(ArticleAction.Publish, edited.Id, edited.Revision);
        await WaitForIndex(marker, "next-summary");

        var revised = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(
            new(published.Id, published.Revision, Guid.NewGuid(), "next-summary"))));
        Assert.Equal("next-summary", (await Read(revised.Id, revised.Revision)).Text);
        await WaitForIndex(marker, "next-summary");

        var restored = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.DraftRollback,
            Wire.EncodeDraftRollback(new(revised.Id, revised.Revision, saved.Revision, Guid.NewGuid(), "Restore saved summary"))));
        Assert.Equal((body, manual), (restored.Body, (await Read(restored.Id, restored.Revision)).Text));

        var cleared = Wire.DecodeDraft(await Send(HttpMethod.Post, WireRoutes.ArticleSummarySave, Wire.EncodeArticleSummaryCommand(
            new(restored.Id, restored.Revision, Guid.NewGuid(), " \t\r\n "))));
        Assert.Equal("", (await Read(cleared.Id, cleared.Revision)).Text);
        Assert.Equal(0, await Count("title-summary"));
        await Change(ArticleAction.Publish, cleared.Id, cleared.Revision);
        await WaitForIndex("body-prefix-fallback", marker);

        async Task<int> Count(string match)
        {
            var frame = await Send(HttpMethod.Get, $"{WireRoutes.AuthorArticles}?match={match}&keyword={marker}");
            return BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(frame, FrameType.AuthorArticlePage));
        }

        async Task<ArticleSummary> Read(int id, long revision) =>
            Wire.DecodeArticleSummary(await Send(HttpMethod.Get, SummaryUrl(id, revision)));

        async Task<ArticleState> Change(ArticleAction action, int id, long revision, string nextTitle = "", string nextBody = "") =>
            (await store.WithSession(owner.Token, true, (conn, tx, actor) => Store.Execute(conn, tx, actor, action,
                new(id, revision, Guid.NewGuid(), nextTitle, nextBody), ct), ct)).Article;

        async Task<string> PublicIndex()
        {
            using var response = await server.Client.GetAsync(WireRoutes.PublicIndex, ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.ServiceUnavailable) return "";
            response.EnsureSuccessStatusCode();
            return Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct));
        }

        async Task WaitForIndex(string present, string absent)
        {
            for (var attempt = 0; attempt < 80; attempt++)
            {
                var observed = await PublicIndex();
                if (observed.Contains(present, StringComparison.Ordinal) && !observed.Contains(absent, StringComparison.Ordinal)) return;
                await Task.Delay(100, ct);
            }
            throw new InvalidOperationException($"Published index never returned the expected summary {present}.");
        }

        async Task<byte[]> Send(HttpMethod method, string route, byte[]? frame = null, HttpStatusCode status = HttpStatusCode.OK,
            Actor? caller = null)
        {
            caller ??= owner;
            using var request = new HttpRequestMessage(method, route);
            if (frame is not null)
            {
                request.Content = new ByteArrayContent(frame);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            }
            request.Headers.Add("Cookie", $"fsus-v2-session={caller.Token}");
            if (caller.Handle is not null) request.Headers.Add(WireHeaders.CurrentSession, caller.Handle);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<Actor> SignIn(string name)
        {
            var id = Guid.NewGuid();
            var key = RandomNumberGenerator.GetBytes(32);
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            await using var seed = Store.Sql(connection, null, """
                with owner as (insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,1) returning id)
                insert into public.login_ticket(digest,user_id,expires_at) select $3,id,now()+interval '2 minutes' from owner
                """, id, name, SHA256.HashData(key));
            await seed.ExecuteNonQueryAsync(ct);
            var token = (await store.SignIn(Convert.ToHexStringLower(key), ct)).Token;
            return new(token, SiteSessions.Id(id, Store.TokenDigest(token)!));
        }
    }

    private static string SummaryUrl(int id, long revision) => $"{WireRoutes.ArticleSummary.Replace("{id:int}", id.ToString(), StringComparison.Ordinal)}?revision={revision}";

    private sealed record Actor(string Token, string? Handle);
}
