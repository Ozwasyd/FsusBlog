public sealed class AuthorRecentOpenPostgresTests
{
    [PostgresFact]
    public async Task OpenWitnessesAreExactScopedAndIdempotentAcrossConcurrentCommands()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var author = await db.SignIn("Recent open author", ct, true, minutes: 1);
        var other = await db.SignIn("Another author", ct, true, minutes: 1);
        var reader = await db.SignIn("Recent open reader", ct, false, minutes: 1);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        const string body = "PRIVATE BODY NEVER RETURNED IN RECENT OPENS";
        var first = await Save(author, "Duplicate title");
        var second = await Save(author, "Duplicate title");
        var foreign = await Save(other, "Private other title");
        Assert.Empty((await Page(author)).Rows);
        Assert.Equal(0, (await Page(author)).Revision);
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Get, WireRoutes.Draft.Replace("{id:int}", first.Id.ToString()), null, author.Token, author.Handle, OK, ct);
        Assert.Equal(0, (await Page(author)).Revision);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, reader.Token, reader.Handle, null, Unauthorized);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, author.Token, other.Handle, null, Conflict);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author.Token, author.Handle, Frame(foreign, 0), NotFound);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author.Token, author.Handle, Frame(first with { Revision = first.Revision + 1 }, 0), Conflict);

        var original = new AuthorRecentOpenCommand(1, 0, Guid.NewGuid(), first.Id, first.Revision);
        var receipt = await Command(author, original);
        Assert.Equal((original.RequestId, 1L), (receipt.RequestId, receipt.Revision));
        Assert.True(receipt.OpenedAtUnixMs > 0);
        Assert.Equal(receipt, await Command(author, original));
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author.Token, author.Handle,
            Wire.EncodeAuthorRecentOpenCommand(original with { ArticleId = second.Id, ArticleRevision = second.Revision }), Conflict);

        var winners = await Task.WhenAll(Compete(first, Guid.NewGuid()), Compete(second, Guid.NewGuid()));
        Assert.Equal((1, 1), (winners.Count(status => status == OK), winners.Count(status => status == Conflict)));
        var winner = (await Page(author)).Rows[0];
        Assert.Equal((winners[0] == OK ? first.Id : second.Id, 2L), (winner.ArticleId, winner.Sequence));
        var next = await Command(author, new(1, 2, Guid.NewGuid(), second.Id, second.Revision));
        var updated = await SiteAedsFixture.SaveDraft(server.Client, author.Token, author.Handle, first.Id, first.Revision, "Edited title", body, ct);
        Assert.Equal(receipt, await Command(author, original));
        var changed = await Page(author);
        Assert.Equal((3L, next.OpenedAtUnixMs, first.Revision, updated.Title),
            (changed.Revision, changed.Rows[0].OpenedAtUnixMs, changed.Rows[1].ArticleRevision, changed.Rows[1].Title));
        Assert.Equal(new[] { second.Id, first.Id }, changed.Rows.Select(item => item.ArticleId));
        Assert.Empty((await Page(other)).Rows);
        await Check(HttpMethod.Post, WireRoutes.Delete, author.Token, author.Handle,
            Wire.EncodeArticleCommand(new(second.Id, second.Revision, Guid.NewGuid(), "", "")), OK);
        Assert.Equal(first.Id, Assert.Single((await Page(author)).Rows).ArticleId);
        await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, author.Token, author.Handle, Frame(second, 3), NotFound);

        var head = 3L;
        for (var index = 0; index < WireLimits.AuthorRecentOpenPageSize; index++)
        {
            var article = await Save(author, $"Visit {index}");
            head = (await Command(author, new(1, head, Guid.NewGuid(), article.Id, article.Revision))).Revision;
        }
        var page = await Page(author);
        Assert.Equal((head, WireLimits.AuthorRecentOpenPageSize, WireLimits.AuthorRecentOpenCursorChars),
            (page.Revision, page.Rows.Count, page.Next.Length));
        var cursor = $"?cursor={page.Next}";
        Assert.Equal(first.Id, Assert.Single((await Page(author, cursor)).Rows).ArticleId);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + cursor, other.Token, other.Handle, null, BadRequest);
        var tampered = (page.Next[0] == 'A' ? "B" : "A") + page.Next[1..];
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + $"?cursor={tampered}", author.Token, author.Handle, null, BadRequest);
        await Command(author, new(1, head, Guid.NewGuid(), updated.Id, updated.Revision));
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + cursor, author.Token, author.Handle, null, Conflict);
        await db.SignOutAdmin(author.Token, ct);
        await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens, author.Token, author.Handle, null, Unauthorized);

        async Task<HttpStatusCode> Compete(Draft draft, Guid key)
        {
            using var response = await SiteAedsFixture.Send(server.Client, HttpMethod.Post, WireRoutes.AuthorRecentOpens,
                Wire.EncodeAuthorRecentOpenCommand(new(1, 1, key, draft.Id, draft.Revision)), author.Token, author.Handle, ct);
            return response.StatusCode;
        }

        Task<Draft> Save((Guid Id, string Token, string Handle) user, string title) =>
            SiteAedsFixture.SaveDraft(server.Client, user.Token, user.Handle, 0, 0, title, body, ct);

        async Task<AuthorRecentOpenReceipt> Command((Guid Id, string Token, string Handle) user, AuthorRecentOpenCommand command) =>
            Wire.DecodeAuthorRecentOpenReceipt(await Check(HttpMethod.Post, WireRoutes.AuthorRecentOpens, user.Token, user.Handle,
                Wire.EncodeAuthorRecentOpenCommand(command), OK));

        async Task<(long Revision, string Next, IReadOnlyList<AuthorRecentOpenRow> Rows)> Page((Guid Id, string Token, string Handle) user, string query = "")
        {
            var bytes = await Check(HttpMethod.Get, WireRoutes.AuthorRecentOpens + query, user.Token, user.Handle, null, OK);
            Assert.DoesNotContain(body, Encoding.UTF8.GetString(bytes));
            using var reader = InboxFixture.Reader(bytes, FrameType.AuthorRecentOpenPage);
            Assert.Equal(1, reader.ReadInt32());
            var (revision, next) = (reader.ReadInt64(), InboxFixture.Text(reader));
            var rows = new AuthorRecentOpenRow[reader.ReadInt32()];
            for (var index = 0; index < rows.Length; index++)
                rows[index] = new(reader.ReadInt32(), reader.ReadInt64(), reader.ReadInt64(), reader.ReadInt64(), InboxFixture.Text(reader));
            Assert.Equal(reader.BaseStream.Length, reader.BaseStream.Position);
            return (revision, next, rows);
        }

        Task<byte[]> Check(HttpMethod method, string path, string token, string handle, byte[]? frame, HttpStatusCode status) =>
            SiteAedsFixture.ExpectPrivate(server.Client, method, path, frame, token, handle, status, ct);
    }

    private static byte[] Frame(Draft value, long revision) =>
        Wire.EncodeAuthorRecentOpenCommand(new(1, revision, Guid.NewGuid(), value.Id, value.Revision));
}
