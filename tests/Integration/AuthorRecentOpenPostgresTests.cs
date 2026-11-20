using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;

public sealed class AuthorRecentOpenPostgresTests
{
    [PostgresFact]
    public async Task OpenWitnessesAreExactScopedAndIdempotentAcrossConcurrentCommands()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var store = new Store(db.DataSource);
        var author = await Login("Recent open author", true);
        var other = await Login("Another author", true);
        var reader = await Login("Recent open reader", false);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        const string body = "PRIVATE BODY NEVER RETURNED IN RECENT OPENS";
        var first = await Change(author, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Duplicate title", body));
        var second = await Change(author, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Duplicate title", body));
        var foreign = await Change(other, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Private other title", body));
        Assert.Empty((await Page(author)).Rows);
        Assert.Equal(0, (await Page(author)).Revision);
        using (var rawDraft = await Send(HttpMethod.Get, WireRoutes.Draft.Replace("{id:int}", first.Id.ToString()), author))
            Assert.Equal(HttpStatusCode.OK, rawDraft.StatusCode);
        Assert.Equal(0, (await Page(author)).Revision);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, reader, null, HttpStatusCode.Unauthorized);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, new(author.Token, other.Handle), null, HttpStatusCode.Conflict);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author, Frame(foreign, 0), HttpStatusCode.NotFound);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author, Frame(first with { Revision = first.Revision + 1 }, 0), HttpStatusCode.Conflict);

        var original = new AuthorRecentOpenCommand(1, 0, Guid.NewGuid(), first.Id, first.Revision);
        var receipt = await Command(author, original);
        Assert.Equal(original.RequestId, receipt.RequestId);
        Assert.Equal(1, receipt.Revision);
        Assert.True(receipt.OpenedAtUnixMs > 0);
        Assert.Equal(receipt, await Command(author, original));
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author,
            Wire.EncodeAuthorRecentOpenCommand(original with { ArticleId = second.Id, ArticleRevision = second.Revision }), HttpStatusCode.Conflict);

        var secondKey = Guid.NewGuid();
        var thirdKey = Guid.NewGuid();
        var winners = await Task.WhenAll(Compete(first, secondKey), Compete(second, thirdKey));
        Assert.Equal(1, winners.Count(status => status == HttpStatusCode.OK));
        Assert.Equal(1, winners.Count(status => status == HttpStatusCode.Conflict));
        var winner = (await Page(author)).Rows[0];
        Assert.Equal(winners[0] == HttpStatusCode.OK ? first.Id : second.Id, winner.ArticleId);
        Assert.Equal(2, winner.Sequence);
        var next = await Command(author, new(1, 2, Guid.NewGuid(), second.Id, second.Revision));
        var updated = await Change(author, WireRoutes.Save, new(first.Id, first.Revision, Guid.NewGuid(), "Edited title", body));
        Assert.Equal(receipt, await Command(author, original));
        var changed = await Page(author);
        Assert.Equal(3, changed.Revision);
        Assert.Equal(new[] { second.Id, first.Id }, changed.Rows.Select(item => item.ArticleId));
        Assert.Equal(next.OpenedAtUnixMs, changed.Rows[0].OpenedAtUnixMs);
        Assert.Equal(first.Revision, changed.Rows[1].ArticleRevision);
        Assert.Equal(updated.Title, changed.Rows[1].Title);
        Assert.Empty((await Page(other)).Rows);
        await Check(HttpMethod.Post, WireRoutes.Delete, author,
            Wire.EncodeArticleCommand(new(second.Id, second.Revision, Guid.NewGuid(), "", "")), HttpStatusCode.OK);
        Assert.Equal(first.Id, Assert.Single((await Page(author)).Rows).ArticleId);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author,
            Frame(second, 3), HttpStatusCode.NotFound);

        var head = 3L;
        for (var index = 0; index < WireLimits.AuthorRecentOpenPageSize; index++)
        {
            var article = await Change(author, WireRoutes.Save, new(0, 0, Guid.NewGuid(), $"Visit {index}", body));
            head = (await Command(author, new(1, head, Guid.NewGuid(), article.Id, article.Revision))).Revision;
        }
        var page = await Page(author);
        Assert.Equal(head, page.Revision);
        Assert.Equal(WireLimits.AuthorRecentOpenPageSize, page.Rows.Count);
        Assert.Equal(WireLimits.AuthorRecentOpenCursorChars, page.Next.Length);
        var cursor = $"?cursor={page.Next}";
        Assert.Equal(first.Id, Assert.Single((await Page(author, cursor)).Rows).ArticleId);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + cursor, other, null, HttpStatusCode.BadRequest);
        var tampered = (page.Next[0] == 'A' ? "B" : "A") + page.Next[1..];
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + $"?cursor={tampered}", author, null, HttpStatusCode.BadRequest);
        await Command(author, new(1, head, Guid.NewGuid(), updated.Id, updated.Revision));
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + cursor, author, null, HttpStatusCode.Conflict);
        await db.SignOutAdmin(author.Token, ct);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, author, null, HttpStatusCode.Unauthorized);

        async Task<HttpStatusCode> Compete(Draft draft, Guid key)
        {
            using var response = await Send(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author,
                Wire.EncodeAuthorRecentOpenCommand(new(1, 1, key, draft.Id, draft.Revision)));
            return response.StatusCode;
        }

        async Task<Credential> Login(string name, bool canAuthor)
        {
            var (_, token, handle) = await db.SignIn(name, ct, canAuthor, minutes: 1);
            return new(token, handle);
        }

        async Task<Draft> Change(Credential user, string route, ArticleCommand command) =>
            Wire.DecodeDraft(await Check(HttpMethod.Post, route, user, Wire.EncodeArticleCommand(command), HttpStatusCode.OK));
        async Task<AuthorRecentOpenReceipt> Command(Credential user, AuthorRecentOpenCommand command) =>
            Wire.DecodeAuthorRecentOpenReceipt(await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, user,
                Wire.EncodeAuthorRecentOpenCommand(command), HttpStatusCode.OK));

        async Task<(long Revision, string Next, IReadOnlyList<AuthorRecentOpenRow> Rows)> Page(Credential user, string query = "")
        {
            var bytes = await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + query, user, null, HttpStatusCode.OK);
            Assert.DoesNotContain(body, System.Text.Encoding.UTF8.GetString(bytes));
            using var reader = new BinaryReader(new MemoryStream(Aeds.Decode(bytes, FrameType.AuthorRecentOpenPage).ToArray()));
            Assert.Equal(1, reader.ReadInt32());
            var revision = reader.ReadInt64();
            var next = System.Text.Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32()));
            var rows = new AuthorRecentOpenRow[reader.ReadInt32()];
            for (var index = 0; index < rows.Length; index++)
                rows[index] = new(reader.ReadInt32(), reader.ReadInt64(), reader.ReadInt64(), reader.ReadInt64(),
                    System.Text.Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32())));
            Assert.Equal(reader.BaseStream.Length, reader.BaseStream.Position);
            return (revision, next, rows);
        }

        Task<byte[]> Check(HttpMethod method, string path, Credential user, byte[]? frame, HttpStatusCode status) =>
            SiteAedsFixture.ExpectPrivate(server.Client, method, path, frame, user.Token, user.Handle, status, ct);

        async Task<HttpResponseMessage> Send(HttpMethod method, string path, Credential user, byte[]? frame = null)
        {
            using var request = SiteAedsFixture.Request(method, path, frame, user.Token, user.Handle);
            return await server.Client.SendAsync(request, ct);
        }
    }

    private static byte[] Frame(Draft value, long revision) =>
        Wire.EncodeAuthorRecentOpenCommand(new(1, revision, Guid.NewGuid(), value.Id, value.Revision));
    private sealed record Credential(string Token, string Handle);
}
